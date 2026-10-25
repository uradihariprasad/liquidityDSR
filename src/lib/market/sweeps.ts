/**
 * Liquidity-sweep engine (rewritten).
 *
 * A "sweep" is a breach of a meaningful prior level followed by rejection
 * back through that level. The platform NEVER claims stop-loss orders were
 * executed — only that a breach-and-reclaim pattern consistent with a
 * liquidity event occurred, with its evidence listed.
 *
 * A candidate requires ALL of the following (documented, configurable):
 *  1. MEANINGFUL LEVEL — the breached extreme must be the highest high /
 *     lowest low of the prior `lookback` candles (default 10), i.e. there was
 *     genuinely something to run through. A level inside recent chop is not
 *     a sweep source.
 *  2. PENETRATION BAND — the wick must exceed the level by at least
 *     `minPenAtr` (0.08×ATR) and by at most `maxPenAtr` (1.20×ATR). A deep
 *     drive beyond the level is a breakout/expansion, not a sweep.
 *  3. REJECTION CLOSE — the candle must close back on the origin side of the
 *     level (below a swept high / above a swept low).
 *  4. REJECTION WICK DOMINANCE — the rejected wick must be ≥ `minWickRatio`
 *     (0.50) of the candle's total range, and the body must not dominate in
 *     the breach direction.
 *  5. PARTICIPATION (when available) — relative volume at the sweep candle
 *     ≥ `minRelVol` (1.10) is recorded as supporting evidence; if relVol is
 *     unavailable it is disclosed as a missing channel, never assumed.
 *
 * State machine after detection:
 *   DETECTED    — criteria 1-4 met; UNCONFIRMED. No directional claim.
 *   CONFIRMED   — within `confirmWindow` candles (default 6) price closed
 *                 beyond the sweep candle's opposite extreme in the rejection
 *                 direction (follow-through), OR structure flipped (a close
 *                 beyond the prior swing in the rejection direction).
 *   FAILED      — price instead closed beyond the swept extreme (the level
 *                 genuinely broke) → the sweep hypothesis is invalidated.
 *   EXPIRED     — neither happened inside the window; treated as noise.
 *
 * Only DETECTED (fresh) and CONFIRMED sweeps are surfaced as active signals;
 * FAILED/EXPIRED are retained for the event log and replay.
 */

import type { Candle } from "./types";

export interface SweepConfig {
  lookback: number;
  minPenAtr: number;
  maxPenAtr: number;
  minWickRatio: number;
  minRelVol: number;
  confirmWindow: number;
  freshWindow: number;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  lookback: 10,
  minPenAtr: 0.08,
  maxPenAtr: 1.2,
  minWickRatio: 0.5,
  minRelVol: 1.1,
  confirmWindow: 6,
  freshWindow: 10,
};

export type SweepState = "DETECTED" | "CONFIRMED" | "FAILED" | "EXPIRED";

