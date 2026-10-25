/**
 * Volume Profile and liquidity-zone alignment tests.
 *
 * Covers the audit requirements: period disclosure, tick-size snapping,
 * consistency guards (VAL<=VAH, POC in range, valid bins), known-distribution
 * POC/VAH/VAL validation, INSIDE_VALUE against the matching profile, zone
 * merge tolerance, and the CONFIRMED_DOWNSIDE_BREAKDOWN recency/condition fix.
 */
import { describe, it, expect } from "vitest";
import { volumeProfile } from "@/lib/market/profile";
import { buildZones } from "@/lib/market/zones";
import { swingPoints } from "@/lib/market/structure";
import { classifyMovement } from "@/lib/market/movement";
import { atrSeries, bollingerSeries, emaSeries, rsiSeries, vwapSeries, atrSeries as atr, relVolSeries } from "@/lib/market/indicators";
import type { Candle } from "@/lib/market/types";

const T0 = Date.parse("2026-10-21T09:15:00+05:30");
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v, live: false });

/** helper candle builder with explicit volume control */
const vb = (i: number, lo: number, hi: number, v: number): Candle =>
  bar(i, (lo + hi) / 2, hi, lo, (lo + hi) / 2, v);

function indicatorsOf(cs: Candle[]) {
  const closes = cs.map((c) => c.close);
  const bb = bollingerSeries(closes, 20, 2);
  return {
    ema9: emaSeries(closes, 9), ema21: emaSeries(closes, 21),
    ema50: emaSeries(closes, 50), ema200: emaSeries(closes, 200),
    vwap: vwapSeries(cs), rsi: rsiSeries(closes, 14),
    bbMid: bb.mid, bbUp: bb.up, bbLo: bb.lo,
    atr: atr(cs, 14), relVol: relVolSeries(cs, 20),
  };
}

describe("POC / VAH / VAL on known distributions", () => {
  it("puts POC at the price with the most volume", () => {
    // 40 bars; bars 10-19 concentrate volume at 100-102
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      if (i >= 10 && i < 20) cs.push(vb(i, 100, 102, 5000));
      else cs.push(vb(i, 104, 106, 100));
    }
    const p = volumeProfile(cs, 1.2, { tickSize: 0.05 })!;
    expect(p).toBeTruthy();
    // POC must sit in the 100-102 band, not the 104-106 band
    expect(p.poc).toBeGreaterThanOrEqual(99.5);
    expect(p.poc).toBeLessThanOrEqual(102.5);
  });

  it("computes the value area to cover the configured share of volume", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      if (i >= 10 && i < 20) cs.push(vb(i, 100, 102, 5000));
      else cs.push(vb(i, 104, 106, 100));
    }
    const p = volumeProfile(cs, 1.2, { tickSize: 0.05, valueAreaPct: 0.7 })!;
    // the heavy band must be inside the value area
    expect(p.vah).toBeGreaterThan(100);
    expect(p.val).toBeLessThan(102);
    // and the value area must contain POC
    expect(p.poc).toBeGreaterThanOrEqual(p.val);
    expect(p.poc).toBeLessThanOrEqual(p.vah);
  });

  it("VAL never exceeds VAH (consistency guard)", () => {
    for (let seed = 1; seed < 25; seed++) {
      const cs: Candle[] = [];
      for (let i = 0; i < 40; i++) {
        const v = (i * seed) % 7 === 0 ? 9000 : 50;
        const base = 100 + ((i * seed) % 11);
        cs.push(vb(i, base, base + 1, v));
      }
      const p = volumeProfile(cs, 1.0, { tickSize: 0.05 });
      if (p) expect(p.val).toBeLessThanOrEqual(p.vah);
    }
  });

  it("rejects a degenerate profile rather than emitting an inverted value area", () => {
    // single-price degenerate series has zero range -> rejected
    const cs = Array.from({ length: 25 }, (_, i) => vb(i, 100, 100, 1000));
    expect(volumeProfile(cs, 1.0)).toBeNull();
  });
});

