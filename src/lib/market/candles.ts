/**
 * Pure candle utilities — timeframe aggregation and IST session clock.
 * No data generation lives here: the platform is live-data-only.
 */

import type { Candle } from "./types";

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;

export function istParts(nowMs: number): { dateStr: string; minutes: number; weekday: number } {
  const d = new Date(nowMs + IST_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return { dateStr: `${yyyy}-${mm}-${dd}`, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

export type MarketSession = "PRE_OPEN" | "OPEN" | "CLOSED";

export function marketSession(nowMs: number): MarketSession {
  const p = istParts(nowMs);
  const wdOk = p.weekday >= 1 && p.weekday <= 5;
  if (!wdOk) return "CLOSED";
  if (p.minutes < SESSION_OPEN_MIN) return p.minutes >= 9 * 60 ? "PRE_OPEN" : "CLOSED";
  if (p.minutes <= SESSION_CLOSE_MIN) return "OPEN";
  return "CLOSED";
}

export function isWeekday(dateStr: string): boolean {
  const wd = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return wd >= 1 && wd <= 5;
}

export function prevTradingDate(dateStr: string, stepsBack = 1): string {
  let d = new Date(dateStr + "T00:00:00Z");
  let left = stepsBack;
  while (left > 0) {
    d = new Date(d.getTime() - 86400000);
    const wd = d.getUTCDay();
    if (wd >= 1 && wd <= 5) left--;
  }
  return d.toISOString().slice(0, 10);
}

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  return new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** Aggregate 1-minute candles into a higher timeframe (source must start at a session boundary). */
export function aggregate(source: Candle[], tfMin: number): Candle[] {
  if (tfMin <= 1) return source;
  const out: Candle[] = [];
  for (let i = 0; i < source.length; i += tfMin) {
    const slice = source.slice(i, Math.min(i + tfMin, source.length));
    if (!slice.length) continue;
    out.push({
      ts: slice[0].ts,
      open: slice[0].open,
      high: Math.max(...slice.map((c) => c.high)),
      low: Math.min(...slice.map((c) => c.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((a, c) => a + c.volume, 0),
      live: slice.some((c) => c.live),
    });
  }
  return out;
}
