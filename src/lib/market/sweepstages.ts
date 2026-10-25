/**
 * MODULE F — Staged sweep / reclaim detection.
 *
 * Wraps the existing validated sweep engine (sweeps.ts) and exposes the
 * explicit STAGES required by the spec, keeping them strictly separate:
 *
 *   UNTOUCHED -> TOUCHED -> PENETRATED -> SWEEP_CANDIDATE
 *            -> RECLAIM_CONFIRMED -> FOLLOW_THROUGH_CONFIRMED
 *            or INVALIDATED
 *
 * A simple TOUCH is never reported as a confirmed sweep. Each stage carries
 * the exact condition that produced it, so the UI can show why a candidate
 * did or did not advance.
 *
 * All thresholds are volatility-aware (ATR multiples) and configurable.
 * Stages are computed ONLY from candles up to the evaluation point, so
 * historical replay cannot look ahead.
 */

import type { Candle } from "./types";
import { detectSweeps, type SweepEvent, type SweepConfig } from "./sweeps";

export type SweepStage =
  | "UNTOUCHED"
  | "TOUCHED"
  | "PENETRATED"
  | "SWEEP_CANDIDATE"
  | "RECLAIM_CONFIRMED"
  | "FOLLOW_THROUGH_CONFIRMED"
  | "INVALIDATED";

export interface StagedSweep {
  id: string;
  ts: number;
  side: "HIGH" | "LOW";
  direction: "BULLISH" | "BEARISH";
  level: number;
  extreme: number;
  stage: SweepStage;
  stageReason: string;
  penetrationAtr: number | null;
  wickRatio: number | null;
  relVol: number | null;
  /** independent confirmations actually available on this feed */
  confirmations: {
    volume: boolean | null;          // null = not evaluable
    executedFlow: boolean | null;    // always null on the current feed
    structureShift: boolean | null;
  };
  invalidationLevel: number | null;
  fresh: boolean;
  evidence: string[];
  missing: string[];
}

export interface StagedSweepConfig extends SweepConfig {
  /** penetration beyond the level required to move TOUCHED -> PENETRATED (ATR) */
  penetrationAtr: number;
  /** close back through the level required for SWEEP_CANDIDATE */
  requireReclaimClose: boolean;
}

export const DEFAULT_STAGED_SWEEP_CONFIG: StagedSweepConfig = {
  // inherited from the validated sweep engine
  lookback: 10,
  minPenAtr: 0.08,
  maxPenAtr: 1.2,
  minWickRatio: 0.5,
  minRelVol: 1.1,
  confirmWindow: 6,
  freshWindow: 10,
  // staged additions
  penetrationAtr: 0.05,
  requireReclaimClose: true,
};

/**
 * Compute the staged view for every sweep candidate in the window.
 * Uses the validated engine for detection, then classifies each event into
 * exactly one stage with a documented reason.
 */
