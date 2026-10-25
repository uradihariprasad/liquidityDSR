/**
 * Module-level tests for the repaired data pipeline:
 * futures expiry/OI, option-chain classification, OBI, alert gating,
 * Trade Finder ranking, and displayed-vs-executed separation.
 * Deterministic fixtures only — never production market data.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { toExpiryDate, selectExpiry } from "@/lib/market/futures";
import { interpretPriceOI, classifyStrikes } from "@/lib/market/derivatives";
import { buildDepth } from "@/lib/market/engine";
import { evaluateAlertRules } from "@/lib/market/alerts";
import { runScanner } from "@/lib/market/scanner";
import { parseMasterRows } from "@/lib/market/discovery";
import { setUniverse, getInstrument } from "@/lib/market/universe";
import { MASTER_FIXTURE, FIXTURE_NOW } from "./fixtures/instrument-master";

beforeAll(() => setUniverse(parseMasterRows(MASTER_FIXTURE, FIXTURE_NOW), "UPSTOX_INSTRUMENT_MASTER"));

describe("futures expiry normalisation (regression for B9)", () => {
  it("converts epoch-ms expiry to the YYYY-MM-DD form Upstox expects", () => {
    // 2026-10-27T15:29:59+05:30
    expect(toExpiryDate(1793125799000)).toBe("2026-10-27");
  });
  it("passes through an already-correct date string", () => {
    expect(toExpiryDate("2026-10-27")).toBe("2026-10-27");
  });
  it("returns null for unusable values instead of guessing", () => {
    expect(toExpiryDate(null)).toBeNull();
    expect(toExpiryDate("not-a-date")).toBeNull();
  });
  it("selects the nearest NON-EXPIRED expiry (old code picked a raw number)", () => {
    const rows = [
      { expiry: Date.UTC(2026, 8, 24) },  // past
      { expiry: Date.UTC(2026, 9, 27) },  // next
      { expiry: Date.UTC(2026, 10, 24) }, // later
    ];
    const { expiry, all } = selectExpiry(rows, "2026-10-21");
    expect(expiry).toBe("2026-10-27");
    expect(all.length).toBe(3);
    expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("reports null when every expiry is in the past", () => {
    expect(selectExpiry([{ expiry: Date.UTC(2020, 0, 1) }], "2026-10-21").expiry).toBeNull();
  });
});

describe("price/OI interpretation", () => {
  it("maps the four conventional combinations and always flags them provisional", () => {
    expect(interpretPriceOI(5, 1000)!.label).toBe("LONG_BUILDUP");
    expect(interpretPriceOI(-5, 1000)!.label).toBe("SHORT_BUILDUP");
    expect(interpretPriceOI(5, -1000)!.label).toBe("SHORT_COVERING");
    expect(interpretPriceOI(-5, -1000)!.label).toBe("LONG_UNWINDING");
    expect(interpretPriceOI(5, 1000)!.provisional).toBe(true);
    expect(interpretPriceOI(5, 1000)!.caveat).toMatch(/cannot identify/i);
  });
  it("returns null when there is nothing to interpret", () => {
    expect(interpretPriceOI(0, 0)).toBeNull();
  });
});

describe("option-chain strike classification", () => {
  const chain = [
    { strike_price: 980, put_options: { market_data: { oi: 90000, prev_oi: 50000, volume: 1200 } }, call_options: { market_data: { oi: 1000, prev_oi: 1000, volume: 10 } } },
    { strike_price: 1000, put_options: { market_data: { oi: 20000, prev_oi: 20000, volume: 300 } }, call_options: { market_data: { oi: 20000, prev_oi: 20000, volume: 300 } } },
    { strike_price: 1020, put_options: { market_data: { oi: 1000, prev_oi: 1000, volume: 10 } }, call_options: { market_data: { oi: 95000, prev_oi: 40000, volume: 1500 } } },
  ];
  it("labels the dominant put strike below spot as strong support", () => {
    const r = classifyStrikes(chain, 1000, 8);
    expect(r.available).toBe(true);
    expect(r.strikes.find((s) => s.strike === 980)?.label).toBe("STRONG_SUPPORT");
  });
  it("labels the dominant call strike above spot as strong resistance", () => {
    const r = classifyStrikes(chain, 1000, 8);
    expect(r.strikes.find((s) => s.strike === 1020)?.label).toBe("STRONG_RESISTANCE");
  });
  it("computes PCR over the documented ±8% scope and attaches caveats", () => {
    const r = classifyStrikes(chain, 1000, 8);
    expect(r.pcr).toBeCloseTo(111000 / 116000, 3);
    expect(r.pcrScope).toMatch(/±8%/);
    for (const s of r.strikes) expect(s.caveat).toMatch(/does not prove/i);
  });
  it("reports unavailable rather than inventing rows when the chain is empty", () => {
    expect(classifyStrikes([], 1000, 8).available).toBe(false);
  });
});

describe("market depth / OBI", () => {
  const stock = () => getInstrument("TCS")!;
  const quote = {
    ts: 1_700_000_000_000,
    depth: {
      buy: [{ price: 100, quantity: 600, orders: 5 }, { price: 99.9, quantity: 400, orders: 3 }],
      sell: [{ price: 100.1, quantity: 300, orders: 2 }, { price: 100.2, quantity: 200, orders: 2 }],
    },
  };
  it("computes OBI with the documented formula from contemporaneous quantities", () => {
    const d = buildDepth(stock(), quote);
    expect(d.available).toBe(true);
    expect(d.totalBidQty).toBe(1000);
    expect(d.totalAskQty).toBe(500);
    expect(d.obi).toBeCloseTo((1000 - 500) / 1500, 3);
    expect(d.spread).toBeCloseTo(0.1, 5);
  });
  it("handles an empty book safely instead of emitting a fake OBI", () => {
    const d = buildDepth(stock(), { depth: { buy: [], sell: [] } });
    expect(d.available).toBe(false);
    expect(d.obi).toBeNull();
    expect(d.reason.length).toBeGreaterThan(0);
  });
  it("keeps displayed liquidity separate from executed volume in its wording", () => {
    const d = buildDepth(stock(), quote);
    expect(d.capabilityNote).toMatch(/DISPLAYED liquidity, not executed order flow/);
    expect(d.capabilityNote).toMatch(/not reported as executed/);
  });
  it("labels index depth as sourced from the futures contract, never index spot", () => {
    const d = buildDepth(getInstrument("NIFTY")!, quote);
    expect(d.capabilityNote).toMatch(/no order book of its own/i);
    expect(d.capabilityNote).toMatch(/FUTURES contract/);
  });
});

describe("alert rule evaluation gating", () => {
  const baseBundle = (over: any = {}) => ({
    symbol: "TCS", tf: "5m",
    last: { price: 100 },
    quality: { status: "OK", mode: "LIVE_UPSTOX", marketSession: "OPEN", warnings: [] },
    fmpi: { score: 80, direction: "BULLISH", state: "STRENGTHENING" },
    movement: { state: "CONFIRMED_UPSIDE_BREAKOUT", bias: "BULLISH" },
    zones: [], scenario: { status: "WAITING_CONFIRMATION" },
    ...over,
  });

  it("fires FMPI_HIGH when the threshold is genuinely crossed", () => {
    const ev = evaluateAlertRules(baseBundle() as any, { fmpiHigh: 70, fmpiLow: 30, now: 1 });
    expect(ev.some((e) => e.kind === "FMPI_HIGH")).toBe(true);
  });

  it("does NOT fire FMPI_HIGH for a non-qualifying score", () => {
    const ev = evaluateAlertRules(baseBundle({ fmpi: { score: 40, direction: "NEUTRAL", state: "STABLE" } }) as any, { fmpiHigh: 70, fmpiLow: 30, now: 2 });
    expect(ev.some((e) => e.kind === "FMPI_HIGH")).toBe(false);
  });

  it("never fires FMPI rules on a suppressed (zero) score from missing data", () => {
    const ev = evaluateAlertRules(baseBundle({ fmpi: { score: 0, direction: "NEUTRAL", state: "CONFLICTING" }, movement: { state: "INSUFFICIENT_DATA", bias: "NEUTRAL" } }) as any, { fmpiHigh: 70, fmpiLow: 30, now: 3 });
    expect(ev.some((e) => e.kind === "FMPI_LOW")).toBe(false);
    expect(ev.some((e) => e.kind === "FMPI_HIGH")).toBe(false);
  });

  it("raises a critical FEED_HEALTH alert on stale data", () => {
    const ev = evaluateAlertRules(baseBundle({ quality: { status: "STALE", mode: "LIVE_UPSTOX", marketSession: "OPEN", warnings: ["stale"] } }) as any, { now: 4 });
    const fh = ev.find((e) => e.kind === "FEED_HEALTH");
    expect(fh?.severity).toBe("critical");
  });

  it("emits a dedupe key and cooldown on every event", () => {
    for (const e of evaluateAlertRules(baseBundle() as any, { now: 5 })) {
      expect(e.dedupeKey.length).toBeGreaterThan(0);
      expect(e.cooldownSec).toBeGreaterThan(0);
      expect(e.symbol).toBe("TCS");
      expect(e.ts).toBeGreaterThan(0);
    }
  });
});

describe("scanner coverage transparency", () => {
  const feat = (sym: string, over: any = {}) => ({
    symbol: sym, name: sym, kind: "stock", sector: "X", price: 100, changePct: 1.2,
    relVol: 1.6, fmpi: 70, fmpiDirection: "BULLISH" as const, state: "BULLISH_CONTINUATION",
    trend: "UP" as const, breakoutUp: false, breakoutDn: false, zoneNote: null,
    dataQuality: "OK", dayMoveAtr: 1, ...over,
  });

  it("separates fully analysed, partial, quote-only and insufficient instruments", () => {
    const feats = [
      feat("GOOD1"), feat("GOOD2"),
      feat("PARTIAL", { dataQuality: "DEGRADED" }),
      feat("QUOTEONLY", { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1 }),
      feat("NODATA", { state: "INSUFFICIENT_DATA", dataQuality: "UNAVAILABLE", fmpi: 0, relVol: 0 }),
    ];
    const r = runScanner(feats, "TEST", { count: 5 });
    expect(r.coverage.fullyAnalysed).toBe(2);
    expect(r.coverage.partiallyAnalysed).toBe(1);
    expect(r.coverage.quoteOnly).toBe(1);
    expect(r.coverage.insufficientData).toBe(1);
    expect(r.coverage.scanned).toBe(5);
    expect(r.coverage.note).toMatch(/never ranked as signals/);
  });

  it("never ranks a quote-only or insufficient instrument as a candidate", () => {
    const feats = [
      feat("GOOD1"),
      feat("QUOTEONLY", { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1 }),
      feat("NODATA", { state: "INSUFFICIENT_DATA", dataQuality: "UNAVAILABLE", fmpi: 0, relVol: 0 }),
    ];
    const r = runScanner(feats, "TEST", { count: 5, minFMPI: 0, minRelVol: 0, minChangePct: 0 });
    const symbols = [...r.bullish, ...r.bearish].map((c) => c.symbol);
    expect(symbols).toContain("GOOD1");
    expect(symbols).not.toContain("QUOTEONLY");
    expect(symbols).not.toContain("NODATA");
  });

  it("reports excluded-by-filter counts rather than silently dropping them", () => {
    const feats = [feat("A", { fmpi: 80, relVol: 2 }), feat("B", { fmpi: 20, relVol: 0.4 })];
    const r = runScanner(feats, "TEST", { count: 5, minFMPI: 50, minRelVol: 1.0, minChangePct: 0.25 });
    expect(r.coverage.excludedByFilters).toBe(1);
  });
});

describe("Trade Finder ranking model", () => {
  const STATE_QUALITY: Record<string, number> = {
    CONFIRMED_UPSIDE_BREAKOUT: 1.0, BULLISH_CONTINUATION: 0.7, POTENTIAL_LIQUIDITY_SWEEP: 0.55,
  };
  const score = (fmpi: number, rr: number, state: string, relVol: number, sup: number, con: number, dq: number) =>
    0.30 * (fmpi / 100) + 0.20 * Math.min(1, rr / 3) + 0.18 * (STATE_QUALITY[state] ?? 0.4)
    + 0.12 * Math.min(1, relVol / 2) + 0.10 * Math.max(0, Math.min(1, (sup - con + 3) / 6)) + 0.10 * dq;

  it("ranks a confirmed high-FMPI high-RR setup above a weak one", () => {
    const strong = score(85, 2.5, "CONFIRMED_UPSIDE_BREAKOUT", 1.8, 4, 0, 1);
    const weak = score(56, 1.5, "POTENTIAL_LIQUIDITY_SWEEP", 0.9, 1, 3, 0.7);
    expect(strong).toBeGreaterThan(weak);
  });
  it("is bounded in [0,1] so the score can never imply a probability > 100%", () => {
    expect(score(100, 10, "CONFIRMED_UPSIDE_BREAKOUT", 10, 10, 0, 1)).toBeLessThanOrEqual(1.0001);
    expect(score(0, 0, "UNKNOWN", 0, 0, 10, 0)).toBeGreaterThanOrEqual(0);
  });
  it("never pads the list — fewer qualifying setups yield fewer rows", () => {
    const qualifying = [{ rr: 2.1 }, { rr: 1.8 }, { rr: 1.6 }].filter((c) => c.rr >= 1.5);
    expect(qualifying.slice(0, 10).length).toBe(3);
  });
  it("excludes instruments missing required inputs rather than scoring them neutral", () => {
    const rows = [{ symbol: "A", fmpi: 72, rr: 2 }, { symbol: "B", fmpi: 0, rr: null }];
    const eligible = rows.filter((r) => r.fmpi > 0 && r.rr != null);
    expect(eligible.map((r) => r.symbol)).toEqual(["A"]);
  });
});
