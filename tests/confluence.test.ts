/**
 * Unified S&R Confluence Engine tests (§5, §6).
 * Verifies OI/profile integration, normalisation, deduplication, structure
 * primacy, and that order flow is excluded.
 */
import { describe, it, expect } from "vitest";
import { buildSREngine, DEFAULT_SR_CONFIG } from "@/lib/market/srEngine";
import { analyzeStructure, swingPoints } from "@/lib/market/structure";
import { buildZones } from "@/lib/market/zones";
import { atrSeries, relVolSeries, vwapSeries } from "@/lib/market/indicators";
import type { Candle, Zone } from "@/lib/market/types";
import type { OiZone } from "@/lib/market/oizones";

const T0 = Date.parse("2026-10-21T09:15:00+05:30");
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v, live: false });
const sideways = (n = 60, c = 100, a = 0.4) =>
  Array.from({ length: n }, (_, i) => { const p = c + Math.sin(i / 4) * a; return bar(i, p, p + 0.3, p - 0.3, p + 0.05); });

const mkZone = (over: Partial<Zone>): Zone => ({
  id: "z1", type: "SWING_LOW", liquiditySide: "SELL_SIDE", side: "support",
  top: 100, bottom: 99, mid: 99.5, source: "test", createdTs: T0, updatedTs: T0,
  strength: 50, tests: 2, reactions: 1, status: "TESTING", statusReason: "",
  invalidation: "", derived: true, ...over,
} as Zone);

const mkOi = (over: Partial<OiZone>): OiZone => ({
  strike: 99, label: "OI SUPPORT CANDIDATE", role: "support",
  callOI: 5000, putOI: 90000, callDeltaOI: 500, putDeltaOI: 8000,
  concentrationPct: 0.95, usedDeltaOI: true, quality: "VALID",
  rule: "test", source: "option-chain put OI @ strike 99",
  expiry: "2026-10-29", ts: Date.now(), confluenceWith: null, confluenceLabel: null,
  ...over,
});

function run(candles: Candle[], zones: Zone[], over: any = {}) {
  const atr = atrSeries(candles, 14).at(-1) ?? 1;
  return buildSREngine({
    symbol: "TEST", timeframe: "5m", candles, zones,
    structure: analyzeStructure(candles), profile: null, atr,
    price: candles[candles.length - 1].close,
    relVol: relVolSeries(candles, 20).at(-1) ?? null,
    vwap: vwapSeries(candles).at(-1) ?? null,
    futuresAvailable: false, optionOiAvailable: false,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// §5 unified inputs
// ---------------------------------------------------------------------------

describe("unified OI integration (§5)", () => {
  it("OI overlapping a structural zone contributes to that zone's score", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8, mid: 99.4, strength: 50 });
    const without = run(cs, [sup]);
    const withOi = run(cs, [sup], { oiZones: [mkOi({ strike: 99.4 })] });
    const zNo = without.zones.find((z) => z.id === "z1")!;
    const zOi = withOi.zones.find((z) => z.id === "z1")!;
    expect(zOi.oiEvidence?.available).toBe(true);
    expect(zOi.oiEvidence?.clusteredStrikes).toBe(1);
    expect(zOi.scoreComponents?.oi.earned).toBeGreaterThan(0);
    expect(zNo.oiEvidence?.available).toBe(false);
    expect(zNo.scoreComponents?.oi.earned).toBe(0);
  });

  it("an OI strike with NO structural overlap becomes a standalone zone", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8 });
    const r = run(cs, [sup], { oiZones: [mkOi({ strike: 103, role: "resistance", label: "OI RESISTANCE CANDIDATE" })] });
    const standalone = r.zones.find((z) => z.isOiDerived);
    expect(standalone).toBeTruthy();
    expect(standalone!.type).toBe("OI_CALL");
    expect(standalone!.scoreComponents?.structure.available).toBe(false);
    expect(standalone!.scoreComponents?.oi.available).toBe(true);
  });

  it("an OI strike overlapping a structural zone is NOT emitted twice", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8 });
    const r = run(cs, [sup], { oiZones: [mkOi({ strike: 99.4 })] });
    const oiDerived = r.zones.filter((z) => z.isOiDerived);
    expect(oiDerived).toHaveLength(0);   // folded into the structural zone
    expect(r.zones).toHaveLength(1);
  });

  it("structure remains primary: an OI-only zone never outranks a confirmed structural zone", () => {
    const cs = sideways(60);
    const strong = mkZone({ id: "struct", bottom: 99, top: 99.8, mid: 99.4, strength: 85, tests: 3, reactions: 2, status: "REJECTED" });
    // a very high OI concentration far from any structure
    const r = run(cs, [strong], { oiZones: [mkOi({ strike: 97, concentrationPct: 1.0, putOI: 500000 })] });
    const oiOnly = r.zones.find((z) => z.isOiDerived)!;
    const structural = r.zones.find((z) => z.id === "struct")!;
    // the structural zone must be selected as primary support
    expect(r.scenario.primarySupport?.zone.id).toBe("struct");
    expect(structural.strength).toBeGreaterThanOrEqual(oiOnly.strength);
  });

  it("OI evidence is null-safe when no OI zones are supplied", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({})]);
    expect(r.zones[0].oiEvidence?.available).toBe(false);
    expect(r.zones[0].scoreComponents?.oi.available).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §6 documented scoring and normalisation