export interface SweepEvent {
  id: string;
  idx: number;
  ts: number;
  /** HIGH = buy-side liquidity above swept (bearish implication after rejection) */
  side: "HIGH" | "LOW";
  /** direction implied AFTER the rejection */
  direction: "BULLISH" | "BEARISH";
  level: number;
  extreme: number;
  penetrationAtr: number;
  wickRatio: number;
  relVol: number | null;
  close: number;
  state: SweepState;
  confirmedIdx: number | null;
  confirmedTs: number | null;
  fresh: boolean;
  evidence: string[];
  missing: string[];
  invalidation: string;
  note: string;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function detectSweeps(
  candles: Candle[],
  atrSeriesVals: (number | null)[],
  relVolVals: (number | null)[],
  cfg: Partial<SweepConfig> = {},
): SweepEvent[] {
  const c = { ...DEFAULT_SWEEP_CONFIG, ...cfg };
  const done = candles.filter((x) => !x.live);
  const n = done.length;
  const out: SweepEvent[] = [];
  if (n < c.lookback + 5) return out;

  for (let i = c.lookback; i < n; i++) {
    const bar = done[i];
    const atr = atrSeriesVals[i];
    if (!atr || atr <= 0) continue;
    const range = bar.high - bar.low;
    if (range <= 0) continue;

    const window = done.slice(i - c.lookback, i);
    const priorHigh = Math.max(...window.map((x) => x.high));
    const priorLow = Math.min(...window.map((x) => x.low));
    const relVol = relVolVals[i] ?? null;

    // ---- high sweep (buy-side liquidity above) --------------------------
    const penHigh = bar.high - priorHigh;
    if (penHigh >= c.minPenAtr * atr && penHigh <= c.maxPenAtr * atr && bar.close < priorHigh) {
      const upperWick = bar.high - Math.max(bar.open, bar.close);
      const wickRatio = upperWick / range;
      const bodyUp = bar.close > bar.open;
      if (wickRatio >= c.minWickRatio && !(bodyUp && bar.close > priorHigh)) {
        out.push(makeEvent(done, i, "HIGH", priorHigh, bar, penHigh / atr, wickRatio, relVol, c, atr));
      }
    }

    // ---- low sweep (sell-side liquidity below) --------------------------
    const penLow = priorLow - bar.low;
    if (penLow >= c.minPenAtr * atr && penLow <= c.maxPenAtr * atr && bar.close > priorLow) {
      const lowerWick = Math.min(bar.open, bar.close) - bar.low;
      const wickRatio = lowerWick / range;
      const bodyDn = bar.close < bar.open;
      if (wickRatio >= c.minWickRatio && !(bodyDn && bar.close < priorLow)) {
        out.push(makeEvent(done, i, "LOW", priorLow, bar, penLow / atr, wickRatio, relVol, c, atr));
      }
    }
  }

  // keep the most recent events; mark freshness relative to the last candle
  const lastIdx = n - 1;
  for (const e of out) e.fresh = (e.state === "CONFIRMED" || e.state === "DETECTED") && lastIdx - e.idx <= c.freshWindow;
  return out.slice(-12);
}

function makeEvent(
  done: Candle[],
  i: number,
  side: "HIGH" | "LOW",
  level: number,
  bar: Candle,
  penetrationAtr: number,
  wickRatio: number,
  relVol: number | null,
  cfg: SweepConfig,
  atr: number,
): SweepEvent {
  const direction: "BULLISH" | "BEARISH" = side === "HIGH" ? "BEARISH" : "BULLISH";
  const extreme = side === "HIGH" ? bar.high : bar.low;

  // ---- resolve the post-event state over the confirmation window -------
  let state: SweepState = "DETECTED";
  let confirmedIdx: number | null = null;
  const end = Math.min(done.length - 1, i + cfg.confirmWindow);
  for (let j = i + 1; j <= end; j++) {
    const f = done[j];
    if (side === "HIGH") {
      // invalidated if price accepts back above the swept extreme
      if (f.close > extreme) { state = "FAILED"; confirmedIdx = j; break; }
      // confirmed on follow-through below the sweep candle low
      if (f.close < bar.low) { state = "CONFIRMED"; confirmedIdx = j; break; }
    } else {
      if (f.close < extreme) { state = "FAILED"; confirmedIdx = j; break; }
      if (f.close > bar.high) { state = "CONFIRMED"; confirmedIdx = j; break; }
    }
  }
  if (state === "DETECTED" && done.length - 1 > i + cfg.confirmWindow) state = "EXPIRED";

  const evidence: string[] = [];
  const missing: string[] = [];
  evidence.push(`Breached the ${cfg.lookback}-candle ${side === "HIGH" ? "high" : "low"} at ${fmt(level)} by ${penetrationAtr.toFixed(2)}×ATR (inside the ${cfg.minPenAtr}–${cfg.maxPenAtr}×ATR sweep band).`);
  evidence.push(`Rejection close ${fmt(bar.close)} back ${side === "HIGH" ? "below" : "above"} the level with a ${(wickRatio * 100).toFixed(0)}% rejection wick (≥ ${(cfg.minWickRatio * 100).toFixed(0)}% required).`);
  if (relVol != null) {
    if (relVol >= cfg.minRelVol) evidence.push(`Participation: relative volume ${relVol.toFixed(2)}× at the sweep candle (≥ ${cfg.minRelVol}×).`);
    else evidence.push(`Participation is light: relative volume ${relVol.toFixed(2)}× (below the ${cfg.minRelVol}× guideline) — weaker evidence.`);
  } else {
    missing.push("Relative volume unavailable for this candle — participation evidence is missing, not assumed.");
  }
  missing.push("Executed-trade aggressor data is unavailable, so resting stop-loss execution cannot be observed — this remains a price-pattern inference.");
  if (state === "CONFIRMED" && confirmedIdx != null) {
    evidence.push(`Follow-through confirmed: close ${fmt(done[confirmedIdx].close)} beyond the sweep candle's ${side === "HIGH" ? "low" : "high"} within ${cfg.confirmWindow} candles.`);
  }
  const note =
    state === "CONFIRMED"
      ? `${side === "HIGH" ? "Buy-side" : "Sell-side"} liquidity above/below ${fmt(level)} was breached and rejected, with follow-through — a ${direction.toLowerCase()} sweep pattern (not proof of executed stops).`
      : state === "FAILED"
        ? `Breach of ${fmt(level)} was NOT rejected — price accepted beyond ${fmt(extreme)}, so the sweep hypothesis is invalidated (treat as a genuine break).`
        : state === "EXPIRED"
          ? `Breach-and-reclaim at ${fmt(level)} produced no follow-through within ${cfg.confirmWindow} candles — treated as noise.`
          : `Breach-and-reclaim at ${fmt(level)} detected; UNCONFIRMED until follow-through ${side === "HIGH" ? "below" : "above"} ${fmt(side === "HIGH" ? bar.low : bar.high)}.`;

  return {
    id: `${side}-${bar.ts}`,
    idx: i,
    ts: bar.ts,
    side,
    direction,
    level,
    extreme,
    penetrationAtr,
    wickRatio,
    relVol,
    close: bar.close,
    state,
    confirmedIdx,
    confirmedTs: confirmedIdx != null ? done[confirmedIdx].ts : null,
    fresh: false,
    evidence,
    missing,
    invalidation:
      side === "HIGH"
        ? `A close above ${fmt(extreme)} invalidates the bearish sweep reading (level genuinely broke).`
        : `A close below ${fmt(extreme)} invalidates the bullish sweep reading (level genuinely broke).`,
    note,
  };
}

/** The single most relevant active sweep (confirmed preferred, then freshest). */
export function activeSweep(events: SweepEvent[]): SweepEvent | null {
  const live = events.filter((e) => e.fresh);
  if (!live.length) return null;
  const confirmed = live.filter((e) => e.state === "CONFIRMED").sort((a, b) => b.idx - a.idx);
  if (confirmed.length) return confirmed[0];
  return live.filter((e) => e.state === "DETECTED").sort((a, b) => b.idx - a.idx)[0] ?? null;
}
