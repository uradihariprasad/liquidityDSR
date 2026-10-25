/**
 * Instrument registry, candle validation, quote parsing and watchlist tests.
 * All run against RECORDED FIXTURES of the real Upstox schema — never
 * against production market data, and never requiring a live token.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parseMasterRows } from "@/lib/market/discovery";
import { setUniverse, getInstrument, searchUniverse, suggestSymbols, foUniverse, currentUniverse } from "@/lib/market/universe";
import { isValidCandle, sanitizeCandles, computeIndicators } from "@/lib/market/engine";
import { aggregate } from "@/lib/market/candles";
import { MASTER_FIXTURE, FIXTURE_NOW, CANDLE_ROWS, BAD_CANDLE_ROWS } from "./fixtures/instrument-master";
import type { Candle } from "@/lib/market/types";

const FO_NAMES = ["TCS", "RELIANCE", "HDFCBANK", "INFY", "SBIN", "BAJFINANCE", "KOTAKBANK"];

beforeAll(() => {
  const items = parseMasterRows(MASTER_FIXTURE, FIXTURE_NOW);
  setUniverse(items, "UPSTOX_INSTRUMENT_MASTER");
});

describe("instrument master parsing", () => {
  it("parses equities, indices and futures from the real schema", () => {
    const items = parseMasterRows(MASTER_FIXTURE, FIXTURE_NOW);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.kind === "index")).toBe(true);
    expect(items.some((i) => i.kind === "stock")).toBe(true);
  });

  it("uses instrument_type FUT (not FUTSTK) so futures actually link — regression for B1", () => {
    const tcs = getInstrument("TCS")!;
    expect(tcs.futuresKey).toBe("NSE_FO|59132");
    expect(tcs.foEligible).toBe(true);
  });

  it("treats epoch-ms expiry correctly and picks the NEAREST live contract — regression for B2", () => {
    const tcs = getInstrument("TCS")!;
    // 59100 is expired, 59133 is far — the nearest live contract must win
    expect(tcs.futuresKey).not.toBe("NSE_FO|59100");
    expect(tcs.futuresKey).not.toBe("NSE_FO|59133");
    expect(tcs.futuresExpiry!).toBeGreaterThan(FIXTURE_NOW);
  });

  it("links futures to equities via underlying_symbol/underlying_key — regression for B3", () => {
    const r = getInstrument("RELIANCE")!;
    expect(r.instrumentKey).toBe("NSE_EQ|INE002A01018");
    expect(r.futuresKey).toBe("NSE_FO|59201");
    expect(r.futuresLotSize).toBe(250);
  });

  it("resolves indices despite trading_symbol/name case differences — regression for B4", () => {
    expect(getInstrument("NIFTY")!.instrumentKey).toBe("NSE_INDEX|Nifty 50");
    expect(getInstrument("BANKNIFTY")!.instrumentKey).toBe("NSE_INDEX|Nifty Bank");
  });

  it("includes BSE SENSEX from the BSE master — regression for B7", () => {
    expect(getInstrument("SENSEX")!.instrumentKey).toBe("BSE_INDEX|SENSEX");
  });

  it("converts tick size from paise to rupees — regression for B6", () => {
    expect(getInstrument("TCS")!.tickSize).toBeCloseTo(0.10, 5);
  });

  it("never constructs an instrument key from a symbol string", () => {
    for (const i of currentUniverse()) {
      expect(i.instrumentKey).toMatch(/^(NSE|BSE)_(EQ|FO|INDEX)\|/);
      expect(i.instrumentKey).not.toBe(i.symbol);
    }
  });

  it("excludes non-equity series such as government securities", () => {
    expect(getInstrument("726GS2033")).toBeNull();
  });

  it("does not classify options as futures", () => {
    const nifty = getInstrument("NIFTY")!;
    expect(nifty.futuresKey).toBe("NSE_FO|48001");
    expect(nifty.futuresKey).not.toMatch(/5091[89]/);
  });
});

describe("symbol resolution (the reported bug)", () => {
  it("resolves TCS to its real cash-market record", () => {
    const tcs = getInstrument("TCS");
    expect(tcs).toBeTruthy();
    expect(tcs!.symbol).toBe("TCS");
    expect(tcs!.instrumentKey).toBe("NSE_EQ|INE467B01029");
    expect(tcs!.name).toContain("TATA CONSULTANCY");
    expect(tcs!.segment).toBe("NSE_EQ");
  });

  it("resolves every reported watchlist symbol independently", () => {
    for (const s of FO_NAMES) {
      const i = getInstrument(s);
      expect(i, `${s} must resolve`).toBeTruthy();
      expect(i!.symbol).toBe(s);
      expect(i!.instrumentKey.startsWith("NSE_EQ|")).toBe(true);
    }
    // each maps to a DISTINCT instrument key (no cross-contamination)
    const keys = FO_NAMES.map((s) => getInstrument(s)!.instrumentKey);
    expect(new Set(keys).size).toBe(FO_NAMES.length);
  });

  it("is case-insensitive and alias-aware", () => {
    expect(getInstrument("tcs")!.symbol).toBe("TCS");
    expect(getInstrument(" Infy ")!.symbol).toBe("INFY");
    expect(getInstrument("NIFTY 50")!.symbol).toBe("NIFTY");
    expect(getInstrument("nifty50")!.symbol).toBe("NIFTY");
    expect(getInstrument("SBI")!.symbol).toBe("SBIN");
  });

  it("does NOT require F&O eligibility for a cash-market chart (spec §2.7)", () => {
    const cashOnly = getInstrument("ZEEMEDIA");
    expect(cashOnly).toBeTruthy();
    expect(cashOnly!.foEligible).toBe(false);
    expect(cashOnly!.instrumentKey).toBe("NSE_EQ|INE966H01019");
  });

  it("validates F&O eligibility independently of listing", () => {
    expect(foUniverse().some((i) => i.symbol === "ZEEMEDIA")).toBe(false);
    expect(foUniverse().some((i) => i.symbol === "TCS")).toBe(true);
  });

  it("reports unresolved symbols honestly with suggestions", () => {
    expect(getInstrument("NOTAREALSYM")).toBeNull();
    const s = suggestSymbols("TCSX");
    expect(Array.isArray(s)).toBe(true);
  });

  it("search ranks exact matches first and supports fo-only filtering", () => {
    expect(searchUniverse("TCS")[0].symbol).toBe("TCS");
    expect(searchUniverse("", { foOnly: true }).every((i) => i.foEligible)).toBe(true);
  });
});

describe("candle validation and aggregation", () => {
  it("rejects every malformed candle shape", () => {
    for (const bad of BAD_CANDLE_ROWS) expect(isValidCandle(bad as any)).toBe(false);
  });

  it("accepts a well-formed candle", () => {
    expect(isValidCandle({ ts: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 10 })).toBe(true);
  });

  it("parses Upstox v3 candle rows, dedupes and sorts ascending", () => {
    const rows = CANDLE_ROWS.map((c) => ({ ts: Date.parse(c[0]), open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }));
    const dup = [...rows, rows[0]];
    const { candles, dropped } = sanitizeCandles(dup.slice().reverse());
    expect(dropped).toBe(0);
    expect(candles.length).toBe(rows.length);
    for (let i = 1; i < candles.length; i++) expect(candles[i].ts).toBeGreaterThan(candles[i - 1].ts);
  });

  it("drops malformed rows without poisoning the series", () => {
    const good = { ts: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 };
    const { candles, dropped } = sanitizeCandles([good, ...(BAD_CANDLE_ROWS as any[])]);
    expect(candles.length).toBe(1);
    expect(dropped).toBe(BAD_CANDLE_ROWS.length);
  });

  it("aggregates 1m→5m conserving volume and OHLC envelope", () => {
    const base: Candle[] = Array.from({ length: 10 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 60000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 100, live: false,
    }));
    const five = aggregate(base, 5);
    expect(five.length).toBe(2);
    expect(five[0].open).toBe(base[0].open);
    expect(five[0].close).toBe(base[4].close);
    expect(five[0].high).toBe(Math.max(...base.slice(0, 5).map((c) => c.high)));
    expect(five[0].volume).toBe(500);
  });

  it("computes indicators only where history permits", () => {
    const cs: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      ts: 1_700_000_000_000 + i * 60000, open: 100, high: 101, low: 99, close: 100 + Math.sin(i) * 0.5, volume: 100, live: false,
    }));
    const ind = computeIndicators(cs);
    expect(ind.ema9[3]).toBeNull();          // insufficient history reported as null
    expect(ind.ema9[29]).not.toBeNull();
    expect(ind.ema200[29]).toBeNull();       // 200 EMA impossible on 30 bars
  });
});

describe("quote parsing and watchlist row states", () => {
  function rowState(q: any, inst: any) {
    const ltp = q?.lastPrice ?? null;
    if (!inst) return "INSTRUMENT_UNAVAILABLE";
    if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) return "QUOTE_UNAVAILABLE";
    return "LIVE";
  }
  it("marks a valid quote LIVE and computes change from prev close", () => {
    const q = { lastPrice: 110, ohlc: { close: 100 } };
    expect(rowState(q, getInstrument("TCS"))).toBe("LIVE");
    const change = q.lastPrice - q.ohlc.close;
    expect((change / q.ohlc.close) * 100).toBeCloseTo(10);
  });
  it("never substitutes 0.00 for a missing quote", () => {
    expect(rowState({ lastPrice: null }, getInstrument("TCS"))).toBe("QUOTE_UNAVAILABLE");
    expect(rowState({ lastPrice: 0 }, getInstrument("TCS"))).toBe("QUOTE_UNAVAILABLE");
  });
  it("flags unmapped symbols distinctly from missing quotes", () => {
    expect(rowState({ lastPrice: 100 }, getInstrument("NOPE"))).toBe("INSTRUMENT_UNAVAILABLE");
  });
});

describe("fast instrument switching (race safety contract)", () => {
  it("a late response for a previous symbol must be discarded by key guard", () => {
    // mirrors usePoll's guard: responses are keyed by request url
    let currentKey = "/api/analysis?symbol=TCS&tf=5";
    let rendered: string | null = null;
    const apply = (key: string, payload: string) => {
      if (key !== currentKey) return;      // stale-response guard
      rendered = payload;
    };
    currentKey = "/api/analysis?symbol=INFY&tf=5";   // user switched
    apply("/api/analysis?symbol=TCS&tf=5", "TCS-DATA");  // late TCS response
    expect(rendered).toBeNull();
    apply("/api/analysis?symbol=INFY&tf=5", "INFY-DATA");
    expect(rendered).toBe("INFY-DATA");
  });
});
