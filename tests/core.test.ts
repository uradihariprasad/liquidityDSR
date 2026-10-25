/**
 * Automated tests for the pure analytics engines.
 * All tests are deterministic — the offline simulation is seeded, and the
 * indicator/movement/FMPI/zone engines are pure functions.
 */
import { describe, it, expect } from "vitest";
import { emaSeries, rsiSeries, atrSeries, bollingerSeries, vwapSeries, relVolSeries } from "@/lib/market/indicators";
import { aggregate, prevTradingDate, istParts } from "@/lib/market/candles";
import { swingPoints, analyzeStructure } from "@/lib/market/structure";
import { buildZones } from "@/lib/market/zones";
import { detectSweeps, activeSweep } from "@/lib/market/sweeps";
import { volumeProfile } from "@/lib/market/profile";
import { classifyMovement } from "@/lib/market/movement";
import { computeFMPI } from "@/lib/market/fmpi";
import { runScanner } from "@/lib/market/scanner";
import { positionSize, generateScenario } from "@/lib/market/trades";
import { evaluateAlertRules, alertDedupeRemainingMs } from "@/lib/market/alerts";
import { runBacktest } from "@/lib/market/backtest";
import type { Candle } from "@/lib/market/types";

// deterministic synthetic candle builders
function mkCandles(closes: number[], startTs = 1_700_000_000_000): Candle[] {
  return closes.map((c, i) => ({
    ts: startTs + i * 60000,
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]) + 0.5,
    low: Math.min(c, i === 0 ? c : closes[i - 1]) - 0.5,
    close: c,
    volume: 1000 + (i % 5) * 100,
    live: false,
  }));
}
const trend = (n: number, step: number, from = 100) => Array.from({ length: n }, (_, i) => from + i * step);
const range = (n: number, center = 100, amp = 1.2) => Array.from({ length: n }, (_, i) => center + Math.sin(i / 2.2) * amp);
/** staircase: directional drift with periodic pullbacks — produces real swing structure */
const stairs = (n: number, dir: 1 | -1, from = 100) =>
  Array.from({ length: n }, (_, i) => from + i * 0.55 * dir + Math.sin((i * Math.PI) / 2.5) * 0.9);

function indicatorsOf(cs: Candle[]) {
  const closes = cs.map((c) => c.close);
  const bb = bollingerSeries(closes, 20, 2);
  return {
    ema9: emaSeries(closes, 9), ema21: emaSeries(closes, 21), ema50: emaSeries(closes, 50), ema200: emaSeries(closes, 200),
    vwap: vwapSeries(cs), rsi: rsiSeries(closes, 14), bbMid: bb.mid, bbUp: bb.up, bbLo: bb.lo,
    atr: atrSeries(cs, 14), relVol: relVolSeries(cs, 20),
  };
}