export function detectStagedSweeps(
  candles: Candle[],
  atrSeries: (number | null)[],
  relVolSeries: (number | null)[],
  cfg: Partial<StagedSweepConfig> = {},
): StagedSweep[] {
  const c = { ...DEFAULT_STAGED_SWEEP_CONFIG, ...cfg };
  const done = candles.filter((x) => !x.live);
  if (done.length < c.lookback + 5) return [];

  // run the validated engine for the events themselves
  const events: SweepEvent[] = detectSweeps(done, atrSeries, relVolSeries, {
    lookback: c.lookback,
    minPenAtr: c.minPenAtr,
    maxPenAtr: c.maxPenAtr,
    minWickRatio: c.minWickRatio,
    minRelVol: c.minRelVol,
    confirmWindow: c.confirmWindow,
    freshWindow: c.freshWindow,
  });

  const out: StagedSweep[] = [];

  // Also surface TOUCHED / PENETRATED bars that did NOT become candidates, so
  // the UI can show why a touch was rejected rather than hiding it.
  for (let i = c.lookback; i < done.length; i++) {
    const bar = done[i];
    const atr = atrSeries[i];
    if (!atr || atr <= 0) continue;
    const window = done.slice(i - c.lookback, i);
    const priorHigh = Math.max(...window.map((x) => x.high));
    const priorLow = Math.min(...window.map((x) => x.low));
    const relVol = relVolSeries[i] ?? null;

    const check = (side: "HIGH" | "LOW") => {
      const pen = side === "HIGH" ? bar.high - priorHigh : priorLow - bar.low;
      if (pen <= 0) return; // UNTOUCHED — not worth reporting
      const penAtr = pen / atr;
      const touched = pen > 0;
      const penetrated = pen >= c.penetrationAtr * atr;
      const reclaimedBack = side === "HIGH" ? bar.close < priorHigh : bar.close > priorLow;

      // skip if the validated engine already produced an event for this bar
      const already = events.some((e) => e.idx === i && e.side === side);
      if (already) return;

      let stage: SweepStage;
      let reason: string;
      if (!penetrated) {
        stage = "TOUCHED";
        reason = `Traded ${penAtr.toFixed(3)}×ATR beyond the ${c.lookback}-candle ${side === "HIGH" ? "high" : "low"} — below the ${c.penetrationAtr}×ATR penetration threshold, so this is a touch, not a sweep.`;
      } else if (c.requireReclaimClose && !reclaimedBack) {
        stage = "PENETRATED";
        reason = `Penetrated ${penAtr.toFixed(2)}×ATR beyond the level but the candle closed ${side === "HIGH" ? "above" : "below"} it — no reclaim, so no sweep candidate.`;
      } else {
        // penetrated and reclaimed but rejected by another filter (wick/volume)
        stage = "SWEEP_CANDIDATE";
        reason = `Penetrated and reclaimed, but rejected by the validated engine's wick/volume filters — reported as an unconfirmed candidate.`;
      }

      out.push({
        id: `${side}-stage-${bar.ts}`,
        ts: bar.ts,
        side,
        direction: side === "HIGH" ? "BEARISH" : "BULLISH",
        level: side === "HIGH" ? priorHigh : priorLow,
        extreme: side === "HIGH" ? bar.high : bar.low,
        stage,
        stageReason: reason,
        penetrationAtr: penAtr,
        wickRatio: null,
        relVol,
        confirmations: { volume: relVol != null ? relVol >= c.minRelVol : null, executedFlow: null, structureShift: null },
        invalidationLevel: side === "HIGH" ? bar.high : bar.low,
        fresh: done.length - 1 - i <= c.freshWindow,
        evidence: [reason],
        missing: ["Executed-flow confirmation is unavailable on this feed (no aggressor-side data)."],
      });
    };
    check("HIGH");
    check("LOW");
  }

  // map the validated events onto the staged model
  for (const e of events) {
    let stage: SweepStage;
    let reason: string;
    switch (e.state) {
      case "CONFIRMED":
        stage = "FOLLOW_THROUGH_CONFIRMED";
        reason = `Reclaim confirmed and follow-through: price closed beyond the sweep candle's ${e.side === "HIGH" ? "low" : "high"} within ${c.confirmWindow} candles.`;
        break;
      case "FAILED":
        stage = "INVALIDATED";
        reason = e.note;
        break;
      case "EXPIRED":
        stage = "SWEEP_CANDIDATE";
        reason = `Breach-and-reclaim occurred but produced no follow-through within ${c.confirmWindow} candles — candidate expired unconfirmed.`;
        break;
      default:
        stage = "RECLAIM_CONFIRMED";
        reason = `Breach and reclaim confirmed by close; follow-through not yet observed.`;
    }

    out.push({
      id: e.id,
      ts: e.ts,
      side: e.side,
      direction: e.direction,
      level: e.level,
      extreme: e.extreme,
      stage,
      stageReason: reason,
      penetrationAtr: e.penetrationAtr,
      wickRatio: e.wickRatio,
      relVol: e.relVol,
      confirmations: {
        volume: e.relVol != null ? e.relVol >= c.minRelVol : null,
        // always null: no aggressor-side data on this feed
        executedFlow: null,
        structureShift: null,
      },
      invalidationLevel: e.invalidation ? e.extreme : e.extreme,
      fresh: e.fresh,
      evidence: e.evidence,
      missing: e.missing,
    });
  }

  return out.sort((a, b) => a.ts - b.ts).slice(-24);
}

/** The single most relevant staged sweep (confirmed first, then freshest). */
export function activeStagedSweep(events: StagedSweep[]): StagedSweep | null {
  const live = events.filter((e) => e.fresh);
  if (!live.length) return null;
  const rank = (s: SweepStage) =>
    s === "FOLLOW_THROUGH_CONFIRMED" ? 4 : s === "RECLAIM_CONFIRMED" ? 3 : s === "SWEEP_CANDIDATE" ? 2 : s === "INVALIDATED" ? 0 : 1;
  return [...live].sort((a, b) => rank(b.stage) - rank(a.stage) || b.ts - a.ts)[0];
}
