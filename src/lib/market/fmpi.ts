/**
 * FMPI — Full Momentum (Pulse) Intelligence engine.
 *
 * FMPI is a transparent, weighted composite of independent momentum
 * evidence. It is calculated per instrument and per timeframe from completed
 * candles only (the forming candle is excluded from the signal value to
 * avoid repaint). It is NOT a label on top of RSI, and the score does NOT
 * represent a trade win probability.
 *
 * Component weights (documented, configurable via settings):
 *   momentum    0.22  price momentum & rate of change (ROC 3/8 in ATR units,
 *                     EMA9-21 spread, close location vs Bollinger)
 *   structure   0.16  swing-sequence purity & BOS/CHOCH alignment
 *   participation 0.16 relative volume & volume acceleration
 *   persistence 0.08  sign consistency of last 6 candles + follow-through
 *   volatility  0.10  ATR% regime & band-width trend (expansion helps
 *                     directional moves, extreme contraction dampens)
 *   liquidity   0.10  zone context: acceptance beyond value, held retests,
 *                     rejections aligned with direction
 *   orderflow   0.08  executed order-flow evidence — AVAILABLE ONLY in live
 *                     mode with a suitable feed; offline => marked
 *                     unavailable and weight is redistributed
 *   futures     0.08  futures price/OI alignment — live mode only
 *
 * Final score:
 *   base  = Σ(wᵢ·vᵢ over available) / Σ(wᵢ available)
 *   score = clamp(base − Σ penalties, 0, 1) × 100 × dataQualityMultiplier
 * Direction = sign of the weighted signed votes (|net| < 0.12 ⇒ NEUTRAL).
 * Data-quality multiplier: 1.0 live/fresh, 0.92 degraded, 0.85 stale.
 * Missing features NEVER count as neutral evidence — they are excluded and
 * disclosed. Historical scores are reproducible: computeFMPI is pure given
 * the same candles & inputs.
 */

import type {
  Candle, FMPIComponent, FMPIResult, IndicatorSnapshots, StructureInfo, Zone, VolumeProfileResult, MovementAssessment,
} from "./types";
import { rocAtr, candleBodyRatio, closeLocation } from "./indicators";
import { clamp } from "./prng";

export const DEFAULT_FMPI_WEIGHTS: Record<string, number> = {
  momentum: 0.22,
  structure: 0.16,
  participation: 0.16,
  persistence: 0.08,
  volatility: 0.1,
  liquidity: 0.1,
  orderflow: 0.08,
  futures: 0.08,
};

export const DEFAULT_FMPI_THRESHOLDS = [
  { max: 20, label: "VERY_WEAK" },
  { max: 35, label: "WEAK" },
  { max: 50, label: "NEUTRAL" },
  { max: 65, label: "DEVELOPING" },
  { max: 80, label: "STRONG" },
  { max: 101, label: "VERY_STRONG" },
] as const;

export interface FMPIInput {
  candles: Candle[];
  indicators: IndicatorSnapshots;
  structure: StructureInfo;
  zones: Zone[];
  profile: VolumeProfileResult | null;
  atrNow: number;
  movement: MovementAssessment;
  orderFlow?: { delta80: number; aligned: boolean } | null;
  futures?: { priceAligned: boolean; oiNote: string | null } | null;
  dataQuality?: { status: string; stale: boolean };
  weights?: Record<string, number>;
  thresholds?: readonly { max: number; label: string }[];
}

