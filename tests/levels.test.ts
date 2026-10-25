/**
 * §5 R1/R2/S1/S2 selection tests + §7 chart rendering contract.
 */
import { describe, it, expect } from "vitest";
import { buildSREngine } from "@/lib/market/srEngine";
import { analyzeStructure } from "@/lib/market/structure";
import { atrSeries, relVolSeries, vwapSeries } from "@/lib/market/indicators";
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

function run(candles: Candle[], zones: Zone[]) {
  const atr = atrSeries(candles, 14).at(-1) ?? 1;
  return buildSREngine({
    symbol: "TEST", timeframe: "5m", candles, zones,
    structure: analyzeStructure(candles), profile: null, atr,
    price: candles[candles.length - 1].close,
    relVol: relVolSeries(candles, 20).at(-1) ?? null,
    vwap: vwapSeries(candles).at(-1) ?? null,
    futuresAvailable: false, optionOiAvailable: false,
  });
}

describe("R1/R2/S1/S2 selection (§5)", () => {
  const cs = sideways(60);
  const zones = [
    mkZone("s1", "support", 99.0, 99.6),
    mkZone("s2", "support", 97.0, 97.6),
    mkZone("r1", "resistance", 100.4, 101.0),
    mkZone("r2", "resistance", 102.0, 102.6),
  ];

  it("selects all four levels from the unified zone set", () => {
    const r = run(cs, zones);
    const L = r.scenario.levels;
    expect(L.R1?.zone.id).toBe("r1");
    expect(L.R2?.zone.id).toBe("r2");
    expect(L.S1?.zone.id).toBe("s1");
    expect(L.S2?.zone.id).toBe("s2");
  });

  it("R1 is above price and R2 is above R1", () => {
    const r = run(cs, zones);
    const price = r.price;
    expect(L1(r)).toBeGreaterThan(price);
    expect(L2(r)).toBeGreaterThan(L1(r));
  });
  const L1 = (r: any) => r.scenario.levels.R1.zone.mid;
  const L2 = (r: any) => r.scenario.levels.R2.zone.mid;

  it("S1 is below price and S2 is below S1", () => {
    const r = run(cs, zones);
    const price = r.price;
    expect(r.scenario.levels.S1!.zone.mid).toBeLessThan(price);
    expect(r.scenario.levels.S2!.zone.mid).toBeLessThan(r.scenario.levels.S1!.zone.mid);
  });

  it("never assigns the same zone to both R1 and S1", () => {
    const r = run(cs, zones);
    expect(r.scenario.levels.R1?.zone.id).not.toBe(r.scenario.levels.S1?.zone.id);
    expect(r.scenario.levels.R2?.zone.id).not.toBe(r.scenario.levels.S2?.zone.id);
  });

  it("R2 does not overlap R1 and S2 does not overlap S1", () => {
    const r = run(cs, zones);
    const R1 = r.scenario.levels.R1!.zone, R2 = r.scenario.levels.R2!.zone;
    const S1 = r.scenario.levels.S1!.zone, S2 = r.scenario.levels.S2!.zone;
    expect(R2.bottom).toBeGreaterThan(R1.top);
    expect(S2.top).toBeLessThan(S1.bottom);
  });

  it("rejects a secondary that overlaps the primary even with a different id", () => {
    // r2 overlaps r1 almost exactly -> must not be selected as R2
    const overlapping = [
      mkZone("s1", "support", 99.0, 99.6),
      mkZone("r1", "resistance", 100.4, 101.0),
      mkZone("r1b", "resistance", 100.45, 101.05, { strength: 90 }),  // overlapping, higher score
      mkZone("r3", "resistance", 102.0, 102.6),
    ];
    const r = run(cs, overlapping);
    expect(r.scenario.levels.R1?.zone.id).toBe("r1b");   // higher relevance wins R1
    expect(r.scenario.levels.R2?.zone.id).toBe("r3");     // overlapping r1 skipped for R2
    expect(r.scenario.levels.R2?.zone.id).not.toBe("r1");
  });

  it("reports 'not available' honestly when a side has no valid zone", () => {
    const r = run(cs, [mkZone("s1", "support", 99.0, 99.6)]);
    expect(r.scenario.levels.R1).toBeNull();
    expect(r.scenario.levels.R2).toBeNull();
    expect(r.scenario.levels.S1?.zone.id).toBe("s1");
    expect(r.scenario.levels.notes.some((n) => /no reliable resistance/i.test(n))).toBe(true);
  });

  it("excludes wrong-side candidates", () => {
    // a "support" zone above price must not become S1
    const r = run(cs, [mkZone("wrongSide", "support", 101.5, 102.0)]);
    expect(r.scenario.levels.S1).toBeNull();
  });

  it("identifies the interaction zone when price is inside a zone", () => {
    // build candles ending inside the s1 band
    const cs2 = sideways(59);
    cs2.push(bar(59, 99.3, 99.5, 99.1, 99.4, 1000));
    const r = run(cs2, [mkZone("s1", "support", 99.0, 99.6), mkZone("r1", "resistance", 100.4, 101.0)]);
    if (r.price >= 99.0 && r.price <= 99.6) {
      expect(r.scenario.levels.interactionZone).toBeTruthy();
    }
  });

  it("levels update when structure changes meaningfully", () => {
    const a = run(sideways(60), zones);
    // add a new, closer resistance
    // placed clearly above the closing price (~100.4) and closer than r1
    const closer = [...zones, mkZone("r0", "resistance", 100.55, 100.85)];
    const b = run(sideways(60), closer);
    expect(b.scenario.levels.R1?.zone.id).toBe("r0");
    // r1 (100.4–101.0) OVERLAPS r0 (100.55–100.85), so the non-overlap rule
    // correctly rejects it for R2 and r2 becomes the secondary instead.
    expect(b.scenario.levels.R2?.zone.id).toBe("r2");
    expect(b.scenario.levels.R2?.zone.id).not.toBe("r1");
    expect(a.scenario.levels.R1?.zone.id).toBe("r1");
  });
});

