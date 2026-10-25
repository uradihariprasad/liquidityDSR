/**
 * Market Movement Intelligence — classifies current price behaviour into a
 * documented state and builds the explanation panel content. The classifier
 * is deliberately transparent: every conclusion lists its supporting and
 * contradicting evidence plus explicit confirmation/invalidation conditions.
 *
 * Inputs: candles (single session, no lookahead), indicator snapshots,
 * structure (swings/BOS/CHOCH), liquidity zones, volume profile, day context.
 * Order flow / depth inputs are optional; when unavailable they are excluded
 * and noted, never silently assumed neutral.
 */

import type {
  Candle, MovementAssessment, MovementState, StructureInfo, Zone,
  VolumeProfileResult, IndicatorSnapshots,
} from "./types";
import { lastNonNull, candleBodyRatio, closeLocation, rocAtr } from "./indicators";
import { mean } from "./prng";
import type { SweepEvent } from "./sweeps";
import { activeSweep } from "./sweeps";

export interface MovementInput {
  candles: Candle[];
  tfMinutes: number;
  indicators: IndicatorSnapshots;
  structure: StructureInfo;
  zones: Zone[];
  profile: VolumeProfileResult | null;
  atrNow: number;
  /** validated events from the dedicated sweep engine */
  sweeps?: SweepEvent[];
}

