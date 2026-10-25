/**
 * Upstox adapter parsing tests (recorded fixtures of the DOCUMENTED response
 * schema — test-only, never production market data).
 *
 * These guard the two root causes found in this round:
 *  B13 the app called /v2/market-quote/full, which is NOT a documented
 *     Upstox endpoint -> every depth/futures quote 404'd.
 *  B14 response `data` is keyed by <EXCHANGE>:<TRADING_SYMBOL>, and depth
 *     arrays are padded with zero-quantity placeholder rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { __testables, fetchQuotes, fetchFullQuote } from "@/lib/market/upstox";
import { buildDepth } from "@/lib/market/engine";
import { setUniverse, getInstrument } from "@/lib/market/universe";
import { setRuntimeToken, clearRuntimeToken } from "@/lib/market/credentials";
import { parseMasterRows } from "@/lib/market/discovery";
import { MASTER_FIXTURE, FIXTURE_NOW } from "./fixtures/instrument-master";

const { parseQuote, normalizeDepth, realDepthLevels, indexQuote } = __testables;

/** Verbatim structure from the official Full Market Quotes documentation. */
const FULL_QUOTE_RESPONSE = {
  status: "success",
  data: {
    "NSE_EQ:NHPC": {
      ohlc: { open: 76.1, high: 77.25, low: 75.95, close: 76.59, volume: 24123697, ts: 1757000100000 },
      depth: {
        buy: [
          { quantity: 6917, price: 76.55, orders: 20 },
          { quantity: 0, price: 0, orders: 0 },
        ],
        sell: [
          { quantity: 0, price: 0, orders: 0 },
          { quantity: 0, price: 0, orders: 0 },
        ],
      },
      timestamp: "2026-09-04T15:22:31.099+05:30",
      instrument_token: "NSE_EQ|INE848E01016",
      symbol: "NHPC",
      last_price: 76.58999633789062,
      volume: 24123697,
      average_price: 76.42,
      oi: 0,
      net_change: 0.79,
      total_buy_quantity: 6917,
      total_sell_quantity: 0,
      lower_circuit_limit: 60.64,
      upper_circuit_limit: 90.96,
      last_trade_time: "1757000551130",
      prev_close_price: 75.8,
      previous_oi: 0,
    },
  },
};

const FUTURES_QUOTE_RESPONSE = {
  status: "success",
  data: {
    "NSE_FO:TCS FUT 29 DEC 26": {
      ohlc: { open: 3900, high: 3960, low: 3880, close: 3925, volume: 1_250_000, ts: 1757000100000 },
      depth: {
        buy: [
          { quantity: 450, price: 3930.0, orders: 6 },
          { quantity: 225, price: 3929.95, orders: 2 },
        ],
        sell: [
          { quantity: 150, price: 3930.05, orders: 1 },
          { quantity: 675, price: 3930.10, orders: 5 },
        ],
      },
      timestamp: "2026-09-04T15:22:31.099+05:30",
      instrument_token: "NSE_FO|59132",
      symbol: "TCS FUT 29 DEC 26",
      last_price: 3930.0,
      volume: 1_250_000,
      oi: 24_500_000,
      previous_oi: 24_100_000,
      prev_close_price: 3925,
      total_buy_quantity: 675,
      total_sell_quantity: 825,
    },
  },
};

beforeEach(() => {
  setUniverse(parseMasterRows(MASTER_FIXTURE, FIXTURE_NOW), "UPSTOX_INSTRUMENT_MASTER");
  // the adapter refuses to call fetch without a token; supply one so the
  // mocked-global-fetch tests exercise the real request path
  setRuntimeToken("test-token-used-only-by-mocked-fetch-tests", { validated: true, userName: "test", error: null });
});