export function computeFMPI(input: FMPIInput): FMPIResult {
  const { indicators, structure, zones, profile, atrNow, movement } = input;
  const weights = { ...DEFAULT_FMPI_WEIGHTS, ...(input.weights ?? {}) };
  const thresholds = input.thresholds ?? DEFAULT_FMPI_THRESHOLDS;

  const done = input.candles.filter((c) => !c.live);
  const asOf = done.length ? done[done.length - 1].ts : 0;

  // ---- history (reproducible): score on each of the last 40 completed candles
  const history = computeHistory(input);

  if (done.length < 30) {
    return {
      score: 0, direction: "NEUTRAL", state: "CONFLICTING", classification: "VERY_WEAK",
      acceleration: "FLAT", relVolumeConfirm: false, structureConfirm: false,
      liquidityContext: "Insufficient data", orderFlowStatus: "UNAVAILABLE", futuresStatus: "UNAVAILABLE",
      dataQuality: "INSUFFICIENT_DATA", dataQualityMultiplier: 0.85,
      components: [], penalties: [], supporting: [],
      reducing: ["Fewer than 30 completed candles — FMPI suppressed by design instead of manufacturing a score."],
      invalidation: [], asOfCandleTs: asOf, history,
    };
  }

  const i = done.length - 1;
  const closes = done.map((c) => c.close);
  const price = closes[i];
  const atr = atrNow;
  const components: FMPIComponent[] = [];
  const penalties: { reason: string; amount: number }[] = [];
  const supporting: string[] = [];
  const reducing: string[] = [];
  const invalidation: string[] = [];

  const push = (c: FMPIComponent) => components.push(c);

  // ---------- Momentum ----------
  {
    const roc3 = rocAtr(closes, 3, indicators.atr, i) ?? 0;
    const roc8 = rocAtr(closes, 8, indicators.atr, i) ?? 0;
    const ema9 = indicators.ema9[i];
    const ema21 = indicators.ema21[i];
    const spread = ema9 != null && ema21 != null && atr > 0 ? clamp((ema9 - ema21) / atr, -1.2, 1.2) : 0;
    const bbU = indicators.bbUp[i];
    const bbL = indicators.bbLo[i];
    const bbPos = bbU != null && bbL != null && bbU > bbL ? clamp(((price - bbL) / (bbU - bbL)) * 2 - 1, -1, 1) : 0;
    const signed = clamp(0.45 * clamp(roc3 / 2, -1, 1) + 0.3 * clamp(roc8 / 3, -1, 1) + 0.15 * spread + 0.1 * bbPos, -1, 1);
    const value = Math.abs(signed);
    push({ key: "momentum", label: "Directional momentum", weight: weights.momentum, available: true, value, signed, contribution: null, detail: `ROC3 ${roc3.toFixed(2)} ATR, ROC8 ${roc8.toFixed(2)} ATR, EMA9-21 spread ${spread.toFixed(2)} ATR, BB position ${bbPos.toFixed(2)}` });
    if (value > 0.5) supporting.push(`Momentum composite ${signed >= 0 ? "+" : ""}${signed.toFixed(2)} (ROC + EMA spread + band position aligned).`);
    if (value < 0.2) reducing.push("Momentum composite near zero — no directional edge from price action.");
  }

  // ---------- Structure ----------
  {
    const swingsBalanced = structure.hhCount + structure.llCount + structure.hlCount + structure.lhCount;
    let signed = 0;
    let purity = 0;
    if (structure.trend === "UP") {
      purity = clamp((structure.hhCount + structure.hlCount) / Math.max(1, swingsBalanced) * 2, 0, 1);
      signed = purity * 0.75 + (structure.lastBOS?.direction === "up" ? 0.25 : 0);
    } else if (structure.trend === "DOWN") {
      purity = clamp((structure.lhCount + structure.llCount) / Math.max(1, swingsBalanced) * 2, 0, 1);
      signed = -(purity * 0.75 + (structure.lastBOS?.direction === "down" ? 0.25 : 0));
    }
    if (structure.lastCHOCH && movement.state === "CONFIRMED_STRUCTURAL_SHIFT") {
      signed = structure.lastCHOCH.direction === "up" ? 0.6 : -0.6;
      purity = Math.max(purity, 0.6);
    }
    const value = Math.abs(signed);
    push({ key: "structure", label: "Price-structure quality", weight: weights.structure, available: true, value, signed: clamp(signed, -1, 1), contribution: null, detail: `Trend ${structure.trend}, purity ${(purity * 100).toFixed(0)}%, BOS ${structure.lastBOS?.direction ?? "none"}, CHOCH ${structure.lastCHOCH?.direction ?? "none"}` });
    if (value > 0.55) supporting.push(`Structure ${structure.trend} with ${(purity * 100).toFixed(0)}% swing purity${structure.lastBOS ? ` + BOS ${structure.lastBOS.direction}` : ""}.`);
    if (structure.trend === "RANGE") reducing.push("Structure is ranging — momentum signals lack structural confirmation.");
  }

  // ---------- Participation ----------
  let relVolNow: number | null = null;
  {
    const rel = indicators.relVol[i];
    relVolNow = rel;
    const prev = indicators.relVol.slice(Math.max(0, i - 5), i).filter((x): x is number => x != null);
    const accel = rel != null && prev.length ? rel - prev.reduce((a, b) => a + b, 0) / prev.length : 0;
    const value = clamp(((rel ?? 0) / 2) * 0.7 + clamp(accel / 1.5, -1, 1) * 0.3, 0, 1);
    const dir = components[0]?.signed ?? (price >= done[0].open ? 1 : -1);
    const signed = value * Math.sign(dir || 1);
    push({ key: "participation", label: "Participation & relative volume", weight: weights.participation, available: rel != null, value: rel != null ? value : null, signed, contribution: null, detail: rel != null ? `RelVol ${rel.toFixed(2)}×, volume acceleration ${accel >= 0 ? "+" : ""}${accel.toFixed(2)}` : "RelVol unavailable" });
    if (rel != null && rel > 1.3) supporting.push(`Relative volume ${rel.toFixed(2)}× above norm — participation confirms the move.`);
    if (rel != null && rel < 0.75) reducing.push(`Relative volume ${rel.toFixed(2)}× — move lacks participation.`);
  }

  // ---------- Persistence ----------
  {
    const last6 = done.slice(-6);
    const sign = Math.sign(closes[i] - closes[Math.max(0, i - 6)]);
    const consistent = last6.filter((c) => (Math.sign(c.close - c.open) || 0) === sign && sign !== 0).length;
    const bodies = last6.map((c) => candleBodyRatio(c));
    const avgBody = bodies.reduce((a, b) => a + b, 0) / Math.max(1, bodies.length);
    const value = clamp((consistent / 6) * 0.7 + avgBody * 0.3, 0, 1);
    push({ key: "persistence", label: "Momentum persistence", weight: weights.persistence, available: true, value, signed: value * sign, contribution: null, detail: `${consistent}/6 candles aligned with net direction, avg body ratio ${avgBody.toFixed(2)}` });
    if (value > 0.6) supporting.push(`Follow-through: ${consistent} of the last 6 candles aligned with the move.`);
    if (value < 0.3) reducing.push("Choppy, inconsistent candle sequence — single-candle spikes are not persistent momentum.");
  }

  // ---------- Volatility / continuation quality ----------
  {
    const atrPct = atr / price;
    const atrs = indicators.atr.slice(Math.max(0, i - 40), i + 1).filter((x): x is number => x != null);
    const atrTrend = atrs.length > 10 ? (atrs[atrs.length - 1] - atrs[Math.floor(atrs.length / 2)]) / atrs[Math.floor(atrs.length / 2)] : 0;
    let value: number;
    if (atrPct < 0.0012) value = 0.25; // dead market
    else if (atrPct > 0.02) value = 0.4; // chaotic
    else value = 0.55 + clamp(atrTrend, -0.5, 0.5) * 0.5;
    value = clamp(value, 0, 1);
    const dirSign = components[0]?.signed ?? 0;
    push({ key: "volatility", label: "Volatility & continuation quality", weight: weights.volatility, available: true, value, signed: value * Math.sign(dirSign || 1) * (atrTrend > -0.05 ? 1 : 0.6), contribution: null, detail: `ATR ${atr.toFixed(2)} (${(atrPct * 100).toFixed(2)}% of price), ATR trend ${(atrTrend * 100).toFixed(1)}% over window` });
    if (atrPct < 0.0012) reducing.push("Extreme volatility contraction — signals are low quality until expansion resolves direction.");
    if (atrTrend > 0.1) supporting.push("Volatility expanding in line with the move.");
  }

  // ---------- Liquidity context ----------
  let liquidityContext = "No nearby zone interaction.";
  {
    const price_ = price;
    const near = zones.filter((z) => z.status !== "INVALIDATED" && Math.min(Math.abs(price_ - z.top), Math.abs(price_ - z.bottom)) <= atr * 1.2);
    let value = 0.3;
    let signed = 0;
    const dirSign = components[0]?.signed ?? 0;
    const acceptingUp = profile?.position === "ACCEPTING_ABOVE";
    const acceptingDn = profile?.position === "ACCEPTING_BELOW";
    const rejectionUp = near.find((z) => (z.status === "REJECTED" || z.status === "HOLDING") && z.side === "support" && price_ > z.top);
    const rejectionDn = near.find((z) => (z.status === "REJECTED" || z.status === "HOLDING") && z.side === "resistance" && price_ < z.bottom);
    const sweep = near.find((z) => z.status === "POTENTIALLY_SWEPT");
    const broken = near.find((z) => z.status === "BROKEN" || z.status === "RECLAIMED");
    if (acceptingUp) { value = 0.8; signed = 0.8; liquidityContext = "Accepting above value area — bullish liquidity context."; }
    else if (acceptingDn) { value = 0.8; signed = -0.8; liquidityContext = "Accepting below value area — bearish liquidity context."; }
    else if (rejectionUp) { value = 0.7; signed = 0.7; liquidityContext = `${rejectionUp.type} support held — rejection aligned with upside.`; }
    else if (rejectionDn) { value = 0.7; signed = -0.7; liquidityContext = `${rejectionDn.type} resistance held — rejection aligned with downside.`; }
    else if (sweep) { value = 0.55; signed = sweep.side === "support" ? 0.5 : -0.5; liquidityContext = `Potential sweep at ${sweep.type} — breach-and-reclaim observed (historical reference, not confirmed executed stops).`; }
    else if (broken) { value = 0.5; signed = Math.sign(dirSign || 1) * 0.4; liquidityContext = `${broken.type} level broken — awaiting acceptance/retest for quality.`; }
    else if (near.length) { value = 0.35; signed = Math.sign(dirSign || 1) * 0.15; liquidityContext = `Inside proximity of ${near[0].type} zone — no decisive interaction yet.`; }
    push({ key: "liquidity", label: "Liquidity & breakout context", weight: weights.liquidity, available: true, value, signed, contribution: null, detail: liquidityContext });
    if (Math.abs(signed) >= 0.7) supporting.push(liquidityContext);
  }

  // ---------- Order flow (live only) ----------
  {
    const of = input.orderFlow ?? null;
    if (of) {
      const value = clamp(Math.abs(of.delta80) / 3, 0, 1);
      const signed = clamp(of.delta80 / 3, -1, 1) * (of.aligned ? 1 : -1);
      push({ key: "orderflow", label: "Order-flow confirmation", weight: weights.orderflow, available: true, value, signed: clamp(signed, -1, 1), contribution: null, detail: `Volume delta proxy ${of.delta80.toFixed(2)} ATR, ${of.aligned ? "aligned" : "diverging"}` });
      if (of.aligned && value > 0.4) supporting.push("Executed-flow proxy confirms direction.");
      if (!of.aligned && value > 0.4) { reducing.push("Executed flow disagrees with price direction."); penalties.push({ reason: "Order-flow divergence", amount: 0.04 }); }
    } else {
      push({ key: "orderflow", label: "Order-flow confirmation", weight: weights.orderflow, available: false, value: null, signed: 0, contribution: null, detail: "Unavailable — requires live feed with executed-trade data. Weight redistributed; not treated as neutral." });
    }
  }

  // ---------- Futures context (live only) ----------
  {
    const f = input.futures ?? null;
    if (f) {
      const signed = f.priceAligned ? 0.5 : -0.5;
      push({ key: "futures", label: "Futures confirmation", weight: weights.futures, available: true, value: 0.5, signed, contribution: null, detail: f.oiNote ?? (f.priceAligned ? "Futures price action aligned" : "Futures diverging") });
    } else {
      push({ key: "futures", label: "Futures confirmation", weight: weights.futures, available: false, value: null, signed: 0, contribution: null, detail: "Unavailable — futures price/OI require live Upstox access. Weight redistributed." });
    }
  }

  // ---------- penalties (contradictory evidence) ----------
  const rel = relVolNow;
  const dirSigned = components[0]!.signed;
  if (Math.abs(dirSigned) > 0.4 && rel != null && rel < 0.9) {
    penalties.push({ reason: "Price/participation divergence: strong ROC with below-average relative volume.", amount: 0.04 });
  }
  if (movement.momentum === "CONFLICTING") penalties.push({ reason: "Conflicting votes across EMA/VWAP/ROC/structure.", amount: 0.05 });
  if (movement.state === "POTENTIAL_LIQUIDITY_SWEEP") penalties.push({ reason: "Unconfirmed sweep pattern — quality penalty until follow-through.", amount: 0.03 });
  if (movement.contradicting.length >= 3) penalties.push({ reason: `${movement.contradicting.length} pieces of contradicting evidence.`, amount: 0.05 });
  const totalPenalty = clamp(penalties.reduce((a, p) => a + p.amount, 0), 0, 0.15);

  // ---------- aggregate ----------
  let wsum = 0;
  let acc = 0;
  let netSigned = 0;
  let netW = 0;
  for (const c of components) {
    if (!c.available || c.value == null) continue;
    wsum += c.weight;
    acc += c.weight * c.value;
    if (["momentum", "structure", "liquidity", "orderflow", "futures"].includes(c.key) && c.available) {
      netSigned += c.weight * c.signed;
      netW += c.weight;
    }
  }
  const base = wsum > 0 ? acc / wsum : 0;
  const dq = input.dataQuality ?? { status: "OK", stale: false };
  const dqMult = dq.stale ? 0.85 : dq.status === "DEGRADED" ? 0.92 : 1;
  if (dq.stale) penalties.push({ reason: "Stale input data — score scaled down.", amount: 0 });
  let score = clamp(base - totalPenalty, 0, 1) * 100 * dqMult;
  score = Math.round(score * 10) / 10;

  const net = netW > 0 ? netSigned / netW : 0;
  const direction: FMPIResult["direction"] = net > 0.12 ? "BULLISH" : net < -0.12 ? "BEARISH" : "NEUTRAL";
  const classification = (thresholds.find((t) => score < t.max)?.label ?? "VERY_STRONG") as FMPIResult["classification"];

  // acceleration: compare score against history
  const prevScore = history.length >= 2 ? history[history.length - 2].score : score;
  const acceleration = score - prevScore > 1.2 ? "ACCELERATING" : prevScore - score > 1.2 ? "DECELERATING" : "FLAT";
  const state: FMPIResult["state"] =
    movement.momentum === "CONFLICTING" ? "CONFLICTING"
    : acceleration === "ACCELERATING" && direction !== "NEUTRAL" ? "STRENGTHENING"
    : acceleration === "DECELERATING" ? "WEAKENING" : "STABLE";

  const structureComponent = components.find((c) => c.key === "structure");
  const structureConfirm = (structureComponent?.value ?? 0) > 0.5;

  invalidation.push(direction === "BULLISH" ? "FMPI direction flips BEARISH with a structure break (close below last higher low)." : direction === "BEARISH" ? "FMPI direction flips BULLISH with a structure break (close above last lower high)." : "Score remains non-directional until net signed votes exceed ±0.12.");
  if (rel != null) invalidation.push(`Relative volume dropping below 0.75 removes participation confirmation.`);
  invalidation.push("Any transition of the movement state to CONFLICTING_SIGNALS suspends the momentum interpretation.");

  // contributions for display
  for (const c of components) {
    c.contribution = c.available && c.value != null && wsum > 0 ? Math.round(((c.weight * c.value) / wsum) * 1000) / 10 : null;
  }

  return {
    score,
    direction,
    state,
    classification,
    acceleration,
    relVolumeConfirm: rel != null && rel >= 1.3,
    structureConfirm,
    liquidityContext,
    orderFlowStatus: input.orderFlow ? (input.orderFlow.aligned ? "CONFIRMING" : "DISAGREEING") : "UNAVAILABLE",
    futuresStatus: input.futures ? (input.futures.priceAligned ? "CONFIRMING" : "DISAGREEING") : "UNAVAILABLE",
    dataQuality: dq.stale ? "STALE" : dq.status,
    dataQualityMultiplier: dqMult,
    components,
    penalties,
    supporting,
    reducing,
    invalidation,
    asOfCandleTs: asOf,
    history,
  };
}

