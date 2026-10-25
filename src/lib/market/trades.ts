/**
 * Trade Finder — evidence-based trade SCENARIOS, not buy/sell commands.
 *
 * Rules (documented):
 *  - A scenario requires a justified movement state (see movement.ts),
 *    FMPI ≥ configurable minimum, a structure-based invalidation level, and
 *    reward:risk ≥ configured minimum against opposing zones.
 *  - Stop loss: beyond the relevant structure (swing / zone boundary) plus a
 *    0.35×ATR buffer — never a fixed point distance.
 *  - Targets: T1 = nearest opposing active zone (if RR ≥ minRR) else 1.5R;
 *    T2 = next opposing zone or 2.5R.
 *  - Mandatory NO_TRADE conditions (spec Part 24): stale/missing data,
 *    conflicting structure-vs-momentum, unconfirmed setup, RR below minimum,
 *    unclear invalidation, excessive spread/volatility, uncertain mapping,
 *    closed market without explicit historical framing.
 */

import type {
  TradeScenario, Zone, StructureInfo, FMPIResult, MovementAssessment, Candle, DataQuality,
} from "./types";
import { clamp } from "./prng";

export interface RiskConfig {
  minRR: number;
  minFMPI: number;
  maxActiveScenarios: number;
  riskPerTradePct: number;
  dailyLossLimitPct: number;
  atrStopBuffer: number;
  cooldownAfterLosses: number;
}

export const DEFAULT_RISK: RiskConfig = {
  minRR: 1.5,
  minFMPI: 55,
  maxActiveScenarios: 4,
  riskPerTradePct: 0.5,
  dailyLossLimitPct: 2,
  atrStopBuffer: 0.35,
  cooldownAfterLosses: 3,
};

export interface ScenarioInput {
  symbol: string;
  tf: string;
  candles: Candle[];
  atr: number;
  zones: Zone[];
  structure: StructureInfo;
  fmpi: FMPIResult;
  movement: MovementAssessment;
  quality: DataQuality;
  risk?: Partial<RiskConfig>;
  spreadBps?: number | null;
}