afterEach(() => {
  clearRuntimeToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("endpoint correctness (root cause B13)", () => {
  it("requests the documented Full Market Quotes endpoint, never /market-quote/full", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => FULL_QUOTE_RESPONSE,
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchQuotes(["NSE_EQ|INE848E01016"]);
      const url = String(fetchMock.mock.calls[0][0]);
      expect(url).toContain("/v2/market-quote/quotes?");
      expect(url).not.toContain("/market-quote/full");
      expect(url).toContain("instrument_key=");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("URL-encodes the pipe in instrument keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FULL_QUOTE_RESPONSE });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await fetchQuotes(["NSE_EQ|INE848E01016"]);
      expect(String(fetchMock.mock.calls[0][0])).toContain("NSE_EQ%7CINE848E01016");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("splits batches to stay under Upstox's 500-key limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const keys = Array.from({ length: 1000 }, (_, i) => `NSE_EQ|KEY${i}`);
      await fetchQuotes(keys);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of fetchMock.mock.calls) {
        const keyCount = String(call[0]).split("instrument_key=").length - 1;
        expect(keyCount).toBeLessThanOrEqual(500);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("quote response parsing (root cause B14)", () => {
  it("reads the documented field names including previous_oi and prev_close_price", () => {
    const q = parseQuote(FULL_QUOTE_RESPONSE.data["NSE_EQ:NHPC"], "NSE_EQ|INE848E01016", "NSE_EQ:NHPC")!;
    expect(q).toBeTruthy();
    expect(q.instrumentKey).toBe("NSE_EQ|INE848E01016");
    expect(q.dataKey).toBe("NSE_EQ:NHPC");
    expect(q.symbol).toBe("NHPC");
    expect(q.lastPrice).toBeCloseTo(76.59, 2);
    expect(q.prevClose).toBeCloseTo(75.8, 2);
    expect(q.oi).toBeNull();            // equity: OI genuinely zero -> unavailable
    expect(q.totalBuyQty).toBe(6917);
    expect(q.ts).toBeTruthy();
  });

  it("parses a futures quote with genuine OI and previous OI", () => {
    const q = parseQuote(FUTURES_QUOTE_RESPONSE.data["NSE_FO:TCS FUT 29 DEC 26"], "NSE_FO|59132", "NSE_FO:TCS FUT 29 DEC 26")!;
    expect(q.oi).toBe(24_500_000);
    expect(q.prevOI).toBe(24_100_000);
    expect(q.depth!.buy.length).toBe(2);
    expect(q.depth!.sell.length).toBe(2);
  });

  it("indexes quotes by instrument key, colon form, data key and symbol", () => {
    const q = parseQuote(FULL_QUOTE_RESPONSE.data["NSE_EQ:NHPC"], "NSE_EQ|INE848E01016", "NSE_EQ:NHPC")!;
    const out: Record<string, any> = {};
    indexQuote(out, q);
    expect(out["NSE_EQ|INE848E01016"]).toBe(q);
    expect(out["NSE_EQ:INE848E01016"]).toBe(q);
    expect(out["NSE_EQ:NHPC"]).toBe(q);
    expect(out["NHPC"]).toBe(q);
  });

  it("never lets a duplicate trading symbol overwrite a canonical key entry", () => {
    const a = { ...parseQuote(FULL_QUOTE_RESPONSE.data["NSE_EQ:NHPC"], "NSE_EQ|INE848E01016", "NSE_EQ:NHPC")! };
    const b = { ...a, instrumentKey: "BSE_EQ|INE848E01016", symbol: "NHPC" };
    const out: Record<string, any> = {};
    indexQuote(out, a);
    indexQuote(out, b);
    expect(out["NHPC"]).toBe(a); // first (canonical) wins
    expect(out["BSE_EQ|INE848E01016"]).toBe(b);
  });

  it("resolves a single full quote via the same documented endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => FUTURES_QUOTE_RESPONSE });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const q = await fetchFullQuote("NSE_FO|59132");
      expect(q).toBeTruthy();
      expect(q!.instrumentKey).toBe("NSE_FO|59132");
      expect(q!.oi).toBe(24_500_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("depth placeholder-row removal", () => {
  it("discards Upstox's zero-quantity placeholder depth rows", () => {
    const levels = realDepthLevels(FULL_QUOTE_RESPONSE.data["NSE_EQ:NHPC"].depth.buy);
    expect(levels.length).toBe(1); // the {0,0,0} row is dropped
    expect(levels[0]).toEqual({ price: 76.55, quantity: 6917, orders: 20 });
  });

  it("returns null depth when every level is a placeholder", () => {
    const d = normalizeDepth({ buy: [{ quantity: 0, price: 0, orders: 0 }], sell: [] });
    expect(d).toBeNull();
  });

  it("sorts bids descending and asks ascending (best first)", () => {
    const d = normalizeDepth(FUTURES_QUOTE_RESPONSE.data["NSE_FO:TCS FUT 29 DEC 26"].depth)!;
    expect(d.buy[0].price).toBeGreaterThan(d.buy[1].price);
    expect(d.sell[0].price).toBeLessThan(d.sell[1].price);
  });

  it("OBI uses only genuine displayed levels, never phantom rows", () => {
    const tcs = getInstrument("TCS")!;
    const q = parseQuote(FULL_QUOTE_RESPONSE.data["NSE_EQ:NHPC"], "NSE_EQ|INE848E01016", "NSE_EQ:NHPC")!;
    // one real bid (6917) and zero real asks -> depth exists, OBI = +1
    const d = buildDepth(tcs, q);
    expect(d.available).toBe(true);
    expect(d.totalBidQty).toBe(6917);
    expect(d.totalAskQty).toBe(0);
    expect(d.obi).toBe(1);
    expect(d.levels.length).toBe(1);
  });

  it("reports depth unavailable rather than inventing an empty book", () => {
    const tcs = getInstrument("TCS")!;
    const d = buildDepth(tcs, { depth: null });
    expect(d.available).toBe(false);
    expect(d.obi).toBeNull();
    expect(d.reason.length).toBeGreaterThan(10);
  });

  it("computes OBI from the documented formula on real two-sided depth", () => {
    const nifty = getInstrument("NIFTY")!;
    const q = parseQuote(FUTURES_QUOTE_RESPONSE.data["NSE_FO:TCS FUT 29 DEC 26"], "NSE_FO|59132", "NSE_FO:TCS FUT 29 DEC 26")!;
    const d = buildDepth(nifty, q);
    expect(d.available).toBe(true);
    expect(d.totalBidQty).toBe(675);
    expect(d.totalAskQty).toBe(825);
    expect(d.obi).toBeCloseTo((675 - 825) / 1500, 6);
    expect(d.spread).toBeCloseTo(0.05, 5);
  });
});

describe("futures quote wiring", () => {
  it("the mapped TCS futures key is resolvable in the registry", () => {
    const tcs = getInstrument("TCS")!;
    expect(tcs.futuresKey).toBe("NSE_FO|59132");
    expect(tcs.foEligible).toBe(true);
  });

  it("a futures snapshot uses previous_oi for change in OI", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("market-quote/quotes")) {
        return { ok: true, status: 200, json: async () => FUTURES_QUOTE_RESPONSE };
      }
      return { ok: true, status: 200, json: async () => ({ data: { candles: [] } }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { futuresSnapshot } = await import("@/lib/market/futures");
      const tcs = getInstrument("TCS")!;
      const snap = await futuresSnapshot(tcs, 3920);
      expect(snap.available).toBe(true);
      expect(snap.oi).toBe(24_500_000);
      expect(snap.prevOI).toBe(24_100_000);
      expect(snap.deltaOI).toBe(400_000);
      expect(snap.deltaOIPct).toBeCloseTo((400_000 / 24_100_000) * 100, 4);
      expect(snap.basis).toBeCloseTo(3930 - 3920, 6);
      expect(snap.priceOI!.label).toBe("LONG_BUILDUP");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
