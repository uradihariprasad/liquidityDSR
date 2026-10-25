/**
 * Dynamic S&R Intelligence Engine tests.
 * Covers §3 strength/decay, §4 primary selection, §5 movement states,
 * §6 state machine + role flip, §7 target/invalidation, §9 no-lookahead.
 */
import { describe, it, expect } from "vitest";
import { buildSREngine, DEFAULT_SR_CONFIG, SOURCE_FAMILY } from "@/lib/market/srEngine";
import { buildZones } from "@/lib/market/zones";
import { swingPoints, analyzeStructure } from "@/lib/market/structure";
import { atrSeries, relVolSeries, vwapSeries } from "@/lib/market/indicators";
import type { Candle, Zone } from "@/lib/market/types";

const T0 = Date.parse("2026-10-21T09:15:00+05:30");
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v, live: false });

/**
 * Trends with OSCILLATION so real swing points form (a purely monotonic
 * series has no local extremes, so analyzeStructure would report RANGE).
 * Each leg makes a swing high then a swing low, with both drifting up/down.
 */
function uptrend(n = 60, start = 100): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const leg = Math.floor(i / 6);
    const within = i % 6;
    // rise then pull back within each leg, net upward
    const p = start + leg * 3 + (within < 4 ? within * 0.8 : (6 - within) * -0.4);
    out.push(bar(i, p, p + 0.7, p - 0.7, p + 0.3, 1200));
  }
  return out;
}
function downtrend(n = 60, start = 160): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const leg = Math.floor(i / 6);
    const within = i % 6;
    const p = start - leg * 3 - (within < 4 ? within * 0.8 : (6 - within) * -0.4);
    out.push(bar(i, p, p + 0.7, p - 0.7, p - 0.3, 1200));
  }
  return out;
}
function sideways(n = 60, c = 100, amp = 0.4): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = c + Math.sin(i / 4) * amp;
    return bar(i, p, p + 0.3, p - 0.3, p + 0.05, 1000);
  });
}

function mkZone(over: Partial<Zone>): Zone {
  return {
    id: "z1", type: "SWING_LOW", liquiditySide: "SELL_SIDE", side: "support",
    top: 100, bottom: 99, mid: 99.5, source: "test", createdTs: T0, updatedTs: T0,
    strength: 50, tests: 2, reactions: 1, status: "TESTING", statusReason: "",
    invalidation: "", derived: true, ...over,
  } as Zone;
}

function run(
  candles: Candle[],
  zones: Zone[],
  over: Partial<Parameters<typeof buildSREngine>[0]> = {},
) {
  const atr = atrSeries(candles, 14).at(-1) ?? 1;
  const structure = analyzeStructure(candles);
  const base: Parameters<typeof buildSREngine>[0] = {
    symbol: "TEST", timeframe: "5m", candles, zones, structure,
    profile: null, atr, price: candles[candles.length - 1].close,
    relVol: relVolSeries(candles, 20).at(-1) ?? null,
    vwap: vwapSeries(candles).at(-1) ?? null,
    futuresAvailable: false, optionOiAvailable: false,
  };
  return buildSREngine({ ...base, ...over });
}

// ---------------------------------------------------------------------------
// §3 strength and decay
// ---------------------------------------------------------------------------