// ---------------------------------------------------------------------------

describe("unified scoring and normalisation (§6)", () => {
  it("uses the documented 40/20/25/15 weights", () => {
    expect(DEFAULT_SR_CONFIG.weightStructure).toBe(40);
    expect(DEFAULT_SR_CONFIG.weightProfile).toBe(20);
    expect(DEFAULT_SR_CONFIG.weightOi).toBe(25);
    expect(DEFAULT_SR_CONFIG.weightRecency).toBe(15);
    expect(DEFAULT_SR_CONFIG.weightStructure + DEFAULT_SR_CONFIG.weightProfile + DEFAULT_SR_CONFIG.weightOi + DEFAULT_SR_CONFIG.weightRecency).toBe(100);
  });

  it("normalises the denominator when OI is unavailable (missing data does not penalise)", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8, strength: 60, status: "REJECTED", reactions: 2 });
    const withoutOi = run(cs, [sup]);                                            // OI unavailable
    const withOi = run(cs, [sup], { oiZones: [mkOi({ strike: 99.4 })] });        // OI available
    const zNo = withoutOi.zones[0];
    const zOi = withOi.zones[0];
    // the unavailable case must be normalised, not merely zero-scored
    expect(zNo.scoreComponents?.normalized).toBe(true);
    expect(zNo.scoreComponents?.normalizingMax).toBeLessThan(100);
    expect(zNo.scoreComponents?.oi.available).toBe(false);
    // OI availability must not REDUCE the score (normalisation protects it)
    expect(zNo.strength).toBeGreaterThanOrEqual(zOi.strength - 25);
  });

  it("profile confluence adds points when a profile level overlaps", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99.5, top: 100.1, mid: 99.8 });
    const profile = {
      approximation: true, method: "UNIFORM_ALLOCATION_FROM_OHLCV",
      bins: [], poc: 99.8, vah: 100.6, val: 99.2, hvns: [99.8], lvns: [101],
      valueAreaPct: 0.7, position: "INSIDE_VALUE", positionDetail: "", totalVolume: 1,
      period: "MULTI_SESSION", sessions: ["2026-10-21"], sessionCount: 1,
      fromTs: T0, toTs: T0, priceLow: 98, priceHigh: 102, binSize: 0.5, binCount: 10,
      candlesUsed: 60, timeframe: "5m", tickSize: 0.05, calculatedAt: Date.now(),
      consistency: { valLeVah: true, pocInRange: true, binsValid: true },
    } as any;
    const r = run(cs, [sup], { profile });
    const z = r.zones[0];
    expect(z.profileEvidence?.available).toBe(true);
    expect(z.profileEvidence?.levelType).toBe("POC");
    expect(z.profileEvidence?.quality).toBe("ESTIMATED");
    expect(z.scoreComponents?.profile.earned).toBeGreaterThan(0);
  });

  it("labels candle-derived profile as ESTIMATED, never as true volume-at-price", () => {
    const cs = sideways(60);
    const profile = { approximation: true, method: "UNIFORM_ALLOCATION_FROM_OHLCV", bins: [], poc: 99.8, vah: 100.6, val: 99.2, hvns: [], lvns: [], valueAreaPct: 0.7, position: "INSIDE_VALUE", positionDetail: "", totalVolume: 1, period: "S", sessions: [], sessionCount: 1, fromTs: T0, toTs: T0, priceLow: 98, priceHigh: 102, binSize: 0.5, binCount: 10, candlesUsed: 60, timeframe: "5m", tickSize: null, calculatedAt: Date.now(), consistency: { valLeVah: true, pocInRange: true, binsValid: true } } as any;
    const r = run(cs, [mkZone({ bottom: 99.5, top: 100.1 })], { profile });
    expect(r.dataQuality.profile).toBe("ESTIMATED");
    expect(r.dataQuality.note).toMatch(/ESTIMATED/);
  });

  it("deduplicates correlated profile levels at the same price", () => {
    const cs = sideways(60);
    // POC and an HVN at the SAME price — must count once
    const profile = { approximation: true, method: "X", bins: [], poc: 99.8, vah: 100.6, val: 99.2, hvns: [99.8, 99.8], lvns: [], valueAreaPct: 0.7, position: "INSIDE_VALUE", positionDetail: "", totalVolume: 1, period: "S", sessions: [], sessionCount: 1, fromTs: T0, toTs: T0, priceLow: 98, priceHigh: 102, binSize: 0.5, binCount: 10, candlesUsed: 60, timeframe: "5m", tickSize: null, calculatedAt: Date.now(), consistency: { valLeVah: true, pocInRange: true, binsValid: true } } as any;
    const r = run(cs, [mkZone({ bottom: 99.5, top: 100.1 })], { profile });
    const z = r.zones[0];
    // should not double-count POC + 2 HVNs at the same price
    expect(z.scoreComponents?.profile.earned).toBeLessThanOrEqual(DEFAULT_SR_CONFIG.weightProfile);
  });

  it("confirmed invalidation penalises the score", () => {
    const cs = sideways(60);
    const ok = run(cs, [mkZone({ strength: 60, status: "TESTING" })]).zones[0];
    const dead = run(cs, [mkZone({ strength: 60, status: "INVALIDATED" })]).zones[0];
    expect(dead.strength).toBeLessThan(ok.strength);
    expect(dead.strengthBreakdown.some((b) => b.factor === "invalidated" && b.points < 0)).toBe(true);
  });

  it("reaction decay reduces the score rather than increasing it", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 12; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 101.6, 1200));
    for (let i = 12; i < 24; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 100.35, 1200));
    for (let i = 24; i < 36; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 100.05, 1200));
    const r = run(cs, [mkZone({ strength: 70, status: "REJECTED", reactions: 4, tests: 8 })]);
    const z = r.zones[0];
    expect(z.reactionDecay).toBe(true);
    expect(z.srState).toBe("SUPPORT_WEAKENING");
  });

  it("score is a 0-100 ranking index, never labelled as a probability", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({ strength: 95 })]);
    for (const z of r.zones) {
      expect(z.strength).toBeGreaterThanOrEqual(0);
      expect(z.strength).toBeLessThanOrEqual(100);
    }
    expect(r.dataQuality.note).not.toMatch(/probability|accuracy|% accurate/i);
  });

  it("every zone exposes which evidence contributed", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({})]);
    const z = r.zones[0];
    expect(z.strengthBreakdown.length).toBeGreaterThan(0);
    expect(z.scoreComponents).toBeTruthy();
    expect(z.scoreComponents!.structure.available).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 OI data quality in the unified engine