describe("indicators", () => {
  it("EMA converges and is null during warmup", () => {
    const e = emaSeries([10, 10, 10, 10, 10, 10], 3);
    expect(e[0]).toBeNull();
    expect(e[2]).toBeCloseTo(10);
    expect(e[5]).toBeCloseTo(10);
  });
  it("RSI is 100 for a monotonically rising series and bounded", () => {
    const r = rsiSeries(trend(40, 1), 14);
    expect(r[14]).toBe(100);
    for (const v of r) if (v != null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
  });
  it("ATR positive and roughly the true range", () => {
    const cs = mkCandles(range(40));
    const a = atrSeries(cs, 14);
    expect(a[14]!).toBeGreaterThan(0);
  });
  it("VWAP sits inside the price range for uniform volume", () => {
    const cs = mkCandles(range(30));
    const v = vwapSeries(cs);
    const last = v[v.length - 1]!;
    expect(last).toBeGreaterThan(97);
    expect(last).toBeLessThan(103);
  });
  it("Bollinger bands straddle the mean", () => {
    const closes = range(40);
    const bb = bollingerSeries(closes, 20, 2);
    expect(bb.up[39]!).toBeGreaterThan(bb.mid[39]!);
    expect(bb.lo[39]!).toBeLessThan(bb.mid[39]!);
  });
  it("relative volume near 1 for uniform volume", () => {
    const cs = mkCandles(range(30));
    const rv = relVolSeries(cs, 20);
    expect(rv[29]!).toBeGreaterThan(0.5);
    expect(rv[29]!).toBeLessThan(2);
  });
});

describe("candle aggregation & session clock (pure)", () => {
  it("aggregation to 5m conserves volume and OHLC envelope", () => {
    const oneM = mkCandles(range(50), 1_700_000_000_000);
    const fiveM = aggregate(oneM, 5);
    expect(fiveM.length).toBe(10);
    const v1 = oneM.reduce((s: number, c: Candle) => s + c.volume, 0);
    const v5 = fiveM.reduce((s: number, c: Candle) => s + c.volume, 0);
    expect(v5).toBe(v1);
    expect(fiveM[0].open).toBe(oneM[0].open);
    expect(fiveM[0].high).toBe(Math.max(...oneM.slice(0, 5).map((c: Candle) => c.high)));
    expect(fiveM[0].live).toBe(false);
  });
  it("prevTradingDate skips weekends", () => {
    expect(prevTradingDate("2026-02-16")).toBe("2026-02-13"); // Sun 15th → Fri 13th
    expect(prevTradingDate("2026-02-17")).toBe("2026-02-16");
  });
  it("istParts reports a valid IST date string", () => {
    const p = istParts(Date.UTC(2026, 1, 13, 4, 0, 0)); // 09:30 IST
    expect(p.dateStr).toMatch(/^2026-02-1[23]$/);
    expect(p.minutes).toBeGreaterThan(0);
  });
});

describe("price structure", () => {
  it("detects confirmed swings with k=2", () => {
    const closes = [1, 2, 3, 2, 1, 2, 3.2, 2, 1, 1];
    const sw = swingPoints(mkCandles(closes), 2);
    expect(sw.some((s) => s.kind === "high" && s.price >= 3.5)).toBe(true);
  });
  it("classifies an uptrend from HH/HL", () => {
    const st = analyzeStructure(mkCandles(stairs(60, 1)));
    expect(st.trend).toBe("UP");
    expect(st.hhCount).toBeGreaterThan(0);
    expect(st.hlCount).toBeGreaterThan(0);
  });
  it("classifies a downtrend from LH/LL", () => {
    const st = analyzeStructure(mkCandles(stairs(60, -1)));
    expect(st.trend).toBe("DOWN");
  });
});

describe("liquidity zones", () => {
  const day = { prevHigh: 105, prevLow: 95, prevWeekHigh: 110, prevWeekLow: 90, orHigh: 102, orLow: 98 };
  it("builds PDH/PDL/OR zones with bounded strengths", () => {
    const cs = mkCandles(range(80));
    const zs = buildZones({ candles: cs, atr: 1.5, swings: swingPoints(cs), day, profile: null, consolidation: null });
    const types = zs.map((z) => z.type);
    expect(types).toContain("PDH");
    expect(types).toContain("PDL");
    for (const z of zs) {
      expect(z.strength).toBeGreaterThanOrEqual(5);
      expect(z.strength).toBeLessThanOrEqual(100);
      expect(z.top).toBeGreaterThan(z.bottom);
    }
  });
  it("never marks a zone POTENTIALLY_SWEPT without a validated sweep event", () => {
    const cs = mkCandles(range(59, 100, 0.4));
    // a lone spike wick is NOT a sweep by itself
    cs.push({ ts: cs[cs.length - 1].ts + 60000, open: 100.4, high: 104.0, low: 100.3, close: 100.55, volume: 3000, live: false });
    const zs = buildZones({ candles: cs, atr: 1.2, swings: swingPoints(cs), day: { ...day, prevHigh: 100.5, prevLow: 98, orHigh: null, orLow: null }, profile: null, consolidation: null });
    expect(zs.some((z) => z.status === "POTENTIALLY_SWEPT")).toBe(false);
  });
  it("breaks a resistance zone only on closes above it, not below", () => {
    const cs = mkCandles(range(50, 100, 0.4));
    // decisive closes far BELOW a resistance zone must not mark it broken
    for (let k = 0; k < 3; k++) {
      cs.push({ ts: cs[cs.length - 1].ts + 60000, open: 96, high: 101, low: 95, close: 95.5, volume: 2000, live: false });
    }
    const zs = buildZones({ candles: cs, atr: 1.2, swings: swingPoints(cs), day: { ...day, prevHigh: 100.5, prevLow: 90, orHigh: null, orLow: null }, profile: null, consolidation: null });
    const pdh = zs.find((z) => z.type === "PDH");
    expect(pdh).toBeTruthy();
    expect(["BROKEN", "INVALIDATED"]).not.toContain(pdh!.status);
  });
});

describe("volume profile (documented approximation)", () => {
  it("computes POC with VAH >= POC >= VAL and volume conservation", () => {
    const cs = mkCandles(stairs(220, 1));
    const atr = atrSeries(cs, 14).at(-1)!;
    const p = volumeProfile(cs, atr)!;
    expect(p).toBeTruthy();
    expect(p.vah).toBeGreaterThanOrEqual(p.poc);
    expect(p.val).toBeLessThanOrEqual(p.poc);
    expect(p.approximation).toBe(true);
    const binVol = p.bins.reduce((s, b) => s + b.volume, 0);
    expect(Math.abs(binVol - p.totalVolume) / p.totalVolume).toBeLessThan(0.01);
  });
});

describe("market movement classifier", () => {
  it("returns INSUFFICIENT_DATA below 30 completed candles", () => {
    const cs = mkCandles(trend(20, 1));
    const ind = indicatorsOf(cs);
    const m = classifyMovement({ candles: cs, tfMinutes: 1, indicators: ind, structure: analyzeStructure(cs), zones: [], profile: null, atrNow: 1 });
    expect(m.state).toBe("INSUFFICIENT_DATA");
    expect(m.tradeJustified).toBe(false);
  });
  it("classifies a strong up-staircase as bullish", () => {
    const cs = mkCandles(stairs(120, 1));
    const ind = indicatorsOf(cs);
    const m = classifyMovement({ candles: cs, tfMinutes: 1, indicators: ind, structure: analyzeStructure(cs), zones: [], profile: null, atrNow: 1.2 });
    expect(m.bias).toBe("BULLISH");
    expect(m.supporting.length).toBeGreaterThan(0);
  });
  it("provides confirmation and invalidation text for tradable states", () => {
    const cs = mkCandles(stairs(120, 1));
    const ind = indicatorsOf(cs);
    const m = classifyMovement({ candles: cs, tfMinutes: 1, indicators: ind, structure: analyzeStructure(cs), zones: [], profile: null, atrNow: 1.2 });
    if (m.tradeJustified) {
      expect(m.invalidateBias.length).toBeGreaterThan(0);
    }
  });
});

describe("FMPI", () => {
  function fmpiOf(cs: Candle[]) {
    const ind = indicatorsOf(cs);
    const atrNow = ind.atr.at(-1) ?? 1;
    const structure = analyzeStructure(cs);
    const movement = classifyMovement({ candles: cs, tfMinutes: 1, indicators: ind, structure, zones: [], profile: null, atrNow });
    return computeFMPI({ candles: cs, indicators: ind, structure, zones: [], profile: null, atrNow, movement });
  }
  it("score is bounded 0..100 and reproducible", () => {
    const cs = mkCandles(stairs(180, 1));
    const a = fmpiOf(cs);
    const b = fmpiOf(cs);
    expect(a.score).toBe(b.score);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
  });
  it("trending data scores higher than choppy data", () => {
    const t = fmpiOf(mkCandles(trend(120, 0.9)));
    const r = fmpiOf(mkCandles(range(120, 100, 1.1)));
    expect(t.score).toBeGreaterThan(r.score);
  });
  it("insufficient data produces 0 with a disclosure, not a manufactured score", () => {
    const f = fmpiOf(mkCandles(trend(15, 1)));
    expect(f.score).toBe(0);
    expect(f.reducing.join(" ")).toMatch(/30 completed candles/);
  });
  it("marks order-flow components unavailable offline rather than neutral", () => {
    const f = fmpiOf(mkCandles(trend(120, 0.9)));
    const of = f.components.find((c) => c.key === "orderflow");
    expect(of?.available).toBe(false);
  });
});

describe("scanner ranking", () => {
  it("ranks higher-FMPI candidates first and caps the count", () => {
    const feats = Array.from({ length: 12 }, (_, i) => ({
      symbol: `S${i}`, name: `S${i}`, kind: "stock", sector: "X",
      price: 100 + i, changePct: 1 + (i % 4) * 0.5, relVol: 1.5, fmpi: 40 + i * 4,
      fmpiDirection: "BULLISH" as const, state: "BULLISH_CONTINUATION", trend: "UP" as const,
      breakoutUp: i > 8, breakoutDn: false, zoneNote: null, dataQuality: "OK", dayMoveAtr: 1,
    }));
    const res = runScanner(feats, "TEST", { count: 5 });
    expect(res.bullish.length).toBeLessThanOrEqual(5);
    expect(res.bullish[0].fmpi).toBeGreaterThanOrEqual(res.bullish.at(-1)!.fmpi);
    expect(res.formula).toContain("0.34");
  });
});

describe("trade scenarios & risk", () => {
  it("position sizing uses lot size and floors", () => {
    const r = positionSize({ capital: 500000, riskPct: 0.5, entry: 100, stop: 98, lotSize: 250 });
    // risk 2500, per-lot risk 500 → 5 lots
    expect(r.lots).toBe(5);
    expect(r.qty).toBe(1250);
  });
  it("suppresses scenarios on insufficient data (mandatory gate)", () => {
    const cs = mkCandles(trend(10, 1));
    const ind = indicatorsOf(cs);
    const structure = analyzeStructure(cs);
    const movement = classifyMovement({ candles: cs, tfMinutes: 1, indicators: ind, structure, zones: [], profile: null, atrNow: 1 });
    const fmpi = computeFMPI({ candles: cs, indicators: ind, structure, zones: [], profile: null, atrNow: 1, movement });
    const s = generateScenario({ symbol: "X", tf: "1m", candles: cs, atr: 1, zones: [], structure, fmpi, movement, quality: { mode: "LIVE_UPSTOX", status: "OK", lastTickTs: 1, lastCandleTs: 1, marketSession: "OPEN", warnings: [] } });
    expect(s.status).toBe("NO_TRADE");
    expect(s.noTradeReasons.length).toBeGreaterThan(0);
  });
});

describe("alert deduplication", () => {
  it("reports zero remaining cooldown for a fresh key", () => {
    expect(alertDedupeRemainingMs("fresh:key:1", 900, Date.now())).toBe(0);
  });
});

describe("liquidity sweep engine", () => {
  // base: tight range around 100 so the 10-candle high is well defined
  function baseSeries(n = 40): Candle[] {
    return mkCandles(range(n, 100, 0.5));
  }
  const atrOf = (cs: Candle[]) => atrSeries(cs, 14);
  const relOf = (cs: Candle[]) => relVolSeries(cs, 20);

  it("ignores an ordinary wick that does not clear the prior extreme", () => {
    const cs = baseSeries(40);
    const evs = detectSweeps(cs, atrOf(cs), relOf(cs));
    expect(evs.filter((e) => e.state === "CONFIRMED" || e.state === "DETECTED").length).toBe(0);
  });

  it("detects breach-and-reclaim above the prior high and confirms on follow-through", () => {
    const cs = baseSeries(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const last = cs[cs.length - 1];
    // sweep candle: long upper wick above prior high, closes back below it
    cs.push({ ts: last.ts + 60000, open: priorHigh - 0.4, high: priorHigh + 1.1, low: priorHigh - 0.7, close: priorHigh - 0.6, volume: 4000, live: false });
    // follow-through candle: closes below the sweep candle low
    cs.push({ ts: last.ts + 120000, open: priorHigh - 0.7, high: priorHigh - 0.6, low: priorHigh - 2.2, close: priorHigh - 2.0, volume: 4200, live: false });
    const evs = detectSweeps(cs, atrOf(cs), relOf(cs));
    const hi = evs.find((e) => e.side === "HIGH");
    expect(hi).toBeTruthy();
    expect(hi!.state).toBe("CONFIRMED");
    expect(hi!.direction).toBe("BEARISH");
    expect(hi!.fresh).toBe(true);
    expect(hi!.wickRatio).toBeGreaterThanOrEqual(0.5);
    expect(hi!.note.toLowerCase()).toContain("not proof");
    expect(hi!.missing.join(" ")).toMatch(/aggressor/i);
  });

  it("marks the sweep FAILED when price accepts beyond the swept extreme", () => {
    const cs = baseSeries(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const last = cs[cs.length - 1];
    cs.push({ ts: last.ts + 60000, open: priorHigh - 0.4, high: priorHigh + 1.1, low: priorHigh - 0.7, close: priorHigh - 0.6, volume: 4000, live: false });
    // acceptance above the swept extreme invalidates the sweep
    cs.push({ ts: last.ts + 120000, open: priorHigh - 0.5, high: priorHigh + 2.4, low: priorHigh - 0.6, close: priorHigh + 2.0, volume: 5000, live: false });
    const evs = detectSweeps(cs, atrOf(cs), relOf(cs));
    const hi = evs.find((e) => e.side === "HIGH");
    expect(hi?.state).toBe("FAILED");
    expect(hi?.fresh).toBe(false);
    expect(activeSweep(evs)).toBeNull();
  });

  it("rejects a deep directional drive as a breakout, not a sweep", () => {
    const cs = baseSeries(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const atrNow = atrOf(cs).at(-1)!;
    const last = cs[cs.length - 1];
    // penetration far beyond maxPenAtr with a bullish body = breakout
    cs.push({ ts: last.ts + 60000, open: priorHigh, high: priorHigh + atrNow * 4, low: priorHigh - 0.1, close: priorHigh + atrNow * 3.6, volume: 9000, live: false });
    const evs = detectSweeps(cs, atrOf(cs), relOf(cs));
    expect(evs.some((e) => e.idx === cs.length - 1)).toBe(false);
  });

  it("detects a low sweep with bullish implication", () => {
    const cs = baseSeries(40);
    const priorLow = Math.min(...cs.slice(-10).map((c) => c.low));
    const last = cs[cs.length - 1];
    cs.push({ ts: last.ts + 60000, open: priorLow + 0.4, high: priorLow + 0.7, low: priorLow - 1.1, close: priorLow + 0.6, volume: 4000, live: false });
    cs.push({ ts: last.ts + 120000, open: priorLow + 0.7, high: priorLow + 2.3, low: priorLow + 0.6, close: priorLow + 2.1, volume: 4300, live: false });
    const evs = detectSweeps(cs, atrOf(cs), relOf(cs));
    const lo = evs.find((e) => e.side === "LOW");
    expect(lo?.state).toBe("CONFIRMED");
    expect(lo?.direction).toBe("BULLISH");
    expect(activeSweep(evs)?.side).toBe("LOW");
  });

  it("only promotes zones to POTENTIALLY_SWEPT from validated sweep events", () => {
    const cs = baseSeries(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const last = cs[cs.length - 1];
    cs.push({ ts: last.ts + 60000, open: priorHigh - 0.4, high: priorHigh + 1.1, low: priorHigh - 0.7, close: priorHigh - 0.6, volume: 4000, live: false });
    cs.push({ ts: last.ts + 120000, open: priorHigh - 0.7, high: priorHigh - 0.6, low: priorHigh - 2.2, close: priorHigh - 2.0, volume: 4200, live: false });
    const atrNow = atrOf(cs).at(-1)!;
    const sweeps = detectSweeps(cs, atrOf(cs), relOf(cs));
    const day = { prevHigh: priorHigh, prevLow: 97, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null };
    const withSweeps = buildZones({ candles: cs, atr: atrNow, swings: swingPoints(cs), day, profile: null, consolidation: null, sweeps });
    const withoutSweeps = buildZones({ candles: cs, atr: atrNow, swings: swingPoints(cs), day, profile: null, consolidation: null, sweeps: [] });
    expect(withSweeps.some((z) => z.status === "POTENTIALLY_SWEPT")).toBe(true);
    expect(withoutSweeps.some((z) => z.status === "POTENTIALLY_SWEPT")).toBe(false);
  });
});

describe("backtest module (live-data-only)", () => {
  it("refuses honestly without a connected Upstox token", async () => {
    const r = await runBacktest({ symbols: ["RELIANCE"], days: 5 });
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/Upstox/i);
    expect(r.disclaimers.length).toBeGreaterThan(0);
    expect(r.metrics.overall.setups).toBe(0);
  });
});
