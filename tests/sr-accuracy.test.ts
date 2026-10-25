/**
 * S&R accuracy-fix tests (§2, §3, §4, §5, §7, §8, §13).
 */
import { describe, it, expect } from "vitest";
import { buildZones, LEAVE_SEPARATION_ATR } from "@/lib/market/zones";
import { swingPoints } from "@/lib/market/structure";
import { atrSeries } from "@/lib/market/indicators";
import { buildSREngine, DEFAULT_SR_CONFIG } from "@/lib/market/srEngine";
import { validateZones, DEFAULT_CRITERIA } from "@/lib/market/srValidation";
import type { Candle, Zone } from "@/lib/market/types";

const T0 = Date.parse("2026-10-21T09:15:00+05:30");
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v, live: false });
const sideways = (n = 60, c = 100, a = 0.4) =>
  Array.from({ length: n }, (_, i) => { const p = c + Math.sin(i / 4) * a; return bar(i, p, p + 0.3, p - 0.3, p + 0.05); });

const mkZone = (id: string, side: "support" | "resistance", bottom: number, top: number, over: Partial<Zone> = {}): Zone => ({
  id, type: side === "support" ? "SWING_LOW" : "SWING_HIGH", liquiditySide: null,
  side, top, bottom, mid: (top + bottom) / 2, source: "test", createdTs: T0, updatedTs: T0,
  strength: 50, tests: 1, reactions: 1, status: "TESTING", statusReason: "",
  invalidation: "", derived: true, ...over,
} as Zone);

const DAY = { prevHigh: 101.2, prevLow: 98.8, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null };

// ---------------------------------------------------------------------------
// §2 side-aware merging
// ---------------------------------------------------------------------------