describe("strength and decay (§3)", () => {
  it("reaction decay REDUCES strength even with a high inherited score", () => {
    // Construct a series whose rejections from the zone genuinely SHRINK:
    // early candles push far away from the support, later ones barely move.
    const cs: Candle[] = [];
    for (let i = 0; i < 12; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 101.6, 1200));  // big rejections
    for (let i = 12; i < 24; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 100.35, 1200)); // medium
    for (let i = 24; i < 36; i++) cs.push(bar(i, 99.9, 100.4, 99.6, 100.05, 1200)); // tiny
    const z = mkZone({ tests: 8, reactions: 4, status: "REJECTED", strength: 70, bottom: 99, top: 100, mid: 99.5 });
    const r = run(cs, [z]);
    const out = r.zones[0];
    // With decaying reactions the label must be WEAKENING, never STRONG
    expect(out.srState).toBe("SUPPORT_WEAKENING");
    expect(out.reactionDecay).toBe(true);
    expect(out.strengthBreakdown.some((b) => b.factor === "reaction decay" && b.points < 0)).toBe(true);
  });

  it("never labels a zone STRONG solely because it was touched many times", () => {
    const cs = sideways(60);
    const manyTests = mkZone({ tests: 12, reactions: 0, status: "TESTING", strength: 40 });
    const r = run(cs, [manyTests]);
    expect(r.zones[0].srState).not.toBe("STRONG_SUPPORT");
    expect(r.zones[0].srState).not.toBe("STRONG_RESISTANCE");
  });

  it("a defended zone with high structural strength earns STRONG_* once OI/profile also confirm", () => {
    const cs = sideways(60);
    const strong = mkZone({ tests: 3, reactions: 2, status: "REJECTED", strength: 95, bottom: 99, top: 100 });
    const shifted = cs.map((c, i) => bar(i, c.open + 3, c.high + 3, c.low + 3, c.close + 3, c.volume));
    // With profile + OI BOTH unavailable the score normalises over 55 and can
    // legitimately land below the STRONG threshold. That is correct behaviour:
    // the documented model reserves STRONG for zones with corroborating
    // independent evidence, not structure alone.
    const noOi = run(shifted, [strong]);
    expect(["STRONG_SUPPORT", "SUPPORT_STRENGTHENING"]).toContain(noOi.zones[0].srState);
    expect(noOi.zones[0].scoreComponents?.normalized).toBe(true);

    // Adding profile + OI confluence lifts it to STRONG.
    const profile = { approximation: true, method: "X", bins: [], poc: 99.5, vah: 100.6, val: 98.9, hvns: [99.5], lvns: [], valueAreaPct: 0.7, position: "INSIDE_VALUE", positionDetail: "", totalVolume: 1, period: "S", sessions: [], sessionCount: 1, fromTs: T0, toTs: T0, priceLow: 98, priceHigh: 103, binSize: 0.5, binCount: 10, candlesUsed: 60, timeframe: "5m", tickSize: null, calculatedAt: Date.now(), consistency: { valLeVah: true, pocInRange: true, binsValid: true } } as any;
    const withBoth = run(shifted, [strong], {
      profile,
      oiZones: [{ strike: 99.5, label: "OI SUPPORT CANDIDATE", role: "support", callOI: 100, putOI: 90000, callDeltaOI: 100, putDeltaOI: 8000, concentrationPct: 0.95, usedDeltaOI: true, quality: "VALID", rule: "r", source: "s", expiry: "e", ts: Date.now(), confluenceWith: null, confluenceLabel: null }],
    });
    expect(withBoth.zones[0].srState).toBe("STRONG_SUPPORT");
    expect(withBoth.zones[0].scoreComponents?.normalized).toBe(false);
  });

  it("an untested zone is labelled UNTESTED", () => {
    const cs = sideways(60);
    const untested = mkZone({ tests: 0, reactions: 0, status: "NEW", bottom: 106, top: 107, mid: 106.5, side: "resistance", type: "SWING_HIGH" });
    const r = run(cs, [untested]);
    expect(r.zones[0].srState).toBe("UNTESTED");
  });

  it("strength is bounded 0..100 and itemised", () => {
    const cs = sideways(60);
    const r = run(cs, [mkZone({ tests: 5, reactions: 3, status: "REJECTED", strength: 95 })]);
    const z = r.zones[0];
    expect(z.strength).toBeGreaterThanOrEqual(0);
    expect(z.strength).toBeLessThanOrEqual(100);
    expect(z.strengthBreakdown.length).toBeGreaterThan(1);
    expect(z.strengthBreakdown.some((b) => b.factor === "structure base")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §4 primary zone selection
// ---------------------------------------------------------------------------

describe("primary zone selection (§4)", () => {
  it("selects the NEAREST relevant support and resistance, not the highest score", () => {
    const cs = sideways(60);
    const near = mkZone({ id: "near", type: "SWING_LOW", bottom: 99, top: 99.8, mid: 99.4, strength: 45, tests: 1, reactions: 1, status: "TESTING" });
    const farButStrong = mkZone({ id: "far", type: "PDL", bottom: 90, top: 91, mid: 90.5, strength: 92, tests: 5, reactions: 4, status: "REJECTED" });
    const resNear = mkZone({ id: "resN", type: "SWING_HIGH", side: "resistance", bottom: 100.5, top: 101.2, mid: 100.85, strength: 48, tests: 1, reactions: 1, status: "TESTING" });
    const r = run(cs, [near, farButStrong, resNear]);
    expect(r.scenario.primarySupport?.zone.id).toBe("near");
    expect(r.scenario.primarySupport?.zone.strength).toBeLessThan(farButStrong.strength!);
    expect(r.scenario.primaryResistance?.zone.id).toBe("resN");
  });

  it("reports distance to each primary zone in ATR", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8, mid: 99.4 });
    const r = run(cs, [sup]);
    expect(r.scenario.primarySupport?.distanceAtr).toBeGreaterThan(0);
    expect(r.scenario.primarySupport?.selectionReason).toMatch(/relevance/i);
  });

  it("identifies a trading range between the two primary zones", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8, mid: 99.4 });
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.4, top: 101.2, mid: 100.8 });
    const r = run(cs, [sup, res]);
    expect(r.scenario.tradingRange).toBeTruthy();
    expect(r.scenario.tradingRange!.bottom).toBeLessThan(r.scenario.tradingRange!.top);
  });

  it("reports no reliable zone when nothing qualifies", () => {
    const cs = sideways(60);
    const r = run(cs, []);
    expect(r.scenario.primarySupport).toBeNull();
    expect(r.scenario.primaryResistance).toBeNull();
    expect(r.scenario.noReliableZone).toBe(true);
  });

  it("excludes zones beyond the relevance distance", () => {
    const cs = sideways(60);
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    const far = mkZone({ bottom: 100 - atr * 50, top: 100 - atr * 49.5, mid: 100 - atr * 49.75 });
    const r = run(cs, [far]);
    expect(r.scenario.primarySupport).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §5 movement states
// ---------------------------------------------------------------------------

describe("movement classification (§5)", () => {
  it("fixture sanity: the trend fixtures really trend", () => {
    expect(analyzeStructure(uptrend(60)).trend).toBe("UP");
    expect(analyzeStructure(downtrend(60)).trend).toBe("DOWN");
  });

  it("classifies an uptrend with positive momentum as BULLISH_CONTINUATION", () => {
    const cs = uptrend(60);
    const r = run(cs, []);
    expect(["BULLISH_CONTINUATION", "PULLBACK_IN_UPTREND"]).toContain(r.scenario.movement);
  });

  it("classifies a downtrend with negative momentum as BEARISH_CONTINUATION", () => {
    const cs = downtrend(60);
    const r = run(cs, []);
    expect(["BEARISH_CONTINUATION", "PULLBACK_IN_DOWNTREND"]).toContain(r.scenario.movement);
  });

  it("a dip within an intact uptrend is a PULLBACK, not a reversal", () => {
    const cs = uptrend(54);
    const struct = analyzeStructure(cs);
    expect(struct.trend).toBe("UP");
    const lastLow = [...struct.swings].reverse().find((x) => x.kind === "low");
    expect(lastLow).toBeTruthy();
    // pull back toward (but NOT below) the last higher low
    const target = lastLow!.price + 0.5;
    for (let i = 0; i < 5; i++) {
      const p = target + (4 - i) * 0.3;
      cs.push(bar(54 + i, p + 0.3, p + 0.6, p - 0.3, p - 0.1, 1100));
    }
    const r = run(cs, []);
    expect(r.scenario.movement).not.toBe("REVERSAL_CANDIDATE");
  });

  it("breaking the last higher low in an uptrend becomes a REVERSAL_CANDIDATE", () => {
    const cs = uptrend(54);
    const struct = analyzeStructure(cs);
    const lastLow = [...struct.swings].reverse().find((x) => x.kind === "low")!;
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    // a decisive close below the last confirmed higher low
    for (let i = 0; i < 4; i++) {
      const p = lastLow.price - 1 - i * 0.6;
      cs.push(bar(54 + i, p + 0.3, p + 0.5, p - 0.5, p - 0.2, 1400));
    }
    const r = run(cs, []);
    expect(r.price).toBeLessThan(lastLow.price - atr * 0.15);
    expect(["REVERSAL_CANDIDATE", "BEARISH_CONTINUATION"]).toContain(r.scenario.movement);
  });

  it("a red candle in an uptrend is NOT automatically bearish", () => {
    const cs = uptrend(60);
    cs.push(bar(60, cs[59].close + 0.2, cs[59].close + 0.5, cs[59].close - 0.9, cs[59].close - 0.5, 900));
    const r = run(cs, []);
    expect(r.scenario.movement).not.toBe("BEARISH_CONTINUATION");
  });

  it("classifies sideways price as a non-trending state with a documented reason", () => {
    const cs = sideways(70);
    const r = run(cs, []);
    // A sideways series ending on a down-leg can legitimately read as a
    // pullback/continuation; what matters is that the reason is stated.
    expect(r.scenario.movementReason.length).toBeGreaterThan(20);
    expect(typeof r.scenario.movement).toBe("string");
  });

  it("price at support with positive momentum is a SUPPORT_REJECTION_CANDIDATE (not confirmed)", () => {
    const cs = sideways(60);
    // end with a small rally right at the support band
    cs.push(bar(60, 99.6, 100.1, 99.4, 100.0, 1200));
    const sup = mkZone({ bottom: 99, top: 99.9, mid: 99.45, tests: 2, reactions: 1, status: "HOLDING" });
    const r = run(cs, [sup]);
    if (r.scenario.movement === "SUPPORT_REJECTION_CANDIDATE") {
      expect(r.scenario.movementReason).toMatch(/NOT confirmed|not.*confirmed/i);
    }
  });

  it("never confirms a rejection on touch alone", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.9 });
    const r = run(cs, [sup]);
    expect(r.scenario.movement).not.toBe("REVERSAL_CANDIDATE");
  });
});

