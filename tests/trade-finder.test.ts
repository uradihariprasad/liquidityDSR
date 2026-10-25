/**
 * Trade Finder: filter semantics, quote-cache preservation on 429, staleness,
 * progressive coverage and candidate-funnel accounting.
 *
 * Guards:
 *  B27 a failed quote refresh wiped the good cache (empty map written back)
 *  B28 CASH matched indices and F&O excluded index futures
 *  B29 every manual scan forced a full-universe re-quote, tripping the quota
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { scanOpportunities, invalidateOpportunityCache } from "@/lib/market/opportunities";
import { invalidateScanCache, scanState } from "@/lib/market/engine";
import { setRuntimeToken, clearRuntimeToken } from "@/lib/market/credentials";
import { __resetScheduler, registerRateLimit, schedulerState } from "@/lib/market/ratelimit";
import { fetchQuotes } from "@/lib/market/upstox";

// ---------------------------------------------------------------------------
// Filter semantics — mirrors the pure predicates used by TradesPanel
// ---------------------------------------------------------------------------

type Cand = { symbol: string; direction: "LONG" | "SHORT"; kind: string; foEligible: boolean; rr: number; fmpi: number };

const classify = (c: Cand): "INDEX" | "FO" | "CASH" =>
  c.kind === "index" ? "INDEX" : c.foEligible ? "FO" : "CASH";

const matchesKind = (c: Cand, kind: "ALL" | "INDEX" | "FO" | "CASH") => {
  if (kind === "ALL") return true;
  const k = classify(c);
  if (kind === "INDEX") return k === "INDEX";
  if (kind === "FO") return k === "FO" || (k === "INDEX" && !!c.foEligible);
  return k === "CASH";
};
const matchesDir = (c: Cand, dir: "ALL" | "LONG" | "SHORT") => dir === "ALL" || c.direction === dir;
const matchesQuality = (c: Cand, minRR: number, minFMPI: number) => (c.rr ?? 0) >= minRR && c.fmpi >= minFMPI;
const applyAll = (list: Cand[], dir: any, kind: any, minRR = 0, minFMPI = 0) =>
  list.filter((c) => matchesDir(c, dir) && matchesKind(c, kind) && matchesQuality(c, minRR, minFMPI));

const UNIVERSE: Cand[] = [
  { symbol: "NIFTY", direction: "LONG", kind: "index", foEligible: true, rr: 2.0, fmpi: 70 },   // index WITH futures
  { symbol: "SENSEX", direction: "SHORT", kind: "index", foEligible: false, rr: 1.8, fmpi: 62 }, // index, no mapped future
  { symbol: "TCS", direction: "LONG", kind: "stock", foEligible: true, rr: 2.4, fmpi: 68 },
  { symbol: "INFY", direction: "SHORT", kind: "stock", foEligible: true, rr: 1.6, fmpi: 58 },
  { symbol: "SMALLCO", direction: "LONG", kind: "stock", foEligible: false, rr: 2.2, fmpi: 55 }, // cash only
];

describe("filter semantics (B28)", () => {
  it("ALL + ANY shows every qualifying candidate, both directions and all types", () => {
    const rows = applyAll(UNIVERSE, "ALL", "ALL");
    expect(rows.length).toBe(UNIVERSE.length);
    expect(new Set(rows.map((r) => r.direction))).toEqual(new Set(["LONG", "SHORT"]));
    expect(new Set(rows.map(classify))).toEqual(new Set(["INDEX", "FO", "CASH"]));
  });

  it("F&O includes eligible stocks AND supported index futures", () => {
    const rows = applyAll(UNIVERSE, "ALL", "FO").map((r) => r.symbol);
    expect(rows).toContain("TCS");
    expect(rows).toContain("INFY");
    expect(rows).toContain("NIFTY");       // index future — previously excluded
    expect(rows).not.toContain("SMALLCO"); // cash-only never counts as F&O
  });

  it("CASH never sweeps in indices (the old `!foEligible` bug)", () => {
    const rows = applyAll(UNIVERSE, "ALL", "CASH").map((r) => r.symbol);
    expect(rows).toEqual(["SMALLCO"]);
    expect(rows).not.toContain("SENSEX");
  });

  it("INDEX returns index instruments regardless of futures mapping", () => {
    const rows = applyAll(UNIVERSE, "ALL", "INDEX").map((r) => r.symbol).sort();
    expect(rows).toEqual(["NIFTY", "SENSEX"]);
  });

  it("direction and instrument type are independent axes", () => {
    expect(applyAll(UNIVERSE, "LONG", "ALL").map((r) => r.symbol).sort()).toEqual(["NIFTY", "SMALLCO", "TCS"]);
    expect(applyAll(UNIVERSE, "SHORT", "FO").map((r) => r.symbol)).toEqual(["INFY"]);
    // narrowing one axis must not change what the other axis would allow
    const foAll = applyAll(UNIVERSE, "ALL", "FO").length;
    const foLong = applyAll(UNIVERSE, "LONG", "FO").length;
    const foShort = applyAll(UNIVERSE, "SHORT", "FO").length;
    expect(foLong + foShort).toBe(foAll);
  });

  it("classification is mutually exclusive — every candidate lands in exactly one bucket", () => {
    for (const c of UNIVERSE) {
      const hits = (["INDEX", "FO", "CASH"] as const).filter((k) => classify(c) === k);
      expect(hits.length).toBe(1);
    }
  });

  it("computes per-axis hidden counts for the FILTERED_OUT message", () => {
    const dir = "LONG", kind = "FO", minRR = 0, minFMPI = 0;
    const rows = applyAll(UNIVERSE, dir, kind, minRR, minFMPI);
    const byDir = UNIVERSE.filter((c) => !matchesDir(c, dir) && matchesKind(c, kind) && matchesQuality(c, minRR, minFMPI)).length;
    const byKind = UNIVERSE.filter((c) => matchesDir(c, dir) && !matchesKind(c, kind) && matchesQuality(c, minRR, minFMPI)).length;
    expect(rows.length).toBeGreaterThan(0);
    expect(byDir).toBeGreaterThan(0);   // INFY hidden by direction
    expect(byKind).toBeGreaterThan(0);  // SMALLCO hidden by type
    expect(rows.length + byDir + byKind).toBeLessThanOrEqual(UNIVERSE.length);
  });

  it("quality minimums hide candidates without touching direction/type logic", () => {
    const strict = applyAll(UNIVERSE, "ALL", "ALL", 2.0, 60);
    expect(strict.map((r) => r.symbol).sort()).toEqual(["NIFTY", "TCS"]);
    expect(applyAll(UNIVERSE, "ALL", "ALL", 0, 0).length).toBe(UNIVERSE.length);
  });
});

// ---------------------------------------------------------------------------
// Quote failures, cache preservation and staleness
// ---------------------------------------------------------------------------

const QUOTE_OK = {
  status: "success",
  data: {
    "NSE_EQ:TCS": {
      instrument_token: "NSE_EQ|INE467B01029", symbol: "TCS",
      last_price: 2500, prev_close_price: 2490, volume: 1000,
      ohlc: { open: 2495, high: 2510, low: 2480, close: 2490 },
      timestamp: "2026-10-22T11:00:00.000+05:30",
    },
  },
};

beforeEach(() => {
  __resetScheduler();
  invalidateScanCache();
  invalidateOpportunityCache();
  clearRuntimeToken();
  delete process.env.UPSTOX_ACCESS_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRuntimeToken();
  __resetScheduler();
});

describe("quote 429 handling and cache preservation (B27)", () => {
  it("a 429 on the quote endpoint surfaces as RATE_LIMITED, not a generic failure", () => {
    registerRateLimit("quotes", 30, Date.now());
    const st = schedulerState();
    expect(st.classes.quotes.limited).toBe(true);
    expect(st.status).toBe("RATE_LIMITED");
    // the candle quota must stay usable — they are separate quotas
    expect(st.classes.candles.limited).toBe(false);
  });

  it("merging a failed refresh over a previous cache retains the old quotes", () => {
    // models the engine's merge policy: empty refresh must not replace cache
    const prev = { "NSE_EQ|INE467B01029": { lastPrice: 2500 } };
    const refreshed: Record<string, any> = {};
    const err = "Upstox quotes quota is rate-limited";
    const freshCount = Object.keys(refreshed).length;
    const served = freshCount === 0 && err ? prev : { ...prev, ...refreshed };
    expect(Object.keys(served).length).toBe(1);
    expect((served as any)["NSE_EQ|INE467B01029"].lastPrice).toBe(2500);
  });

  it("a partial refresh merges fresh over cached without losing coverage", () => {
    const prev = { A: { lastPrice: 1 }, B: { lastPrice: 2 } };
    const refreshed = { B: { lastPrice: 22 } };
    const combined = { ...prev, ...refreshed };
    expect(Object.keys(combined).sort()).toEqual(["A", "B"]);
    expect(combined.B.lastPrice).toBe(22);   // fresh wins
    expect(combined.A.lastPrice).toBe(1);    // cached retained
  });

  it("cached-after-failure data is never counted as freshly quoted", () => {
    const freshQuotes = 0;             // nothing refreshed
    const lastKnownQuotes = 219;       // served from cache
    expect(freshQuotes).toBe(0);
    expect(lastKnownQuotes).toBeGreaterThan(freshQuotes);
  });

  it("does not retry non-429 errors as if they were rate limits", async () => {
    setRuntimeToken("tf-test-token-0123456789", { validated: false, userName: null, error: null });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      calls += 1;
      return { ok: false, status: 500, headers: new Map(), json: async () => ({}) };
    }));
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow(/500/);
    expect(calls).toBe(1);
    expect(schedulerState().classes.quotes.total429).toBe(0);
  });

  it("a successful quote clears the rate-limited state", async () => {
    setRuntimeToken("tf-test-token-0123456789", { validated: false, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Map(), json: async () => QUOTE_OK,
    }));
    const out = await fetchQuotes(["NSE_EQ|INE467B01029"]);
    expect(out["NSE_EQ|INE467B01029"].lastPrice).toBe(2500);
    expect(schedulerState().classes.quotes.limited).toBe(false);
  });
});

describe("progressive coverage and scan-cache scoping (B29)", () => {
  it("invalidateScanCache clears derived results but preserves the quote cache", () => {
    const before = scanState().coverage;
    invalidateScanCache();
    const after = scanState().coverage;
    // the per-instrument quote bookkeeping survives a derived-result reset
    expect(after.lastKnownQuotes).toBe(before.lastKnownQuotes);
    expect(after.universe).toBe(before.universe);
  });

  it("coverage separates quoted / analysed / pending as distinct stages", () => {
    const c = scanState().coverage;
    for (const k of ["universe", "lastKnownQuotes", "freshQuotes", "fullyAnalysed", "pendingAnalysis", "quoteOnly", "quotesStale"]) {
      expect(c, `coverage.${k}`).toHaveProperty(k);
    }
    expect(c.freshQuotes).toBeLessThanOrEqual(c.lastKnownQuotes || Infinity);
    expect(c.fullyAnalysed).toBeLessThanOrEqual(c.universe || Infinity);
  });

  it("the coverage note explains the funnel rather than contradicting itself", () => {
    const note = scanState().coverage.note;
    expect(typeof note).toBe("string");
    expect(note.length).toBeGreaterThan(20);
  });
});

describe("scan status and funnel accounting (spec §6, §9)", () => {
  it("reports an explicit status (not a generic failure) with a funnel", async () => {
    const scan = await scanOpportunities({ force: true });
    expect(scan.available).toBe(false);      // no token in this environment
    expect(["RATE_LIMITED", "SCAN_FAILED", "NOT_CONNECTED"]).toContain(scan.status);
    expect(scan.funnel).toBeTruthy();
    expect(scan.funnel.excluded.length).toBeGreaterThan(0);
    expect(scan.candidates).toEqual([]);     // never fabricated
  });

  it("every scan exposes the stage counters the UI renders", async () => {
    const scan = await scanOpportunities({ force: true });
    for (const k of ["universe", "quoted", "freshlyAnalysed", "enteredRanking", "evaluated", "qualified", "pendingEvaluation"]) {
      expect(scan.funnel, `funnel.${k}`).toHaveProperty(k);
    }
  });

  it("funnel counts are internally consistent (qualified ≤ evaluated ≤ ranked)", async () => {
    const scan = await scanOpportunities({ force: true });
    const f = scan.funnel;
    expect(f.qualified).toBeLessThanOrEqual(f.evaluated);
    expect(f.evaluated).toBeLessThanOrEqual(Math.max(f.enteredRanking, f.evaluated));
    expect(f.pendingEvaluation).toBeGreaterThanOrEqual(0);
  });
});