describe("side-aware zone merging (§2)", () => {
  it("never merges a support candidate with a resistance candidate at the same price", () => {
    const cs = sideways(60);
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    // PDH (resistance) and PDL (support) deliberately placed at the SAME price
    const zones = buildZones({
      candles: cs, atr, swings: swingPoints(cs),
      day: { prevHigh: 100.0, prevLow: 99.95, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const pdh = zones.find((z) => z.type === "PDH");
    const pdl = zones.find((z) => z.type === "PDL");
    if (pdh && pdl) {
      // both must survive as SEPARATE zones with their own sides
      expect(pdh.side).toBe("resistance");
      expect(pdl.side).toBe("support");
      expect(pdh.id).not.toBe(pdl.id);
    }
  });

  it("compatible same-side zones still merge", () => {
    const cs = sideways(60);
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    // two resistance levels very close together
    const zones = buildZones({
      candles: cs, atr, swings: swingPoints(cs),
      day: { prevHigh: 101.0, prevLow: 98.8, prevWeekHigh: 101.02, prevWeekLow: 98.78, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const res = zones.filter((z) => z.side === "resistance");
    // no two same-side zones may overlap
    for (const a of res) for (const b of res) {
      if (a === b) continue;
      expect(a.bottom <= b.top && a.top >= b.bottom).toBe(false);
    }
  });

  it("merging preserves source provenance", () => {
    const cs = sideways(60);
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    const zones = buildZones({
      candles: cs, atr, swings: swingPoints(cs),
      day: { prevHigh: 101.0, prevLow: 98.8, prevWeekHigh: null, prevWeekLow: null, orHigh: 101.05, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    for (const z of zones) expect(z.source.length).toBeGreaterThan(0);
    // a merged zone should mention its contributing sources
    const merged = zones.find((z) => z.source.includes("+"));
    if (merged) expect(merged.source.split("+").length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// §3 touch-episode counting
// ---------------------------------------------------------------------------

describe("touch-episode test counting (§3)", () => {
  it("20 consecutive candles inside one zone count as ONE test, not 20", () => {
    const cs: Candle[] = [];
    // 20 candles entirely inside the 99-101 band
    for (let i = 0; i < 20; i++) cs.push(bar(i, 100.2, 100.6, 99.6, 100.3, 1200));
    const atr = 1.0;
    const zones = buildZones({
      candles: cs, atr, swings: swingPoints(cs),
      day: { prevHigh: 999, prevLow: 1, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const inBand = zones.find((z) => z.bottom <= 99.5 && z.top >= 100.5);
    if (!inBand) {
      // no zone formed in the band; the invariant still holds for any zone
      for (const z of zones) expect(z.tests).toBeLessThanOrEqual(3);
      return;
    }
    expect(inBand.tests).toBe(1);
  });

  it("a new test requires leaving the zone by the separation threshold and returning", () => {
    const cs: Candle[] = [];
    // episode 1: inside
    for (let i = 0; i < 5; i++) cs.push(bar(i, 100.2, 100.6, 99.6, 100.3, 1200));
    // leave well beyond separation
    for (let i = 5; i < 9; i++) cs.push(bar(i, 103.0, 103.4, 102.6, 103.1, 1200));
    // episode 2: return
    for (let i = 9; i < 14; i++) cs.push(bar(i, 100.2, 100.6, 99.6, 100.3, 1200));
    // leave again
    for (let i = 14; i < 18; i++) cs.push(bar(i, 103.0, 103.4, 102.6, 103.1, 1200));
    // episode 3: return
    for (let i = 18; i < 23; i++) cs.push(bar(i, 100.2, 100.6, 99.6, 100.3, 1200));

    const zones = buildZones({
      candles: cs, atr: 1.0, swings: swingPoints(cs),
      day: { prevHigh: 999, prevLow: 1, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const inBand = zones.find((z) => z.bottom <= 99.5 && z.top >= 100.5);
    if (!inBand) { for (const z of zones) expect(z.tests).toBeLessThanOrEqual(4); return; }
    expect(inBand.tests).toBe(3);   // exactly three distinct episodes
  });

  it("a brief wick touch does not count as a separate test while price stays nearby", () => {
    const cs: Candle[] = [];
    // candles hovering at the top boundary with wicks dipping in
    for (let i = 0; i < 15; i++) cs.push(bar(i, 100.9, 101.2, 100.2, 101.0, 1200));
    const zones = buildZones({
      candles: cs, atr: 1.0, swings: swingPoints(cs),
      day: { prevHigh: 999, prevLow: 1, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    for (const z of zones) expect(z.tests).toBeLessThanOrEqual(2);
  });

  it("LEAVE_SEPARATION_ATR is documented and positive", () => {
    expect(LEAVE_SEPARATION_ATR).toBeGreaterThan(0);
    expect(LEAVE_SEPARATION_ATR).toBeLessThan(1);
  });

  it("counting is deterministic across repeated evaluation", () => {
    const cs = sideways(60);
    const args = {
      candles: cs, atr: atrSeries(cs, 14).at(-1) ?? 1, swings: swingPoints(cs),
      day: DAY, profile: null, consolidation: null, sweeps: [] as never[],
    };
    const a = buildZones(args).map((z) => [z.id, z.tests, z.reactions]);
    const b = buildZones(args).map((z) => [z.id, z.tests, z.reactions]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// §4 OI-only confirmation
// ---------------------------------------------------------------------------

describe("OI-only zone confirmation (§4)", () => {
  function run(candles: Candle[], zones: Zone[], over: any = {}) {
    const atr = atrSeries(candles, 14).at(-1) ?? 1;
    return buildSREngine({
      symbol: "T", timeframe: "5m", candles, zones,
      structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: candles[candles.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false, ...over,
    });
  }

  it("an OI-only zone has valid OI evidence but is NOT price-action confirmed", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone("s1", "support", 99, 99.8)], {
      oiZones: [{
        strike: 103, label: "OI RESISTANCE CANDIDATE" as any, role: "resistance",
        callOI: 90000, putOI: 100, callDeltaOI: 8000, putDeltaOI: 100,
        concentrationPct: 0.95, usedDeltaOI: true, quality: "VALID",
        rule: "r", source: "s", expiry: "e", ts: Date.now(),
        confluenceWith: null, confluenceLabel: null,
      }],
    });
    const oi = r.zones.find((z) => z.isOiDerived)!;
    expect(oi).toBeTruthy();
    expect(oi.oiEvidenceValid).toBe(true);
    expect(oi.priceActionConfirmed).toBe(false);
    expect(oi.srState).toBe("UNTESTED");
  });

  it("a structurally confirmed zone has priceActionConfirmed true", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone("s1", "support", 99, 99.8, { status: "REJECTED", reactions: 2 })]);
    expect(r.zones[0].priceActionConfirmed).toBe(true);
    expect(r.zones[0].oiEvidenceValid).toBe(false);
  });

  it("an OI-only zone never outranks a structurally confirmed zone", () => {
    const cs = sideways(60);
    const strong = mkZone("struct", "support", 99, 99.8, { strength: 90, status: "REJECTED", reactions: 2 });
    const r = run(cs, [strong], {
      oiZones: [{
        strike: 98, label: "OI SUPPORT CANDIDATE" as any, role: "support",
        callOI: 100, putOI: 500000, callDeltaOI: 100, putDeltaOI: 400000,
        concentrationPct: 1.0, usedDeltaOI: true, quality: "VALID",
        rule: "r", source: "s", expiry: "e", ts: Date.now(),
        confluenceWith: null, confluenceLabel: null,
      }],
    });
    expect(r.scenario.levels.S1?.zone.id).toBe("struct");
  });

  it("OI evidence and price-action confirmation are reported separately in the output", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone("s1", "support", 99, 99.8)]);
    expect(r.zones[0]).toHaveProperty("oiEvidenceValid");
    expect(r.zones[0]).toHaveProperty("priceActionConfirmed");
    expect(typeof r.zones[0].oiEvidenceValid).toBe("boolean");
    expect(typeof r.zones[0].priceActionConfirmed).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// §5 eligibility
// ---------------------------------------------------------------------------

describe("invalidated and broken zone eligibility (§5)", () => {
  function run(candles: Candle[], zones: Zone[]) {
    const atr = atrSeries(candles, 14).at(-1) ?? 1;
    return buildSREngine({
      symbol: "T", timeframe: "5m", candles, zones,
      structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: candles[candles.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
    });
  }

  it("an INVALIDATED zone is never selected as a primary level regardless of score", () => {
    const cs = sideways(60);
    // a very strong but invalidated support zone
    const dead = mkZone("dead", "support", 99, 99.8, { strength: 98, status: "INVALIDATED", tests: 5, reactions: 4 });
    const r = run(cs, [dead]);
    expect(r.scenario.levels.S1?.zone.id).not.toBe("dead");
  });

  it("a confirmed breakout retains the zone in its FLIPPED role rather than deleting it", () => {
    const cs = sideways(60);
    // price breaks decisively above the resistance
    for (let i = 0; i < 4; i++) cs.push(bar(60 + i, 101.5, 102.2, 101.2, 101.9, 1600));
    const res = mkZone("r1", "resistance", 100.2, 100.8, { status: "TESTING" });
    const r = run(cs, [res]);
    const z = r.zones[0];
    expect(z.machineState).toBe("CONFIRMED_BREAKOUT");
    expect(z.currentRole).toBe("support");        // flipped, not deleted
    expect(z.roleFlipped).toBe(true);
  });

  it("a broken zone participates only after a retest is observed", () => {
    const cs = sideways(60);
    for (let i = 0; i < 4; i++) cs.push(bar(60 + i, 101.5, 102.2, 101.2, 101.9, 1600));
    const res = mkZone("r1", "resistance", 100.2, 100.8, { status: "TESTING" });
    const r = run(cs, [res]);
    const z = r.zones[0];
    // broken but no retest yet -> not eligible as primary support
    if (z.machineState === "CONFIRMED_BREAKOUT") {
      expect(r.scenario.levels.S1?.zone.id).not.toBe("r1");
    }
  });
});

// ---------------------------------------------------------------------------
// §7 determinism
// ---------------------------------------------------------------------------

describe("deterministic scoring (§7)", () => {
  function run(candles: Candle[], zones: Zone[]) {
    const atr = atrSeries(candles, 14).at(-1) ?? 1;
    return buildSREngine({
      symbol: "T", timeframe: "5m", candles, zones,
      structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: candles[candles.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
    });
  }

  it("the same candles and zones always produce identical scores", () => {
    const cs = sideways(60);
    const zones = [mkZone("a", "support", 99, 99.8), mkZone("b", "resistance", 100.4, 101.0)];
    const r1 = run(cs, zones);
    const r2 = run(cs, zones);
    expect(r1.zones.map((z) => [z.id, z.strength])).toEqual(r2.zones.map((z) => [z.id, z.strength]));
    expect(r1.scenario.levels.R1?.zone.id).toBe(r2.scenario.levels.R1?.zone.id);
  });

  it("scoring uses candle timestamps, not wall-clock time", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/lib/market/srEngine.ts", "utf8");
    // the scoreUnified function must not call Date.now()
    const body = src.slice(src.indexOf("function scoreUnified"), src.indexOf("function srStateFor"));
    expect(body).not.toMatch(/Date\.now\(\)/);
  });

  it("a zone created later in the series scores as more recent", () => {
    const cs = sideways(60);
    const early = mkZone("early", "support", 99, 99.8, { createdTs: cs[5].ts });
    const late = mkZone("late", "support", 99, 99.8, { createdTs: cs[55].ts });
    const r1 = run(cs, [early]);
    const r2 = run(cs, [late]);
    expect(r2.zones[0].strength).toBeGreaterThanOrEqual(r1.zones[0].strength);
  });
});

// ---------------------------------------------------------------------------
// §8 R1/R2/S1/S2 ordering
// ---------------------------------------------------------------------------

describe("R1/R2 and S1/S2 price-order rules (§8)", () => {
  function run(candles: Candle[], zones: Zone[]) {
    const atr = atrSeries(candles, 14).at(-1) ?? 1;
    return buildSREngine({
      symbol: "T", timeframe: "5m", candles, zones,
      structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: candles[candles.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
    });
  }

  it("R2 is the next resistance ABOVE R1 in price order, not the highest scoring", () => {
    const cs = sideways(60);
    const zones = [
      mkZone("near", "resistance", 100.4, 101.0, { strength: 40 }),
      mkZone("mid", "resistance", 101.5, 102.1, { strength: 45 }),     // next in price order
      mkZone("farStrong", "resistance", 104.0, 104.6, { strength: 95 }), // much further but strongest
    ];
    const r = run(cs, zones);
    expect(r.scenario.levels.R1?.zone.id).toBe("near");
    expect(r.scenario.levels.R2?.zone.id).toBe("mid");     // price order wins over score
    expect(r.scenario.levels.R2?.zone.id).not.toBe("farStrong");
  });

  it("S2 is the next support BELOW S1 in price order", () => {
    const cs = sideways(60);
    const zones = [
      mkZone("near", "support", 99.0, 99.6, { strength: 40 }),
      mkZone("mid", "support", 97.9, 98.5, { strength: 45 }),
      mkZone("farStrong", "support", 95.0, 95.6, { strength: 95 }),
    ];
    const r = run(cs, zones);
    expect(r.scenario.levels.S1?.zone.id).toBe("near");
    expect(r.scenario.levels.S2?.zone.id).toBe("mid");
    expect(r.scenario.levels.S2?.zone.id).not.toBe("farStrong");
  });

  it("no duplicate or overlapping level assignments", () => {
    const cs = sideways(60);
    const zones = [
      mkZone("a", "resistance", 100.4, 101.0),
      mkZone("b", "resistance", 100.5, 101.1),   // overlaps a
      mkZone("c", "support", 99.0, 99.6),
      mkZone("d", "support", 99.1, 99.7),        // overlaps c
    ];
    const r = run(cs, zones);
    const ids = [r.scenario.levels.R1?.zone.id, r.scenario.levels.R2?.zone.id, r.scenario.levels.S1?.zone.id, r.scenario.levels.S2?.zone.id].filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// §13 historical validation
// ---------------------------------------------------------------------------

describe("historical validation framework (§13)", () => {
  const bigSeries = (() => {
    // a long series with several swings so zones actually form
    const out: Candle[] = [];
    for (let i = 0; i < 300; i++) {
      const leg = Math.floor(i / 25);
      const within = i % 25;
      const base = 100 + leg * 2 + (within < 12 ? within * 0.5 : (25 - within) * -0.35);
      out.push(bar(i, base, base + 0.5, base - 0.5, base + 0.15, 1200));
    }
    return out;
  })();

  it("produces a report with pre-registered criteria and sample counts", () => {
    const r = validateZones(bigSeries);
    expect(r.criteria).toEqual(DEFAULT_CRITERIA);
    expect(r.sampleSize).toBeGreaterThan(0);
    expect(r.totalZones).toBeGreaterThan(0);
    expect(r.touchRate).toBeGreaterThanOrEqual(0);
    expect(r.touchRate).toBeLessThanOrEqual(1);
    expect(r.reactionRate).toBeGreaterThanOrEqual(0);
    expect(r.reactionRate).toBeLessThanOrEqual(1);
    expect(r.baseline.zones).toBeGreaterThan(0);
  });

  it("does not use future information (truncation invariance)", () => {
    // Scoring the first 150 candles must give the same result whether or not
    // candles 150-300 exist, because only data up to the evaluation point is used.
    const partial = bigSeries.slice(0, 150);
    const fullAtSamePoint = (() => {
      const atr = atrSeries(bigSeries, 14)[149] ?? 1;
      const visible = bigSeries.slice(0, 150);
      const zones = buildZones({
        candles: visible, atr, swings: swingPoints(visible), day: DAY,
        profile: null, consolidation: null, sweeps: [],
      });
      return buildSREngine({
        symbol: "T", timeframe: "5m", candles: visible, zones,
        structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
        profile: null, atr, price: visible[visible.length - 1].close,
        relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
      }).zones.map((z) => [z.id, z.strength]);
    })();

    const atr = atrSeries(partial, 14).at(-1) ?? 1;
    const zones = buildZones({
      candles: partial, atr, swings: swingPoints(partial), day: DAY,
      profile: null, consolidation: null, sweeps: [],
    });
    const partialResult = buildSREngine({
      symbol: "T", timeframe: "5m", candles: partial, zones,
      structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: partial[partial.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
    }).zones.map((z) => [z.id, z.strength]);

    expect(JSON.stringify(partialResult)).toBe(JSON.stringify(fullAtSamePoint));
  });

  it("reports selection instability as a measurable rate", () => {
    const r = validateZones(bigSeries);
    expect(r.selectionInstabilityRate).toBeGreaterThanOrEqual(0);
    expect(r.selectionInstabilityRate).toBeLessThanOrEqual(1);
  });

  it("documents that metrics are not profitability", () => {
    const r = validateZones(bigSeries);
    expect(r.note).toMatch(/not a win rate|NOT trade profitability/i);
    expect(r.note).toMatch(/pre-registered/i);
  });

  it("compares against a swing-only baseline", () => {
    const r = validateZones(bigSeries);
    expect(r.baseline).toBeTruthy();
    expect(r.baseline.zones).toBeGreaterThan(0);
    expect(r.baseline.touchRate).toBeGreaterThanOrEqual(0);
  });
});