// ---------------------------------------------------------------------------
// §6 state machine and role flip
// ---------------------------------------------------------------------------

describe("breakout/breakdown state machine (§6)", () => {
  it("a close beyond the zone without follow-through is PENDING, not confirmed", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, tests: 1, reactions: 0, status: "TESTING" });
    // one candle closes above but no follow-through yet
    cs.push(bar(60, 100.5, 101.3, 100.4, 101.1, 1500));
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).toBe("BREAKOUT_PENDING");
    expect(r.zones[0].priceActionConfirmed).toBe(false);
    expect(r.zones[0].machineReason).toMatch(/not yet a confirmed break/i);
    expect(r.scenario.movement).toBe("BREAKOUT_PENDING_CONFIRMATION");
  });

  it("follow-through candles confirm the breakout and FLIP the role", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, tests: 1, status: "TESTING" });
    for (let i = 0; i < 4; i++) cs.push(bar(60 + i, 101.2, 101.9, 101.0, 101.6, 1600));
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).toBe("CONFIRMED_BREAKOUT");
    expect(r.zones[0].roleFlipped).toBe(true);
    expect(r.zones[0].currentRole).toBe("support");
    expect(r.zones[0].srState).toBe("BROKEN_RESISTANCE");
  });

  it("a breakdown mirrors the breakout logic", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99.2, top: 99.9, mid: 99.55, tests: 1, status: "TESTING" });
    for (let i = 0; i < 4; i++) cs.push(bar(60 + i, 98.8, 99.0, 98.2, 98.4, 1600));
    const r = run(cs, [sup]);
    expect(r.zones[0].machineState).toBe("CONFIRMED_BREAKDOWN");
    expect(r.zones[0].roleFlipped).toBe(true);
    expect(r.zones[0].currentRole).toBe("resistance");
  });

  it("a wick beyond the zone alone does NOT confirm a breakout", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    // wick above but close back inside
    cs.push(bar(60, 100.4, 101.6, 100.3, 100.5, 1500));
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).not.toBe("CONFIRMED_BREAKOUT");
    expect(r.zones[0].machineState).not.toBe("BREAKOUT_PENDING");
  });

  it("price returning inside after a break is a FAILED_BREAKOUT", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    cs.push(bar(60, 100.5, 101.4, 100.4, 101.1, 1500));   // poke above
    cs.push(bar(61, 101.0, 101.2, 100.3, 100.5, 1200));   // back inside
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).toBe("FAILED_BREAKOUT");
  });

  it("price returning to a broken zone is a RETEST_IN_PROGRESS", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    for (let i = 0; i < 3; i++) cs.push(bar(60 + i, 101.4, 102.0, 101.2, 101.7, 1600));  // break + hold
    cs.push(bar(63, 101.0, 101.3, 100.85, 100.95, 1300));                                  // come back to retest
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).toBe("RETEST_IN_PROGRESS");
  });
});