export function classifyMovement(input: MovementInput): MovementAssessment {
  const { candles, indicators, structure, zones, profile, atrNow } = input;
  const supporting: string[] = [];
  const contradicting: string[] = [];
  const confirmNext: string[] = [];
  const invalidateBias: string[] = [];

  const done = candles.filter((c) => !c.live);
  const n = done.length;
  if (n < 30) {
    return {
      state: "INSUFFICIENT_DATA",
      bias: "NEUTRAL",
      momentum: "CONFLICTING",
      quality: "LOW",
      supporting: [],
      contradicting: [],
      confirmNext: ["Accumulate at least 30 completed candles for the selected timeframe."],
      invalidateBias: [],
      tradeJustified: false,
      waitReason: "Insufficient completed data — indicators and structure are not yet reliable.",
    };
  }

  const last = done[n - 1];
  const i = n - 1;
  const price = last.close;

  // --- feature extraction -------------------------------------------------
  const closes = done.map((c) => c.close);
  const ema9 = indicators.ema9[i];
  const ema21 = indicators.ema21[i];
  const ema50 = indicators.ema50[i];
  const ema200 = done.length > 200 ? indicators.ema200[i] : null;
  const rsi = indicators.rsi[i];
  const vwap = indicators.vwap[i];
  const atr = atrNow;
  const relVol = indicators.relVol[i];
  const bbUp = indicators.bbUp[i];
  const bbLo = indicators.bbLo[i];
  const bbMid = indicators.bbMid[i];

  const roc3 = rocAtr(closes, 3, indicators.atr, i);
  const roc8 = rocAtr(closes, 8, indicators.atr, i);

  // Bollinger width percentile (volatility regime)
  let bbwPct = 0.5;
  if (bbUp != null && bbLo != null && bbMid) {
    const widths: number[] = [];
    for (let j = Math.max(20, i - 120); j <= i; j++) {
      const u = indicators.bbUp[j], l = indicators.bbLo[j], m = indicators.bbMid[j];
      if (u != null && l != null && m) widths.push((u - l) / m);
    }
    const w = (bbUp - bbLo) / bbMid;
    const sorted = [...widths].sort((a, b) => a - b);
    bbwPct = sorted.length ? sorted.filter((x) => x <= w).length / sorted.length : 0.5;
  }

  const emaBull = ema9 != null && ema21 != null && ema50 != null && ema9 > ema21 && ema21 > ema50;
  const emaBear = ema9 != null && ema21 != null && ema50 != null && ema9 < ema21 && ema21 < ema50;
  const aboveVwap = vwap != null && price > vwap;
  const belowVwap = vwap != null && price < vwap;

  const trend = structure.trend;
  const momUp = (roc3 ?? 0) > 0 && (roc8 ?? 0) > 0;
  const momDn = (roc3 ?? 0) < 0 && (roc8 ?? 0) < 0;
  const momAccel = roc3 != null && roc8 != null ? roc3 - roc8 / 2 : 0;

  // recent zone interactions
  const near = zones.filter((z) => z.status !== "INVALIDATED"
    && Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom)) <= atr * 0.9);
  /**
   * A "fresh" break must be RECENT, not merely recorded at some point in the
   * series. Zone status is evaluated across every candle with no recency
   * constraint, so a support zone broken days ago still carries status
   * BROKEN and would otherwise satisfy this predicate forever (the stale
   * breakdown bug). The break must have happened within `BREAK_RECENCY`
   * candles of the current bar.
   */
  const BREAK_RECENCY = 12;
  const currentTs = done[i].ts;
  const recentBreakUp = zones.find(
    (z) =>
      (z.status === "BROKEN" || z.status === "RECLAIMED")
      && z.side === "resistance"
      && price > z.top
      && currentTs - z.updatedTs <= BREAK_RECENCY * input.tfMinutes * 60_000,
  );
  const recentBreakDn = zones.find(
    (z) =>
      (z.status === "BROKEN" || z.status === "RECLAIMED")
      && z.side === "support"
      && price < z.bottom
      && currentTs - z.updatedTs <= BREAK_RECENCY * input.tfMinutes * 60_000,
  );
  // kept for compatibility with existing references below
  const freshBrokenUp = recentBreakUp;
  const freshBrokenDn = recentBreakDn;
  const sweep = activeSweep(input.sweeps ?? []);
  const rejectedRes = zones.find((z) => (z.status === "REJECTED" || z.status === "HOLDING") && z.side === "resistance" && price < z.bottom);
  const rejectedSup = zones.find((z) => (z.status === "REJECTED" || z.status === "HOLDING") && z.side === "support" && price > z.top);

  const strongCloseUp = candleBodyRatio(last) > 0.55 && closeLocation(last) > 0.7;
  const strongCloseDn = candleBodyRatio(last) > 0.55 && closeLocation(last) < 0.3;
  const volHigh = relVol != null && relVol > 1.3;
  const volLow = relVol != null && relVol < 0.75;

  // recent range expansion
  const ranges = done.slice(-20).map((c) => c.high - c.low);
  const rangeExpansion = ranges.length >= 10 ? (last.high - last.low) > mean(ranges.slice(0, -1)) * 1.25 : false;

  // --- state decision (ordered, first decisive match wins) ----------------
  let state: MovementState = "NO_TRADE";
  let bias: MovementAssessment["bias"] = "NEUTRAL";

  /**
   * Both confirmation branches require the SAME documented conditions: a
   * completed-candle close beyond a real level, relative volume >= 1.3 and
   * range expansion. Previously `||` made the BOS branch fire on volume
   * alone, without range expansion and without any zone having broken —
   * that is how an unrelated or stale breakdown state leaked in.
   */
  const bosRecent = (dir: "up" | "down") =>
    !!structure.lastBOS && structure.lastBOS.direction === dir && i - structure.lastBOS.idx <= 6;
  const breakoutUpConfirmed =
    (!!recentBreakUp || bosRecent("up")) && volHigh && rangeExpansion;
  const breakoutDnConfirmed =
    (!!recentBreakDn || bosRecent("down")) && volHigh && rangeExpansion;

  if (n < 30) {
    state = "INSUFFICIENT_DATA";
  } else if (sweep) {
    state = "POTENTIAL_LIQUIDITY_SWEEP";
    bias = sweep.direction;
    supporting.push(sweep.note);
    for (const e of sweep.evidence) supporting.push(e);
    contradicting.push("A sweep pattern is a price-structure inference — it is not proof that stop-loss orders were executed.");
    for (const m of sweep.missing) contradicting.push(m);
    if (sweep.state === "DETECTED") {
      contradicting.push("Sweep is UNCONFIRMED — no follow-through yet, so the reversal implication is provisional.");
      confirmNext.push(
        sweep.side === "LOW"
          ? `Follow-through buying: a close above the sweep candle's high with relative volume ≥ 1.3.`
          : `Follow-through selling: a close below the sweep candle's low with relative volume ≥ 1.3.`,
      );
    } else {
      confirmNext.push("Sweep already confirmed by follow-through; continuation requires structure to keep making progress in the rejection direction.");
    }
    invalidateBias.push(sweep.invalidation);
  } else if (breakoutUpConfirmed || breakoutDnConfirmed) {
    state = breakoutUpConfirmed ? "CONFIRMED_UPSIDE_BREAKOUT" : "CONFIRMED_DOWNSIDE_BREAKDOWN";
    bias = breakoutUpConfirmed ? "BULLISH" : "BEARISH";
    const lvl = breakoutUpConfirmed ? freshBrokenUp : freshBrokenDn;
    if (lvl) supporting.push(`Close beyond ${lvl.type} zone (${lvl.bottom.toFixed(2)}–${lvl.top.toFixed(2)}) with relative volume ${relVol?.toFixed(2)} and range expansion.`);
    if (structure.lastBOS) supporting.push(`Break of structure ${structure.lastBOS.direction} at ${structure.lastBOS.level.toFixed(2)}.`);
    if (volHigh) supporting.push(`Participation confirmation: relative volume ${relVol!.toFixed(2)} ≥ 1.3.`);
    if (structure.lastCHOCH && ((breakoutUpConfirmed && structure.lastCHOCH.direction === "down") || (breakoutDnConfirmed && structure.lastCHOCH.direction === "up"))) {
      contradicting.push("A recent opposite-direction CHOCH conflicts with this breakout — treat as lower quality.");
    }
    confirmNext.push("Continuation: price holds beyond the broken level; retest that holds as flipped S/R strengthens the case.");
    invalidateBias.push(breakoutUpConfirmed ? "A close back inside the broken zone marks the breakout as failed." : "A close back inside the broken zone marks the breakdown as failed.");
  } else if (structure.lastCHOCH && i - structure.lastCHOCH.idx <= 8 && trend !== "RANGE") {
    state = "CONFIRMED_STRUCTURAL_SHIFT";
    bias = structure.lastCHOCH.direction === "up" ? "BULLISH" : "BEARISH";
    supporting.push(`Change of character ${structure.lastCHOCH.direction} at ${structure.lastCHOCH.level.toFixed(2)} followed by ${trend.toLowerCase()} structure (HH/HL or LH/LL sequence intact).`);
    confirmNext.push("Retest of the CHOCH level holding as S/R.");
    invalidateBias.push("Price closing back through the CHOCH level.");
  } else if (trend === "UP" || trend === "DOWN") {
    const up = trend === "UP";
    bias = up ? "BULLISH" : "BEARISH";
    supporting.push(`Structure: ${trend} (HH ${structure.hhCount} / HL ${structure.hlCount} / LH ${structure.lhCount} / LL ${structure.llCount}).`);
    if ((up && emaBull) || (!up && emaBear)) supporting.push("EMA9/21/50 alignment supports the trend direction.");
    else contradicting.push("EMA alignment does not confirm the structure trend — mixed technical picture.");
    if ((up && aboveVwap) || (!up && belowVwap)) supporting.push(`Price is ${up ? "above" : "below"} session VWAP.`);
    else if (vwap != null) contradicting.push("Price is on the wrong side of VWAP for the trend — momentum quality reduced.");
    if (momUp && up) supporting.push("Momentum (ROC 3 & 8 in ATR units) agrees with the uptrend.");
    if (momDn && !up) supporting.push("Momentum (ROC 3 & 8 in ATR units) agrees with the downtrend.");
    if ((up && momDn) || (!up && momUp)) contradicting.push("Short-term momentum disagrees with the structure trend.");
    if (volLow) contradicting.push(`Relative volume ${relVol?.toFixed(2)} is weak — trend participation is fading.`);
    if (rejectedSup && up) supporting.push(`Support zone ${rejectedSup.type} rejected — buyers defended the level.`);
    if (rejectedRes && !up) supporting.push(`Resistance zone ${rejectedRes.type} rejected — sellers defended the level.`);

    if (((up && momUp) || (!up && momDn)) && momAccel > 0) {
      state = up ? "BULLISH_MOMENTUM_STRENGTHENING" : "BEARISH_MOMENTUM_STRENGTHENING";
      supporting.push(`Momentum accelerating (short ROC ${roc3?.toFixed(2)} ATR outweighing medium ROC ${roc8?.toFixed(2)} ATR).`);
    } else if (((up && momDn) || (!up && momUp)) || momAccel < -0.15) {
      state = up ? "BULLISH_MOMENTUM_WEAKENING" : "BEARISH_MOMENTUM_WEAKENING";
    } else {
      state = up ? "BULLISH_CONTINUATION" : "BEARISH_CONTINUATION";
    }
    const nearestRes = zones.find((z) => z.side === "resistance" && z.mid > price && z.status !== "INVALIDATED");
    const nearestSup = zones.find((z) => z.side === "support" && z.mid < price && z.status !== "INVALIDATED");
    if (up && nearestRes) confirmNext.push(`A close above ${nearestRes.type} at ${nearestRes.top.toFixed(2)} with relative volume ≥ 1.3 extends the move.`);
    if (!up && nearestSup) confirmNext.push(`A close below ${nearestSup.type} at ${nearestSup.bottom.toFixed(2)} with relative volume ≥ 1.3 extends the move.`);
    const lastSwingLow = [...structure.swings].reverse().find((s) => s.kind === "low");
    const lastSwingHigh = [...structure.swings].reverse().find((s) => s.kind === "high");
    if (up && lastSwingLow) invalidateBias.push(`A close below the last higher low at ${lastSwingLow.price.toFixed(2)} breaks the bullish structure.`);
    if (!up && lastSwingHigh) invalidateBias.push(`A close above the last lower high at ${lastSwingHigh.price.toFixed(2)} breaks the bearish structure.`);
  } else {
    // RANGE structures
    if (bbwPct <= 0.25) {
      state = "VOLATILITY_CONTRACTION";
      supporting.push(`Bollinger band width is at the ${(bbwPct * 100).toFixed(0)}th percentile of the last ~120 candles — volatility is compressed.`);
      confirmNext.push("Directional resolution: a range-expansion close beyond the consolidation boundary with relative volume ≥ 1.3.");
    } else if (bbwPct >= 0.85 && (volHigh || rangeExpansion)) {
      state = "VOLATILITY_EXPANSION";
      bias = momUp ? "BULLISH" : momDn ? "BEARISH" : "NEUTRAL";
      supporting.push(`Bollinger band width at the ${(bbwPct * 100).toFixed(0)}th percentile with ${volHigh ? "elevated relative volume" : "range expansion"} — volatility is expanding.`);
      invalidateBias.push("Volatility collapse back inside the prior range.");
    } else {
      state = n >= 12 && (Math.max(...done.slice(-12).map((c) => c.high)) - Math.min(...done.slice(-12).map((c) => c.low))) < atr * 2.2 ? "CONSOLIDATION" : "RANGE_BOUND";
      supporting.push("No net structural progress: swing sequence is mixed (no clean HH/HL or LH/LL).");
      const res = zones.filter((z) => z.side === "resistance" && z.status !== "INVALIDATED").sort((a, b) => a.mid - b.mid).find((z) => z.mid > price);
      const sup = zones.filter((z) => z.side === "support" && z.status !== "INVALIDATED").sort((a, b) => b.mid - a.mid).find((z) => z.mid < price);
      if (res && price > res.bottom - atr && !momDn) {
        state = "BREAKOUT_DEVELOPING";
        supporting.push(`Price is pressing against ${res.type} resistance at ${res.bottom.toFixed(2)}–${res.top.toFixed(2)} (within 1 ATR) without rejection.`);
        confirmNext.push(`A close above ${res.top.toFixed(2)} with relative volume ≥ 1.3 and range expansion confirms the breakout.`);
        invalidateBias.push(`Rejection: a close back below ${res.bottom.toFixed(2)} with a failure-following candle.`);
      } else if (sup && price < sup.top + atr && !momUp) {
        state = "BREAKOUT_DEVELOPING";
        bias = "BEARISH";
        supporting.push(`Price is pressing against ${sup.type} support at ${sup.bottom.toFixed(2)}–${sup.top.toFixed(2)} (within 1 ATR) without rejection.`);
        confirmNext.push(`A close below ${sup.bottom.toFixed(2)} with relative volume ≥ 1.3 and range expansion confirms the breakdown.`);
        invalidateBias.push(`Reclaim: a close back above ${sup.top.toFixed(2)}.`);
      } else {
        if (res) confirmNext.push(`Upside resolution requires a close above ${res.top.toFixed(2)} (${res.type}).`);
        if (sup) confirmNext.push(`Downside resolution requires a close below ${sup.bottom.toFixed(2)} (${sup.type}).`);
        invalidateBias.push("Any sustained acceptance outside the range boundaries.");
      }
    }
    if (rsi != null && ((rsi > 62 && momDn) || (rsi < 38 && momUp))) {
      contradicting.push("RSI and short-term momentum conflict inside the range — treat extremes as context, not as standalone reversal signals.");
    }
  }

  // potential reversal overlays
  if (state === "RANGE_BOUND" || state === "CONSOLIDATION") {
    if (rejectedSup && momUp && structure.lastCHOCH?.direction === "up") {
      state = "POTENTIAL_BULLISH_REVERSAL";
      bias = "BULLISH";
      supporting.push(`Rejection at ${rejectedSup.type} support + upward CHOCH at ${structure.lastCHOCH.level.toFixed(2)} + positive short ROC — reversal is developing, not confirmed.`);
      confirmNext.push("A higher low followed by a close above the rejection candle high.");
      invalidateBias.push(`A close below ${rejectedSup.bottom.toFixed(2)}.`);
    } else if (rejectedRes && momDn && structure.lastCHOCH?.direction === "down") {
      state = "POTENTIAL_BEARISH_REVERSAL";
      bias = "BEARISH";
      supporting.push(`Rejection at ${rejectedRes.type} resistance + downward CHOCH at ${structure.lastCHOCH.level.toFixed(2)} + negative short ROC — reversal is developing, not confirmed.`);
      confirmNext.push("A lower high followed by a close below the rejection candle low.");
      invalidateBias.push(`A close above ${rejectedRes.top.toFixed(2)}.`);
    }
  }

  // failed break overlays (checked against recent zone states)
  const failedBo = zones.find((z) => z.status === "RECLAIMED" && z.side === "resistance" && price < z.bottom);
  const failedBd = zones.find((z) => z.status === "RECLAIMED" && z.side === "support" && price > z.top);
  if ((state === "BREAKOUT_DEVELOPING" || state === "RANGE_BOUND") && failedBo) {
    state = "FAILED_BREAKOUT";
    bias = "BEARISH";
    supporting.push(`Price broke ${failedBo.type} (${failedBo.top.toFixed(2)}) and was unable to hold — close back below the zone.`);
    confirmNext.push("Momentum confirmation below the failure candle; target the opposite side of the range.");
    invalidateBias.push(`A close back above ${failedBo.top.toFixed(2)}.`);
  } else if ((state === "BREAKOUT_DEVELOPING" || state === "RANGE_BOUND") && failedBd) {
    state = "FAILED_BREAKDOWN";
    bias = "BULLISH";
    supporting.push(`Price broke ${failedBd.type} (${failedBd.bottom.toFixed(2)}) and reclaimed it — close back above the zone.`);
    confirmNext.push("Momentum confirmation above the reclaim candle; target the opposite side of the range.");
    invalidateBias.push(`A close back below ${failedBd.bottom.toFixed(2)}.`);
  }

  // conflicting-signal detector
  const bullVotes = [emaBull ? 1 : 0, aboveVwap ? 1 : 0, momUp ? 1 : 0, trend === "UP" ? 1 : 0].reduce((a, b) => a + b, 0);
  const bearVotes = [emaBear ? 1 : 0, belowVwap ? 1 : 0, momDn ? 1 : 0, trend === "DOWN" ? 1 : 0].reduce((a, b) => a + b, 0);
  if (state !== "INSUFFICIENT_DATA" && bullVotes >= 2 && bearVotes >= 2 && state !== "POTENTIAL_LIQUIDITY_SWEEP") {
    if (state === "BULLISH_CONTINUATION" || state === "BEARISH_CONTINUATION" || state === "RANGE_BOUND") {
      state = "CONFLICTING_SIGNALS";
      bias = "NEUTRAL";
      contradicting.push(`Split evidence: ${bullVotes} bullish votes vs ${bearVotes} bearish votes across EMA alignment, VWAP, ROC momentum and structure.`);
      confirmNext.push("A decisive range-expansion close with volume to resolve the conflict.");
      invalidateBias.push("— wait for resolution; no bias to invalidate.");
    }
  }

  // momentum status
  let momentum: MovementAssessment["momentum"] = "STABLE";
  if (momAccel > 0.12 && (momUp || momDn)) momentum = "STRENGTHENING";
  else if (momAccel < -0.12 || (volLow && (momUp || momDn))) momentum = "WEAKENING";
  if (bullVotes >= 2 && bearVotes >= 2) momentum = "CONFLICTING";

  // profile context
  if (profile) {
    if (profile.position === "ACCEPTING_ABOVE") supporting.push("Volume profile: accepting above prior value (closes beyond VAH).");
    if (profile.position === "ACCEPTING_BELOW") supporting.push("Volume profile: accepting below prior value (closes beyond VAL).");
    if (profile.position === "ROTATING_AROUND_POC") supporting.push("Volume profile: rotation around POC — balance, breakout requires acceptance away from value.");
    if (profile.position === "TESTING_VAH" || profile.position === "TESTING_VAL") supporting.push(`Volume profile: ${profile.positionDetail}`);
  }

  // quality + trade justification
  const evidenceScore = supporting.length * 2 - contradicting.length * 1.5;
  const quality: MovementAssessment["quality"] = evidenceScore >= 6 ? "HIGH" : evidenceScore >= 3 ? "MEDIUM" : "LOW";
  const tradeStates: MovementState[] = [
    "CONFIRMED_UPSIDE_BREAKOUT", "CONFIRMED_DOWNSIDE_BREAKDOWN",
    "BULLISH_MOMENTUM_STRENGTHENING", "BEARISH_MOMENTUM_STRENGTHENING",
    "BULLISH_CONTINUATION", "BEARISH_CONTINUATION",
  ];
  const tradeJustified = tradeStates.includes(state) && quality !== "LOW" && !volLow;
  let waitReason: string | null = null;
  if (!tradeJustified) {
    if (state === "INSUFFICIENT_DATA") waitReason = "Insufficient completed data.";
    else if (volLow) waitReason = "Relative volume below 0.75 — participation too weak to justify a setup.";
    else if (state === "CONFLICTING_SIGNALS") waitReason = "Conflicting evidence — capital protection rule: wait for resolution.";
    else if (state === "BREAKOUT_DEVELOPING") waitReason = "Setup is developing; confirmation conditions listed are not met yet.";
    else if (!tradeStates.includes(state)) waitReason = `State "${state}" does not justify a position; per platform rules the system waits.`;
    else waitReason = "Evidence quality is low (supporting evidence does not clearly outweigh contradicting evidence).";
  }

  return { state, bias, momentum, quality, supporting, contradicting, confirmNext, invalidateBias, tradeJustified, waitReason };
}

export function movementStateLabel(s: MovementState): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