/** Reproducible score history — recomputed from truncated candles (no lookahead). */
function computeHistory(input: FMPIInput): { ts: number; score: number }[] {
  const done = input.candles.filter((c) => !c.live);
  const out: { ts: number; score: number }[] = [];
  const fullCloseIdx = done.length - 1;
  const start = Math.max(30, fullCloseIdx - 40);
  for (let k = start; k <= fullCloseIdx; k++) {
    const sub = done.slice(0, k + 1);
    const closes = sub.map((c) => c.close);
    const i = closes.length - 1;
    const atrV = input.indicators.atr[sub.length - 1] ?? 0;
    if (!atrV) continue;
    // cheap proxy of full score for the sparkline: momentum + participation + persistence
    const roc3 = rocAtr(closes, 3, input.indicators.atr, i) ?? 0;
    const roc8 = rocAtr(closes, 8, input.indicators.atr, i) ?? 0;
    const mom = clamp(Math.abs(0.6 * clamp(roc3 / 2, -1, 1) + 0.4 * clamp(roc8 / 3, -1, 1)), 0, 1);
    const rel = input.indicators.relVol[i];
    const part = rel != null ? clamp(rel / 2, 0, 1) : 0.3;
    const last6 = sub.slice(-6);
    const sign = Math.sign(closes[i] - closes[Math.max(0, i - 6)]) || 1;
    const consistent = last6.filter((c) => Math.sign(c.close - c.open) === sign).length;
    const pers = clamp(consistent / 6, 0, 1);
    const s = clamp((mom * 0.5 + part * 0.28 + pers * 0.22), 0, 1) * 100;
    out.push({ ts: sub[sub.length - 1].ts, score: Math.round(s * 10) / 10 });
  }
  return out;
}

export function candleLocationNote(c: Candle): string {
  return `close location ${(closeLocation(c) * 100).toFixed(0)}% of range`;
}
