/**
 * Price-structure analysis: swing points, trend, Break of Structure (BOS)
 * and Change of Character (CHOCH) using objective, documented rules.
 *
 * Rules:
 *  - A swing high at index i requires high[i] to be the max of [i-k, i+k].
 *    It is CONFIRMED only once candle i+k has closed (no lookahead: callers
 *    pass data truncated to the decision point during backtests).
 *  - Trend UP    = last two confirmed highs higher AND last two confirmed lows higher.
 *  - Trend DOWN  = mirror. Otherwise RANGE.
 *  - BOS         = a close beyond the most recent confirmed swing in the
 *                  trend direction.
 *  - CHOCH       = a close beyond the most recent opposite-direction swing
 *                  after an established trend.
 */

import type { Candle, StructureInfo, SwingPoint } from "./types";

export const SWING_K = 2;

export function swingPoints(candles: Candle[], k = SWING_K): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    // A swing is only knowable once candle i+k has CLOSED. Record that moment
    // separately from the pivot timestamp so downstream consumers never treat
    // the confirmation window as observable history.
    const confirmedTs = candles[i + k].ts;
    if (isHigh) swings.push({ idx: i, ts: candles[i].ts, confirmedTs, price: candles[i].high, kind: "high", confirmed: true });
    if (isLow) swings.push({ idx: i, ts: candles[i].ts, confirmedTs, price: candles[i].low, kind: "low", confirmed: true });
  }
  return swings;
}

function lastN<T>(arr: T[], n: number): T[] {
  return arr.slice(Math.max(0, arr.length - n));
}

export function analyzeStructure(candles: Candle[]): StructureInfo {
  const swings = swingPoints(candles);
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");

  let hh = 0, lh = 0, hl = 0, ll = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i].price > highs[i - 1].price) hh++;
    else lh++;
  }
  for (let i = 1; i < lows.length; i++) {
    if (lows[i].price > lows[i - 1].price) hl++;
    else ll++;
  }

  const last2H = lastN(highs, 2);
  const last2L = lastN(lows, 2);
  let trend: StructureInfo["trend"] = "RANGE";
  if (last2H.length === 2 && last2L.length === 2) {
    if (last2H[1].price > last2H[0].price && last2L[1].price > last2L[0].price) trend = "UP";
    else if (last2H[1].price < last2H[0].price && last2L[1].price < last2L[0].price) trend = "DOWN";
  }

  // BOS / CHOCH: scan closes after each confirmed swing of the opposite kind
  let lastBOS: StructureInfo["lastBOS"] = null;
  let lastCHOCH: StructureInfo["lastCHOCH"] = null;
  for (const h of highs) {
    for (let i = h.idx + 1; i < candles.length; i++) {
      if (candles[i].close > h.price) {
        const isTrendUp = trend === "UP";
        if (isTrendUp) lastBOS = { direction: "up", idx: i, ts: candles[i].ts, level: h.price };
        else lastCHOCH = { direction: "up", idx: i, ts: candles[i].ts, level: h.price };
        break;
      }
    }
  }
  for (const l of lows) {
    for (let i = l.idx + 1; i < candles.length; i++) {
      if (candles[i].close < l.price) {
        if (trend === "DOWN") lastBOS = { direction: "down", idx: i, ts: candles[i].ts, level: l.price };
        else lastCHOCH = { direction: "down", idx: i, ts: candles[i].ts, level: l.price };
        break;
      }
    }
  }

  return { swings, trend, lastBOS, lastCHOCH, hhCount: hh, hlCount: hl, lhCount: lh, llCount: ll };
}

/**
 * Detect a recent consolidation: last `win` candles whose combined range is
 * below `atrMult` × ATR and where net progress is minimal.
 */
export function detectConsolidation(candles: Candle[], atr: number, win = 12, atrMult = 2.2): { top: number; bottom: number; fromIdx: number } | null {
  if (candles.length < win || atr <= 0) return null;
  const slice = candles.slice(-win);
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const progress = Math.abs(slice[slice.length - 1].close - slice[0].open);
  if (hi - lo <= atr * atrMult && progress <= (hi - lo) * 0.6) {
    return { top: hi, bottom: lo, fromIdx: candles.length - win };
  }
  return null;
}