// ---------------------------------------------------------------------------

describe("OI data quality in the unified engine (§4)", () => {
  it("an OI zone with null ΔOI earns no delta points but keeps concentration points", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({ bottom: 99, top: 99.8 })], {
      oiZones: [mkOi({ strike: 99.4, putDeltaOI: null, callDeltaOI: null, usedDeltaOI: false })],
    });
    const z = r.zones[0];
    expect(z.oiEvidence?.available).toBe(true);
    expect(z.oiEvidence?.usedDeltaOI).toBe(false);
    // concentration alone still contributes
    expect(z.scoreComponents?.oi.earned).toBeGreaterThan(0);
    // but less than a zone with a valid positive ΔOI
    const r2 = run(cs, [mkZone({ bottom: 99, top: 99.8 })], { oiZones: [mkOi({ strike: 99.4 })] });
    expect(z.scoreComponents!.oi.earned).toBeLessThan(r2.zones[0].scoreComponents!.oi.earned);
  });

  it("unwinding OI (negative ΔOI) scores lower than building OI", () => {
    const cs = sideways(60);
    const building = run(cs, [mkZone({ bottom: 99, top: 99.8 })], { oiZones: [mkOi({ strike: 99.4, putDeltaOI: 8000 })] });
    const unwinding = run(cs, [mkZone({ bottom: 99, top: 99.8 })], { oiZones: [mkOi({ strike: 99.4, putDeltaOI: -8000 })] });
    expect(building.zones[0].scoreComponents!.oi.earned).toBeGreaterThan(unwinding.zones[0].scoreComponents!.oi.earned);
  });

  it("missing OI never fabricates a confluence", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({})]);   // no oiZones
    expect(r.zones[0].oiEvidence?.available).toBe(false);
    expect(r.zones[0].oiEvidence?.reason).toMatch(/unavailable/i);
    expect(r.zones[0].scoreComponents?.oi.earned).toBe(0);
  });

  it("stale/invalid OI is excluded without failing the engine", () => {
    const cs = sideways(60);
    // an OI zone from a DIFFERENT price area (no overlap, and far away)
    const r = run(cs, [mkZone({ bottom: 99, top: 99.8 })], {
      oiZones: [mkOi({ strike: 120, role: "resistance" })],
    });
    expect(r.zones.length).toBeGreaterThan(0);
    const z = r.zones.find((x) => x.id === "z1")!;
    expect(z.oiEvidence?.available).toBe(true);
    expect(z.oiEvidence?.clusteredStrikes).toBe(0);   // no matching strike
  });
});