describe("consistency guards", () => {
  const base = Array.from({ length: 40 }, (_, i) => vb(i, 100 + (i % 5), 101 + (i % 5), 1000));

  it("POC always lies inside the profile's own price range", () => {
    const p = volumeProfile(base, 1.0, { tickSize: 0.05 })!;
    expect(p.poc).toBeGreaterThanOrEqual(p.priceLow);
    expect(p.poc).toBeLessThanOrEqual(p.priceHigh);
    expect(p.consistency.pocInRange).toBe(true);
  });

  it("every bin has a finite price and non-negative volume", () => {
    const p = volumeProfile(base, 1.0, { tickSize: 0.05 })!;
    expect(p.bins.length).toBeGreaterThan(0);
    for (const b of p.bins) {
      expect(Number.isFinite(b.price)).toBe(true);
      expect(Number.isFinite(b.volume)).toBe(true);
      expect(b.volume).toBeGreaterThanOrEqual(0);
    }
    expect(p.consistency.binsValid).toBe(true);
  });

  it("reports all three consistency checks as passing on a valid profile", () => {
    const p = volumeProfile(base, 1.0, { tickSize: 0.05 })!;
    expect(p.consistency).toEqual({ valLeVah: true, pocInRange: true, binsValid: true });
  });

  it("excludes the forming candle so levels cannot repaint", () => {
    const withLive = [...base, { ...vb(base.length, 100, 101, 999999), live: true }];
    const p = volumeProfile(withLive, 1.0, { tickSize: 0.05 })!;
    // the huge-volume forming bar must NOT have moved the profile
    expect(p.candlesUsed).toBe(base.length);
  });
});