export function generateScenario(input: ScenarioInput): TradeScenario {
  const risk = { ...DEFAULT_RISK, ...(input.risk ?? {}) };
  const { candles, atr, zones, structure, fmpi, movement } = input;
  const done = candles.filter((c) => !c.live);
  const ts = done.length ? done[done.length - 1].ts : Date.now();
  const price = done.length ? done[done.length - 1].close : 0;

  const base: TradeScenario = {
    status: "NO_TRADE",
    direction: null,
    setup: "NONE",
    symbol: input.symbol,
    tf: input.tf,
    ts,
    price,
    level: null,
    entryZone: null,
    entryTrigger: "—",
    stop: null,
    stopReason: "—",
    t1: null,
    t2: null,
    rr: null,
    fmpi: done.length >= 30 ? fmpi.score : null,
    supporting: [],
    contradicting: [],
    noTradeReasons: [],
    cancelIf: [],
    lifecycle: [{ state: "CANDIDATE_EVALUATED", ts, note: "Rules evaluated on completed candles." }],
  };

  const nt = base.noTradeReasons;

  // ---- mandatory no-trade gates (Part 24) --------------------------------
  if (input.quality.status === "STALE" || input.quality.status === "UNAVAILABLE") nt.push(`Required data is ${input.quality.status.toLowerCase()} — no scenario permitted.`);
  if (input.quality.marketSession === "CLOSED") nt.push("Market is closed and this signal is not explicitly historical.");
  if (done.length < 30) nt.push("Insufficient completed candles (<30) for the selected timeframe.");
  if (movement.state === "CONFLICTING_SIGNALS") nt.push("Price structure and momentum materially conflict.");
  if (!movement.tradeJustified) nt.push(`Setup lacks confirmation: ${movement.waitReason ?? "movement state does not justify a trade."}`);
  if (fmpi.score < risk.minFMPI) nt.push(`FMPI ${fmpi.score.toFixed(1)} below configured minimum ${risk.minFMPI}.`);
  if (fmpi.direction === "NEUTRAL") nt.push("FMPI is non-directional.");
  if (movement.bias !== "NEUTRAL" && fmpi.direction !== "NEUTRAL" && movement.bias[0] !== fmpi.direction[0]) nt.push("Movement bias and FMPI direction disagree.");
  if (input.spreadBps != null && input.spreadBps > 12) nt.push(`Quoted spread ${input.spreadBps.toFixed(1)} bps exceeds the 12 bps suitability limit.`);
  if (price <= 0 || atr <= 0) nt.push("Price/ATR unavailable — volatility-aware levels cannot be constructed.");

  if (nt.length) {
    base.noTradeReasons = nt;
    base.supporting = movement.supporting.slice(0, 3);
    base.contradicting = movement.contradicting.slice(0, 3);
    base.lifecycle.push({ state: "NO_TRADE", ts, note: "Mandatory capital-protection gate failed." });
    return base;
  }

  // ---- pattern selection --------------------------------------------------
  const dir: "LONG" | "SHORT" = fmpi.direction === "BULLISH" ? "LONG" : "SHORT";
  const supports = zones.filter((z) => z.side === "support" && z.status !== "INVALIDATED" && z.mid < price).sort((a, b) => b.mid - a.mid);
  const resistances = zones.filter((z) => z.side === "resistance" && z.status !== "INVALIDATED" && z.mid > price).sort((a, b) => a.mid - b.mid);
  const brokenUp = zones.find((z) => (z.status === "BROKEN" || z.status === "RECLAIMED") && z.side === "resistance" && price > z.top);
  const brokenDn = zones.find((z) => (z.status === "BROKEN" || z.status === "RECLAIMED") && z.side === "support" && price < z.bottom);
  const lastSwingLow = [...structure.swings].reverse().find((s) => s.kind === "low");
  const lastSwingHigh = [...structure.swings].reverse().find((s) => s.kind === "high");

  let setup = "TREND_CONTINUATION";
  let level: number | null = null;
  let entry: [number, number] | null = null;
  let stop: number | null = null;
  let stopReason = "";
  let entryTrigger = "";

  if (dir === "LONG") {
    if (movement.state === "CONFIRMED_UPSIDE_BREAKOUT" && brokenUp) {
      setup = "BULLISH_BREAKOUT";
      level = brokenUp.top;
      entry = [price, Math.min(price + atr * 0.4, brokenUp.top + atr * 0.9)];
      stop = Math.min(brokenUp.bottom, lastSwingLow?.price ?? brokenUp.bottom) - atr * risk.atrStopBuffer;
      stopReason = `Below broken ${brokenUp.type} zone (${brokenUp.bottom.toFixed(2)}) and higher-low structure, −${risk.atrStopBuffer}×ATR buffer.`;
      entryTrigger = `Continuation: buy above ${(price + atr * 0.15).toFixed(2)} (signal-candle momentum) or on a successful retest of ${brokenUp.top.toFixed(2)} holding as support.`;
      base.supporting.push(`Confirmed close beyond ${brokenUp.type} (${brokenUp.bottom.toFixed(2)}–${brokenUp.top.toFixed(2)}).`);
    } else if (structure.trend === "UP" && lastSwingLow) {
      setup = movement.momentum === "STRENGTHENING" ? "TREND_CONTINUATION" : "PULLBACK_CONTINUATION";
      level = lastSwingLow.price;
      const emaRef = input.candles.length ? null : null;
      void emaRef;
      entry = [price, price + atr * 0.35];
      stop = lastSwingLow.price - atr * risk.atrStopBuffer;
      stopReason = `Below last confirmed higher low at ${lastSwingLow.price.toFixed(2)} −${risk.atrStopBuffer}×ATR.`;
      entryTrigger = `Strength entry above ${(price + atr * 0.15).toFixed(2)}; conservative entry on a pullback that holds above ${(lastSwingLow.price + atr * 0.3).toFixed(2)}.`;
      base.supporting.push(`Uptrend structure intact (HH/HL), last higher low ${lastSwingLow.price.toFixed(2)}.`);
    }
  } else {
    if (movement.state === "CONFIRMED_DOWNSIDE_BREAKDOWN" && brokenDn) {
      setup = "BEARISH_BREAKDOWN";
      level = brokenDn.bottom;
      entry = [Math.max(price - atr * 0.4, brokenDn.bottom - atr * 0.9), price];
      stop = Math.max(brokenDn.top, lastSwingHigh?.price ?? brokenDn.top) + atr * risk.atrStopBuffer;
      stopReason = `Above broken ${brokenDn.type} zone (${brokenDn.top.toFixed(2)}) and lower-high structure, +${risk.atrStopBuffer}×ATR buffer.`;
      entryTrigger = `Continuation: sell below ${(price - atr * 0.15).toFixed(2)} or on a retest of ${brokenDn.bottom.toFixed(2)} holding as resistance.`;
      base.supporting.push(`Confirmed close below ${brokenDn.type} (${brokenDn.bottom.toFixed(2)}–${brokenDn.top.toFixed(2)}).`);
    } else if (structure.trend === "DOWN" && lastSwingHigh) {
      setup = movement.momentum === "STRENGTHENING" ? "TREND_CONTINUATION" : "PULLBACK_CONTINUATION";
      level = lastSwingHigh.price;
      entry = [price - atr * 0.35, price];
      stop = lastSwingHigh.price + atr * risk.atrStopBuffer;
      stopReason = `Above last confirmed lower high at ${lastSwingHigh.price.toFixed(2)} +${risk.atrStopBuffer}×ATR.`;
      entryTrigger = `Weakness entry below ${(price - atr * 0.15).toFixed(2)}; conservative entry on a pullback that fails below ${(lastSwingHigh.price - atr * 0.3).toFixed(2)}.`;
      base.supporting.push(`Downtrend structure intact (LH/LL), last lower high ${lastSwingHigh.price.toFixed(2)}.`);
    }
  }

  if (!entry || stop == null || level == null) {
    nt.push("No objective structure-based entry/invalidation level could be constructed.");
    base.noTradeReasons = nt;
    base.lifecycle.push({ state: "NO_TRADE", ts, note: "No valid pattern mapping." });
    return base;
  }

  // ---- targets & RR --------------------------------------------------------
  const riskPts = dir === "LONG" ? entry[0] - stop : stop - entry[1];
  if (riskPts <= atr * 0.2) {
    nt.push("Proposed stop is tighter than 0.2×ATR — invalidation level is unclear/too close; setup rejected.");
    base.noTradeReasons = nt;
    return base;
  }
  const opposing = dir === "LONG" ? resistances : supports;
  const opposing1 = opposing[0] ?? null;
  const opposing2 = opposing[1] ?? null;
  let t1: number;
  let t2: number;
  if (dir === "LONG") {
    const rrZone = opposing1 ? (opposing1.bottom - entry[0]) / riskPts : 0;
    t1 = opposing1 && rrZone >= risk.minRR * 0.8 ? opposing1.bottom : entry[0] + riskPts * 1.5;
    t2 = opposing2 ? opposing2.bottom : entry[0] + riskPts * 2.5;
  } else {
    const rrZone = opposing1 ? (entry[1] - opposing1.top) / riskPts : 0;
    t1 = opposing1 && rrZone >= risk.minRR * 0.8 ? opposing1.top : entry[1] - riskPts * 1.5;
    t2 = opposing2 ? opposing2.top : entry[1] - riskPts * 2.5;
  }
  const rr = dir === "LONG" ? (t1 - entry[0]) / riskPts : (entry[1] - t1) / riskPts;

  if (rr < risk.minRR) {
    nt.push(`Reward:risk ${rr.toFixed(2)} below configured minimum ${risk.minRR} (opposing zone too close).`);
    base.noTradeReasons = nt;
    base.level = level;
    base.stop = stop;
    base.stopReason = stopReason;
    base.lifecycle.push({ state: "NO_TRADE", ts, note: "RR filter failed." });
    return base;
  }

  base.direction = dir;
  base.setup = setup;
  base.level = level;
  base.entryZone = entry;
  base.stop = stop;
  base.stopReason = stopReason;
  base.t1 = t1;
  base.t2 = t2;
  base.rr = Math.round(rr * 100) / 100;
  base.entryTrigger = entryTrigger;
  base.status = movement.state.startsWith("CONFIRMED") || movement.state.includes("STRENGTHENING") ? "ENTRY_CONDITION_MET" : "WAITING_CONFIRMATION";
  base.supporting.push(`FMPI ${fmpi.score.toFixed(1)} (${fmpi.classification.toLowerCase().replace(/_/g, " ")}) ${fmpi.direction.toLowerCase()}, ${fmpi.state.toLowerCase()}.`);
  base.supporting.push(...movement.supporting.slice(0, 3));
  if (fmpi.relVolumeConfirm) base.supporting.push("Relative-volume confirmation present.");
  base.contradicting.push(...movement.contradicting.slice(0, 3));
  if (fmpi.orderFlowStatus === "UNAVAILABLE") base.contradicting.push("Order-flow confirmation unavailable (feed lacks trade-level aggressor data) — one evidence channel missing.");
  base.cancelIf.push(`Any close ${dir === "LONG" ? "below" : "above"} the stop region (${stop.toFixed(2)}) before entry fills.`);
  base.cancelIf.push(`Movement state transitions to CONFLICTING_SIGNALS or FMPI drops below ${risk.minFMPI}.`);
  base.cancelIf.push("Data feed becomes stale (last tick older than the freshness threshold).");
  base.cancelIf.push(`Setup expires after ${12} candles without the entry trigger firing.`);
  base.lifecycle.push({ state: base.status, ts, note: `${setup} mapped with structure-based risk; awaiting ${base.status === "ENTRY_CONDITION_MET" ? "manual review — execution is disabled (analysis-only platform)" : "confirmation conditions"}.` });

  return base;
}

/** position sizing helper — shows the calculation, uses real lot size. */
export function positionSize(opts: { capital: number; riskPct: number; entry: number; stop: number; lotSize: number }): { lots: number; qty: number; riskAmount: number; note: string } {
  const { capital, riskPct, entry, stop, lotSize } = opts;
  const riskAmount = capital * (riskPct / 100);
  const perShare = Math.abs(entry - stop);
  if (perShare <= 0) return { lots: 0, qty: 0, riskAmount, note: "Invalid entry/stop." };
  const perLotRisk = perShare * lotSize;
  const lots = Math.max(0, Math.floor(riskAmount / perLotRisk));
  return {
    lots,
    qty: lots * lotSize,
    riskAmount: Math.round(lots * perLotRisk),
    note: `risk ${riskPct}% of ₹${capital.toLocaleString("en-IN")} = ₹${Math.round(riskAmount).toLocaleString("en-IN")} → floor(risk / (|entry−stop| × lot ${lotSize})) = ${lots} lot(s). Fees/slippage not included; execution disabled.`,
  };
}
