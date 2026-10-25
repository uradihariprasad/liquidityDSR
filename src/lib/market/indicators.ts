/**
 * Technical indicator calculations — pure functions over candle arrays.
 * Indicators are treated strictly as supporting evidence, never as
 * standalone signals (see movement.ts / fmpi.ts for the decision rules).
 */

import type { Candle } from "./types";
import { sma } from "./prng";

export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += values[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/** Wilder RSI */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder ATR */
export function atrSeries(candles: Candle[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const trs: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += trs[i];
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

export function bollingerSeries(closes: number[], period = 20, mult = 2): { mid: (number | null)[]; up: (number | null)[]; lo: (number | null)[] } {
  const mid = sma(closes, period);
  const up: (number | null)[] = new Array(closes.length).fill(null);
  const lo: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - m) * (closes[j] - m);
    const sd = Math.sqrt(v / period);
    up[i] = m + mult * sd;
    lo[i] = m - mult * sd;
  }
  return { mid, up, lo };
}

/** Session VWAP — resets at the first candle of the array (engine passes a single session). */
export function vwapSeries(candles: Candle[]): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let pv = 0;
  let v = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
    out[i] = v > 0 ? pv / v : null;
  }
  return out;
}

/**
 * Relative volume: current volume vs the trailing 20-candle average of the
 * same series (simple, documented approximation — not a same-time-of-day
 * average). Values > 1 mean participation above recent norm.
 */
export function relVolSeries(candles: Candle[], period = 20): (number | null)[] {
  const vols = candles.map((c) => c.volume);
  const avg = sma(vols, period);
  return vols.map((v, i) => (avg[i] && avg[i]! > 0 ? v / avg[i]! : null));
}

/** Rate of change over `period` candles, expressed in ATR units when atr provided. */
export function rocAtr(closes: number[], period: number, atr: (number | null)[], i: number): number | null {
  if (i - period < 0 || i >= closes.length) return null;
  const a = atr[i];
  if (!a || a <= 0) return null;
  return (closes[i] - closes[i - period]) / a;
}

export function lastNonNull(xs: (number | null)[]): number | null {
  for (let i = xs.length - 1; i >= 0; i--) if (xs[i] != null) return xs[i] as number;
  return null;
}

export function candleBodyRatio(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

/** where the close sits within the candle range: 0 = at the low, 1 = at the high */
export function closeLocation(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0.5;
  return (c.close - c.low) / range;
}