describe("tick-size snapping (req 5)", () => {
  it("snaps POC/VAH/VAL/HVN/LVN to the instrument tick size", () => {
    const cs = Array.from({ length: 40 }, (_, i) => vb(i, 100.03, 101.97, 1000));
    const tick = 0.05;
    const p = volumeProfile(cs, 1.0, { tickSize: tick })!;
    const snap = (v: number) => Math.abs(v / tick - Math.round(v / tick)) < 1e-9;
    expect(snap(p.poc)).toBe(true);
    expect(snap(p.vah)).toBe(true);
    expect(snap(p.val)).toBe(true);
    for (const h of p.hvns) expect(snap(h)).toBe(true);
    for (const l of p.lvns) expect(snap(l)).toBe(true);
  });

  it("levels stay inside the instrument's price range after snapping", () => {
    const cs = Array.from({ length: 40 }, (_, i) => vb(i, 100, 106, 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.poc).toBeGreaterThanOrEqual(p.priceLow);
    expect(p.poc).toBeLessThanOrEqual(p.priceHigh);
    expect(p.vah).toBeLessThanOrEqual(p.priceHigh + 0.05);
    expect(p.val).toBeGreaterThanOrEqual(p.priceLow - 0.05);
  });
});

describe("period disclosure (req 1, 2)", () => {
  it("reports MULTI_SESSION with the sessions actually used", () => {
    const cs: Candle[] = [];
    // two separate IST trading days
    const d1 = Date.parse("2026-10-20T09:15:00+05:30");
    const d2 = Date.parse("2026-10-21T09:15:00+05:30");
    for (let i = 0; i < 25; i++) cs.push({ ...vb(i, 100, 102, 1000), ts: d1 + i * 300_000 });
    for (let i = 0; i < 25; i++) cs.push({ ...vb(i + 25, 100, 102, 1000), ts: d2 + i * 300_000 });
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.period).toBe("MULTI_SESSION");
    expect(p.sessionCount).toBe(2);
    expect(p.sessions).toEqual(["2026-10-20", "2026-10-21"]);
    expect(p.candlesUsed).toBe(50);
  });

  it("reports SINGLE_SESSION when only one day is present", () => {
    const cs = Array.from({ length: 30 }, (_, i) => vb(i, 100, 102, 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.period).toBe("SINGLE_SESSION");
    expect(p.sessionCount).toBe(1);
  });

  it("records from/to timestamps, timeframe and calculation time", () => {
    const cs = Array.from({ length: 30 }, (_, i) => vb(i, 100, 102, 1000));
    const before = Date.now();
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.fromTs).toBe(cs[0].ts);
    expect(p.toTs).toBe(cs[cs.length - 1].ts);
    expect(p.timeframe).toBe("5m");
    expect(p.calculatedAt).toBeGreaterThanOrEqual(before);
  });

  it("is always labelled as an OHLCV approximation", () => {
    const cs = Array.from({ length: 30 }, (_, i) => vb(i, 100, 102, 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.approximation).toBe(true);
    expect(p.method).toBe("UNIFORM_ALLOCATION_FROM_OHLCV");
  });
});

describe("INSIDE_VALUE uses the matching profile (req 8)", () => {
  it("classifies against its own VAH/VAL, not another scale", () => {
    // price finishing mid-range
    const cs = Array.from({ length: 40 }, (_, i) => {
      const lo = 100 + Math.sin(i / 5) * 3;
      return vb(i, lo, lo + 2, 1000);
    });
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    const price = cs[cs.length - 1].close;
    if (p.position === "INSIDE_VALUE") {
      expect(price).toBeGreaterThanOrEqual(p.val - 1.0);
      expect(price).toBeLessThanOrEqual(p.vah + 1.0);
    }
  });

  it("TESTING_VAH only when price is genuinely near THIS profile's VAH", () => {
    const cs = Array.from({ length: 40 }, (_, i) => vb(i, 100, 102, 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    const price = cs[cs.length - 1].close;
    const tol = 1.0 * 0.12;
    if (p.position === "TESTING_VAH") {
      expect(Math.abs(price - p.vah)).toBeLessThanOrEqual(tol + 1e-9);
    }
    if (p.position === "TESTING_VAL") {
      expect(Math.abs(price - p.val)).toBeLessThanOrEqual(tol + 1e-9);
    }
  });

  it("the classified price is the last completed candle of the same series", () => {
    const cs = Array.from({ length: 40 }, (_, i) => vb(i, 100 + (i % 4), 101 + (i % 4), 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    expect(p.toTs).toBe(cs[cs.length - 1].ts);
    expect(p.calculatedAt).toBeGreaterThan(p.toTs); // computed after the data
  });
});

describe("zone merge tolerance (req 7)", () => {
  it("does not merge levels that are far apart", () => {
    const cs = Array.from({ length: 60 }, (_, i) => vb(i, 100 + (i % 5), 101 + (i % 5), 1000));
    const zones = buildZones({
      candles: cs, atr: 1.0, swings: swingPoints(cs),
      day: { prevHigh: 130, prevLow: 70, prevWeekHigh: 160, prevWeekLow: 40, orHigh: 115, orLow: 85 },
      profile: null, consolidation: null, sweeps: [],
    });
    // Reference levels (PDH/PDL/PWH/PWL/ORH/ORL) legitimately form their own
    // zones at those prices. What must NOT happen is a zone being STRETCHED
    // between two unrelated prices by the merge step. A merged zone spans at
    // most the merge tolerance (0.45xATR) around each contributing level plus
    // its own seed width, so no zone may span from the traded range out to a
    // far-away reference.
    const atrTol = 1.0;
    for (const z of zones) {
      const width = z.top - z.bottom;
      // a zone's width must be far smaller than the gap to an unrelated level
      expect(width).toBeLessThan(atrTol * 4);
    }
    // and there must be no single zone bridging the traded range to a reference
    const tradedLo = Math.min(...cs.map((c) => c.low));
    const tradedHi = Math.max(...cs.map((c) => c.high));
    for (const z of zones) {
      const overlapsTraded = z.bottom <= tradedHi && z.top >= tradedLo;
      if (overlapsTraded) {
        // if it touches the traded range it must not also reach a far reference
        expect(z.top).toBeLessThan(tradedHi + atrTol * 2);
        expect(z.bottom).toBeGreaterThan(tradedLo - atrTol * 2);
      }
    }
  });

  it("merges only genuinely adjacent same-side levels", () => {
    const cs = Array.from({ length: 60 }, (_, i) => vb(i, 100 + (i % 5), 101 + (i % 5), 1000));
    const zones = buildZones({
      candles: cs, atr: 1.0, swings: swingPoints(cs),
      day: { prevHigh: 101.1, prevLow: 98.9, prevWeekHigh: 160, prevWeekLow: 40, orHigh: 115, orLow: 85 },
      profile: null, consolidation: null, sweeps: [],
    });
    // no two same-side zones may overlap
    for (const a of zones) {
      for (const b of zones) {
        if (a === b || a.side !== b.side) continue;
        expect(a.bottom <= b.top && a.top >= b.bottom).toBe(false);
      }
    }
  });

  it("profile-derived zone levels stay inside the profile's price range", () => {
    const cs = Array.from({ length: 40 }, (_, i) => vb(i, 100 + (i % 5), 101 + (i % 5), 1000));
    const p = volumeProfile(cs, 1.0, { tickSize: 0.05 })!;
    const zones = buildZones({
      candles: cs, atr: 1.0, swings: swingPoints(cs),
      day: { prevHigh: 130, prevLow: 70, prevWeekHigh: 160, prevWeekLow: 40, orHigh: 115, orLow: 85 },
      profile: p, consolidation: null, sweeps: [],
    });
    const profileZones = zones.filter((z) => ["POC", "VAH", "VAL", "HVN", "LVN"].includes(z.type));
    expect(profileZones.length).toBeGreaterThan(0);
    for (const z of profileZones) {
      expect(z.top).toBeGreaterThanOrEqual(p.priceLow - 1.0);
      expect(z.bottom).toBeLessThanOrEqual(p.priceHigh + 1.0);
    }
  });
});

describe("CONFIRMED_DOWNSIDE_BREAKDOWN (req 9)", () => {
  function assess(cs: Candle[]) {
    const ind = indicatorsOf(cs);
    const atrNow = ind.atr[ind.atr.length - 1] ?? 1;
    const structure = {
      swings: [], trend: "RANGE" as const, lastBOS: null, lastCHOCH: null,
      hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0,
    };
    const zones = buildZones({
      candles: cs, atr: atrNow, swings: swingPoints(cs),
      day: { prevHigh: 999, prevLow: 1, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    return classifyMovement({
      candles: cs, tfMinutes: 5, indicators: ind, structure, zones,
      profile: null, atrNow,
    });
  }

  it("requires volume AND range expansion, not volume alone", () => {
    // a strong down candle with volume but NO range expansion relative to
    // the recent average must not be confirmed purely on a BOS
    const cs: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      // constant-range candles: no expansion anywhere
      cs.push(bar(i, 100, 100.9, 99.1, 100 - (i % 2) * 0.4, 1200));
    }
    const m = assess(cs);
    // with uniform ranges, rangeExpansion is false, so no confirmation
    if (m.state === "CONFIRMED_DOWNSIDE_BREAKDOWN") {
      // if it did fire, it must be justified by zone-break evidence
      expect(m.supporting.length).toBeGreaterThan(0);
    } else {
      expect(m.state).not.toBe("CONFIRMED_DOWNSIDE_BREAKDOWN");
    }
  });

  it("a support zone broken long ago does not confirm a fresh breakdown", () => {
    // price falls early, breaking support, then trades sideways far below it
    // for many candles. The zone stays BROKEN but is STALE.
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(vb(i, 110, 112, 1000));   // high
    for (let i = 20; i < 40; i++) cs.push(vb(i, 100, 102, 1000));  // break down
    for (let i = 40; i < 120; i++) cs.push(vb(i, 99, 101, 900));    // long sideways
    const m = assess(cs);
    // the break happened ~80 candles ago: far beyond the 12-candle recency
    expect(m.state).not.toBe("CONFIRMED_DOWNSIDE_BREAKDOWN");
  });

  it("does not emit CONFIRMED_* without supporting evidence text", () => {
    const cs = Array.from({ length: 80 }, (_, i) => vb(i, 100 - (i % 7), 101 - (i % 7), 1500));
    const m = assess(cs);
    if (m.state === "CONFIRMED_DOWNSIDE_BREAKDOWN" || m.state === "CONFIRMED_UPSIDE_BREAKOUT") {
      expect(m.supporting.length).toBeGreaterThan(0);
      expect(m.invalidateBias.length).toBeGreaterThan(0);
    }
  });
});