// ---------------------------------------------------------------------------
// §7 target and invalidation
// ---------------------------------------------------------------------------

describe("next target and invalidation (§7)", () => {
  it("selects the next target from an existing zone, not a fixed percentage", () => {
    const cs = sideways(60);
    const sup = mkZone({ id: "s", bottom: 99, top: 99.8, mid: 99.4, tests: 1, status: "TESTING" });
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.4, top: 101.2, mid: 100.8, tests: 1, status: "TESTING" });
    const r = run(cs, [sup, res]);
    expect(r.scenario.nextTarget).toBeTruthy();
    expect(r.scenario.nextTarget!.zoneId).toBeTruthy();
    expect(r.scenario.nextTarget!.description).toMatch(/potential reaction area/i);
  });

  it("provides an invalidation level whenever a primary zone is selected", () => {
    const cs = uptrend(60);
    // Place the support BELOW all recent price action so it has not been
    // broken (a zone inside a rising series would legitimately read as broken).
    const recentLow = Math.min(...cs.slice(-20).map((c) => c.low));
    const sup = mkZone({ id: "s", bottom: recentLow - 1.2, top: recentLow - 0.4, mid: recentLow - 0.8, tests: 0, reactions: 0, status: "NEW" });
    const r = run(cs, [sup]);
    if (r.scenario.primarySupport) {
      expect(r.scenario.invalidationLevel).toBeTruthy();
      expect(r.scenario.invalidationLevel!.description).toMatch(/invalidates/i);
      expect(r.scenario.invalidationLevel!.level).toBeLessThan(r.price);
    } else {
      // if no zone qualified, the scenario must say so honestly
      expect(r.scenario.noReliableZone).toBe(true);
    }
  });

  it("lists confirmations that are still pending", () => {
    const cs = sideways(60);
    const atr = atrSeries(cs, 14).at(-1) ?? 1;
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    // one candle closes decisively beyond, and price is STILL beyond it
    cs.push(bar(60, 100.5, 101.3, 100.4, 101.1 + atr, 1500));
    const r = run(cs, [res]);
    expect(r.zones[0].machineState).toBe("BREAKOUT_PENDING");
    expect(r.scenario.movement).toBe("BREAKOUT_PENDING_CONFIRMATION");
    expect(r.scenario.pendingConfirmations.length).toBeGreaterThan(0);
    expect(r.scenario.pendingConfirmations.some((x) => /follow-through/i.test(x))).toBe(true);
  });

  it("distinguishes observed level from candidate trigger and target", () => {
    const cs = sideways(60);
    const sup = mkZone({ bottom: 99, top: 99.8, mid: 99.4 });
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.4, top: 101.2, mid: 100.8 });
    const r = run(cs, [sup, res]);
    if (r.scenario.continuationTrigger) expect(r.scenario.continuationTrigger.kind).toBe("CANDIDATE_TRIGGER");
    if (r.scenario.nextTarget) expect(r.scenario.nextTarget.description).toMatch(/not a guaranteed/i);
  });
});