describe("chart rendering contract (§7)", () => {
  it("PriceChart consumes srEngine.levels rather than ranking zones itself", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/PriceChart.tsx", "utf8");
    // must read the unified engine's level selection
    expect(src).toMatch(/srEngine/);
    expect(src).toMatch(/scenario\?\.levels|levels\?\.R1|levels\?\.S1/);
    // must NOT implement a second ranking algorithm in the frontend
    expect(src).not.toMatch(/sort\(\(a,\s*b\)\s*=>\s*b\.strength\s*-\s*a\.strength\)/);
    // must render the four labels
    expect(src).toMatch(/R1/);
    expect(src).toMatch(/R2/);
    expect(src).toMatch(/S1/);
    expect(src).toMatch(/S2/);
    expect(src).toMatch(/PRIMARY RESISTANCE/);
    expect(src).toMatch(/PRIMARY SUPPORT/);
  });

  it("raw structural labels are behind the advanced toggle, OFF by default", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/PriceChart.tsx", "utf8");
    expect(src).toMatch(/showAdvancedLabels = false/);
    expect(src).toMatch(/showAllLevels = false/);
    // the raw bundle.zones block must be gated on showAdvancedLabels
    const gated = /if \(showAdvancedLabels\)[\s\S]{0,200}bundle\.zones/;
    expect(gated.test(src)).toBe(true);
  });

  it("the workspace exposes both toggles", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/panels/WorkspacePanel.tsx", "utf8");
    expect(src).toMatch(/advanced:\s*false/);
    expect(src).toMatch(/allLevels:\s*false/);
    expect(src).toMatch(/showAdvancedLabels/);
    expect(src).toMatch(/showAllLevels/);
  });

  it("the SR panel renders the R1/R2/S1/S2 table from the engine", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/panels/SRPanel.tsx", "utf8");
    expect(src).toMatch(/sc\.levels\?\.R1/);
    expect(src).toMatch(/sc\.levels\?\.S1/);
    expect(src).toMatch(/sc\.levels\?\.R2/);
    expect(src).toMatch(/sc\.levels\?\.S2/);
  });

  it("no hardcoded price levels in the chart or panel", () => {
    const fs = require("node:fs");
    for (const f of ["src/components/PriceChart.tsx", "src/components/panels/SRPanel.tsx"]) {
      const src = fs.readFileSync(f, "utf8");
      // strip colour hex and line-width numbers, then look for suspicious prices
      const cleaned = src.replace(/#[0-9a-f]{3,8}/gi, "").replace(/lineWidth:\s*\d/g, "");
      expect(cleaned).not.toMatch(/\b\d{4,6}\.\d{2}\b/);
    }
  });
});

describe("invalidation labels (§10)", () => {
  it("uses context-specific scenario invalidation labels", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/lib/market/srEngine.ts", "utf8");
    expect(src).toMatch(/BULLISH SCENARIO INVALIDATION/);
    expect(src).toMatch(/BEARISH SCENARIO INVALIDATION/);
    // the generic label must not be the only one
    expect(src.match(/BULLISH SCENARIO INVALIDATION/g)!.length).toBeGreaterThan(2);
  });
});
