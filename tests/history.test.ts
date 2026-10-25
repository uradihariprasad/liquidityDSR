/**
 * Historical candle merge, session scoping and aggregation tests.
 *
 * Guards root cause B21: the app fetched ONLY the v3 intraday endpoint, which
 * returns the current session alone. Early in the day that is too few bars for
 * FMPI's 30-completed-candle minimum, which cascaded into FMPI 0.0,
 * "0 eligible" in the scanner and an empty Trade Finder.
 */
import { describe, it, expect } from "vitest";
import { sanitizeCandles, computeIndicators, isValidCandle, HISTORY_SESSIONS } from "@/lib/market/engine";
import { aggregate } from "@/lib/market/candles";
import type { Candle } from "@/lib/market/types";

const IST = 5.5 * 3600_000;
/** build one 375-bar NSE session of 1-minute candles for a given IST date */
function session(dateStr: string, base = 100): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  const open0 = Date.parse(`${dateStr}T09:15:00+05:30`);
  return Array.from({ length: 375 }, (_, i) => {
    const px = base + Math.sin(i / 25) * 2;
    return { ts: open0 + i * 60_000, open: px, high: px + 0.6, low: px - 0.6, close: px + 0.2, volume: 1000 + i };
  });
}
const istDay = (ts: number) => new Date(ts + IST).toISOString().slice(0, 10);

describe("multi-session merge", () => {
  it("merges prior sessions with today and de-duplicates overlapping bars", () => {
    const hist = [...session("2026-10-19"), ...session("2026-10-20", 101)];
    const today = session("2026-10-21", 102);
    // simulate an overlap: the last historical bar repeated in the intraday feed
    const overlap = [hist[hist.length - 1], ...today];
    const { candles, dropped } = sanitizeCandles([...hist, ...overlap]);
    expect(dropped).toBe(0);
    expect(candles.length).toBe(375 * 3);                 // no duplicates
    const uniq = new Set(candles.map((c) => c.ts));
    expect(uniq.size).toBe(candles.length);
  });

  it("returns candles in strict ascending timestamp order", () => {
    const merged = sanitizeCandles([...session("2026-10-21"), ...session("2026-10-19")]).candles;
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i].ts).toBeGreaterThan(merged[i - 1].ts);
    }
  });

  it("provides enough completed 5m candles for FMPI where intraday alone would not", () => {
    // intraday-only at ~11:28 IST == 133 one-minute bars == 26 completed 5m bars
    const intradayOnly = session("2026-10-22").slice(0, 133);
    expect(aggregate(sanitizeCandles(intradayOnly).candles, 5).length).toBeLessThan(30);

    // with prior sessions merged in, the same moment has ample history
    const merged = sanitizeCandles([
      ...session("2026-10-19"), ...session("2026-10-20"), ...session("2026-10-21"),
      ...intradayOnly,
    ]).candles;
    expect(aggregate(merged, 5).length).toBeGreaterThan(200);
  });

  it("keeps a bounded number of sessions", () => {
    expect(HISTORY_SESSIONS).toBeGreaterThanOrEqual(3);   // spec: >= 3 prior sessions
  });
});

describe("timeframe aggregation across sessions", () => {
  it("never merges bars from two different sessions into one candle", () => {
    const merged = sanitizeCandles([...session("2026-10-19"), ...session("2026-10-20")]).candles;
    const agg = aggregate(merged, 5);
    // 375 bars/session is divisible by 5, so each session yields whole candles
    expect(agg.length).toBe((375 / 5) * 2);
    for (const c of agg) {
      // a candle's span must stay inside a single IST trading date
      expect(istDay(c.ts)).toBe(istDay(c.ts + 4 * 60_000));
    }
  });

  it("conserves volume and the OHLC envelope when aggregating", () => {
    const one = sanitizeCandles(session("2026-10-21")).candles;
    for (const tf of [2, 3, 5, 15, 30]) {
      const agg = aggregate(one, tf);
      expect(agg.reduce((a, c) => a + c.volume, 0)).toBe(one.reduce((a, c) => a + c.volume, 0));
      expect(agg[0].open).toBe(one[0].open);
      expect(agg[0].high).toBe(Math.max(...one.slice(0, tf).map((c) => c.high)));
      expect(agg[0].low).toBe(Math.min(...one.slice(0, tf).map((c) => c.low)));
    }
  });
});

describe("session-scoped VWAP (regression: multi-day series must not distort it)", () => {
  it("leaves pre-session bars null and resets VWAP at the session start", () => {
    const prior = sanitizeCandles(session("2026-10-20", 50)).candles;   // far-away prices
    const today = sanitizeCandles(session("2026-10-21", 500)).candles;  // today's prices
    const all = [...prior, ...today];
    const ind = computeIndicators(all, prior.length);

    expect(ind.vwap[prior.length - 1]).toBeNull();        // prior session not scored
    const v = ind.vwap[all.length - 1]!;
    expect(v).not.toBeNull();
    // VWAP must sit in TODAY's price band (~500), not be dragged toward 50
    expect(v).toBeGreaterThan(400);
    expect(v).toBeLessThan(600);
  });

  it("a whole-series VWAP would be distorted — proving the scoping matters", () => {
    const prior = sanitizeCandles(session("2026-10-20", 50)).candles;
    const today = sanitizeCandles(session("2026-10-21", 500)).candles;
    const unscoped = computeIndicators([...prior, ...today], 0);
    expect(unscoped.vwap[prior.length + today.length - 1]!).toBeLessThan(400); // distorted
  });

  it("EMA/RSI/ATR benefit from the longer warm-up history", () => {
    const short = computeIndicators(sanitizeCandles(session("2026-10-21").slice(0, 60)).candles);
    const long = computeIndicators(sanitizeCandles([...session("2026-10-19"), ...session("2026-10-21")]).candles);
    expect(short.ema200[59]).toBeNull();                  // impossible on 60 bars
    expect(long.ema200[long.ema200.length - 1]).not.toBeNull();
    expect(long.atr[long.atr.length - 1]).not.toBeNull();
  });
});

describe("candle validation still rejects bad rows after merging", () => {
  it("drops malformed rows without poisoning a multi-session series", () => {
    const good = session("2026-10-21");
    const bad = [
      { ts: NaN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { ts: 1, open: -5, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { ts: 2, open: 1, high: 0.4, low: 0.5, close: 1.5, volume: 10 },
    ];
    const { candles, dropped } = sanitizeCandles([...good, ...bad]);
    expect(dropped).toBe(bad.length);
    expect(candles.length).toBe(good.length);
    expect(candles.every((c) => isValidCandle(c))).toBe(true);
  });
});