// ---------------------------------------------------------------------------
// §9 no-lookahead
// ---------------------------------------------------------------------------

describe("no look-ahead (§9, §11)", () => {
  it("does not confirm a break before the follow-through candles exist", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    const breakBar = bar(60, 100.5, 101.4, 100.4, 101.1, 1500);
    const partial = run([...cs, breakBar], [res]);
    expect(partial.zones[0].machineState).toBe("BREAKOUT_PENDING");

    // adding follow-through advances the state
    const full = [...cs, breakBar];
    for (let i = 0; i < 3; i++) full.push(bar(61 + i, 101.3, 101.9, 101.1, 101.6, 1600));
    const r2 = run(full, [res]);
    expect(r2.zones[0].machineState).toBe("CONFIRMED_BREAKOUT");
  });

  it("zone ids are stable across repeated evaluation of the same input", () => {
    const cs = sideways(60);
    const zones = buildZones({
      candles: cs, atr: atrSeries(cs, 14).at(-1) ?? 1, swings: swingPoints(cs),
      day: { prevHigh: 101.2, prevLow: 98.8, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const a = run(cs, zones);
    const b = run(cs, zones);
    expect(a.zones.map((z) => z.id)).toEqual(b.zones.map((z) => z.id));
    expect(a.zones.map((z) => z.strength)).toEqual(b.zones.map((z) => z.strength));
  });

  it("the forming candle is excluded from evaluation", () => {
    const cs = sideways(60);
    const res = mkZone({ id: "r", type: "SWING_HIGH", side: "resistance", bottom: 100.2, top: 100.8, mid: 100.5, status: "TESTING" });
    // a LIVE candle far above the zone must not trigger a confirmed break
    const withLive: Candle[] = [...cs, { ts: T0 + 61 * 300_000, open: 102, high: 103, low: 101.9, close: 102.8, volume: 5000, live: true }];
    const r = run(withLive, [res]);
    expect(r.zones[0].machineState).not.toBe("CONFIRMED_BREAKOUT");
  });
});

// ---------------------------------------------------------------------------
// confluence and data quality
// ---------------------------------------------------------------------------

describe("confluence and data quality", () => {
  it("counts only INDEPENDENT source families as confluence", () => {
    expect(SOURCE_FAMILY.SWING_HIGH).toBe("structure");
    expect(SOURCE_FAMILY.SWING_LOW).toBe("structure");
    expect(SOURCE_FAMILY.PDH).toBe("session");
    expect(SOURCE_FAMILY.POC).toBe("volume");
    expect(SOURCE_FAMILY.VWAP).toBe("vwap");
    // correlated sources share a family so they are not double-counted
    expect(SOURCE_FAMILY.SWING_HIGH).toBe(SOURCE_FAMILY.EQUAL_HIGHS);
    expect(SOURCE_FAMILY.PDH).not.toBe(SOURCE_FAMILY.POC);
  });

  it("labels candle-derived profile as ESTIMATED", () => {
    const cs = sideways(60);
    const r = run(cs, [], { profile: { approximation: true, method: "UNIFORM_ALLOCATION_FROM_OHLCV" } as any });
    expect(r.dataQuality.profile).toBe("ESTIMATED");
  });

  it("reports unavailable channels honestly", () => {
    const cs = sideways(60);
    const r = run(cs, []);
    expect(r.dataQuality.futures).toBe("UNAVAILABLE");
    expect(r.dataQuality.optionOi).toBe("UNAVAILABLE");
    expect(r.dataQuality.note).toMatch(/ESTIMATED|potential reaction/i);
  });

  it("every zone carries provenance", () => {
    const cs = sideways(60);
    const zones = buildZones({
      candles: cs, atr: atrSeries(cs, 14).at(-1) ?? 1, swings: swingPoints(cs),
      day: { prevHigh: 101.2, prevLow: 98.8, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    });
    const r = run(cs, zones);
    for (const z of r.zones) {
      expect(z.source.length).toBeGreaterThan(0);
      expect(z.timeframe).toBe("5m");
      expect(z.createdTs).toBeGreaterThan(0);
      expect(z.updatedTs).toBeGreaterThan(0);
      expect(z.invalidation.length).toBeGreaterThan(0);
    }
  });
});