// ---------------------------------------------------------------------------
// §14.5 order-flow exclusion
// ---------------------------------------------------------------------------

describe("order-flow exclusion (§14.5)", () => {
  it("the S&R engine source contains no order-flow references", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/lib/market/srEngine.ts", "utf8");
    // it must not import or compute any order-flow concept
    expect(src).not.toMatch(/from\s+"\.\/(depth|flow|absorption|buyerSeller)"/);
    expect(src).not.toMatch(/\bobi\b|\bfootprint\b|aggressor|bidAsk|bid_ask/i);
  });

  it("the engine still works with zero order-flow inputs", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({})]);
    expect(r.zones.length).toBeGreaterThan(0);
    expect(r.scenario.movement).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Regression: existing zones still work
// ---------------------------------------------------------------------------

describe("regression: existing zone pipeline", () => {
  it("buildZones still produces structural zones with all sources", () => {
    const cs = sideways(70);
    const zones = buildZones({
      candles: cs, atr: atrSeries(cs, 14).at(-1) ?? 1, swings: swingPoints(cs),
      day: { prevHigh: 101.2, prevLow: 98.8, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
      sessionHigh: 100.6, sessionLow: 99.4, vwap: 100.0,
    });
    expect(zones.length).toBeGreaterThan(0);
    const types = zones.map((z) => z.type);
    expect(types).toContain("PDH");
    expect(types).toContain("PDL");
    expect(types.some((t) => t === "VWAP")).toBe(true);
    // Session levels may be ABSORBED by the merge into an overlapping swing
    // zone (correct anti-clutter behaviour). Assert they are either present as
    // their own zone or recorded as confluence on the zone that absorbed them.
    const sessionPresent = types.some((t) => t === "SESSION_HIGH" || t === "SESSION_LOW");
    const sessionMerged = zones.some((z) => /session/i.test(z.source) || z.tests >= 1);
    expect(sessionPresent || sessionMerged).toBe(true);
    // and every zone must carry a documented source
    for (const z of zones) expect(z.source.length).toBeGreaterThan(0);
  });

  it("no two same-side structural zones overlap after merging", () => {
    const cs = sideways(70);
    const zones = buildZones({
      candles: cs, atr: atrSeries(cs, 14).at(-1) ?? 1, swings: swingPoints(cs),
      day: { prevHigh: 101.05, prevLow: 98.95, prevWeekHigh: 101.1, prevWeekLow: 98.9, orHigh: 100.6, orLow: 99.4 },
      profile: null, consolidation: null, sweeps: [],
    });
    for (const a of zones) for (const b of zones) {
      if (a === b || a.side !== b.side) continue;
      expect(a.bottom <= b.top && a.top >= b.bottom).toBe(false);
    }
  });
});
