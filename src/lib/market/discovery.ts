/**
 * Canonical instrument registry built from the official Upstox instrument
 * master files.
 *
 * VERIFIED SCHEMA (inspected from the live master, Oct 2026):
 *   NSE_EQ   { segment:"NSE_EQ", trading_symbol:"TCS", name:"TATA CONSULTANCY SERV LT",
 *              instrument_type:"EQ", instrument_key:"NSE_EQ|INE467B01029",
 *              isin, exchange_token, tick_size:10.0 (paise), lot_size:1 }
 *   NSE_FO   { segment:"NSE_FO", instrument_type:"FUT" | "CE" | "PE",
 *              underlying_symbol:"TCS", underlying_key:"NSE_EQ|INE467B01029",
 *              underlying_type:"EQUITY"|"INDEX", expiry:1798568999000 (epoch ms),
 *              instrument_key:"NSE_FO|59132", lot_size:225, strike_price }
 *   NSE_INDEX{ segment:"NSE_INDEX", trading_symbol:"NIFTY 50"(upper),
 *              name:"Nifty 50", instrument_key:"NSE_INDEX|Nifty 50" }
 *   BSE_INDEX{ trading_symbol:"SENSEX", instrument_key:"BSE_INDEX|SENSEX" }
 *
 * PREVIOUS BUGS THIS FILE FIXES (see README root-cause report):
 *  B1 futures filtered on instrument_type FUTSTK/FUTIDX — the master uses
 *     "FUT" (and CE/PE for options) → matched 0 rows → 0 stocks discovered.
 *  B2 expiry treated as a "YYYY-MM-DD" string — it is an epoch-ms NUMBER;
 *     the string comparison marked every contract expired.
 *  B3 futures linked to equities via `name` ("TATA CONSULTANCY SERV LT")
 *     against a map keyed by `trading_symbol` ("TCS") → never matched.
 *  B4 indices looked up by `name` in a map keyed by `trading_symbol`.
 *  B5 stocks required F&O eligibility to exist at all — cash-market charts
 *     must work for any listed equity (spec §2.7).
 *  B6 tick_size used raw (paise) instead of rupees.
 *  B7 only the NSE master was loaded, so SENSEX (BSE) could never resolve.
 *
 * Instrument keys are always taken verbatim from the master — never built
 * from a symbol string.
 */

import type { Instrument } from "./types";
import { setUniverse, registry } from "./universe";
import { fetchInstrumentMaster } from "./upstox";

const g = globalThis as typeof globalThis & { __pgDiscovery?: { at: number; pending: Promise<DiscoveryResult> | null } };
const state = (g.__pgDiscovery ??= { at: 0, pending: null });

export interface DiscoveryResult {
  ok: boolean;
  count: number;
  stocks: number;
  foEligible: number;
  indices: number;
  error: string | null;
  source: string;
  exchanges: string[];
}

/** equity instrument types that represent a normal tradable cash-market scrip */
const EQUITY_TYPES = new Set(["EQ", "BE", "BZ", "SM", "ST"]);

/** indices we expose as first-class instruments, resolved from the master */
/**
 * Verified against the live masters: index rows carry the canonical ticker
 * in `trading_symbol` ("NIFTY", "BANKNIFTY", "SENSEX") and the readable
 * label in `name` ("Nifty 50", "Nifty Bank", "BSE SENSEX"). Both are indexed,
 * and the canonical ticker is matched first.
 */
const INDEX_ALIASES: { symbol: string; match: string[]; display: string }[] = [
  { symbol: "NIFTY", match: ["NIFTY", "NIFTY 50", "NIFTY50"], display: "Nifty 50" },
  { symbol: "BANKNIFTY", match: ["BANKNIFTY", "NIFTY BANK"], display: "Nifty Bank" },
  { symbol: "FINNIFTY", match: ["FINNIFTY", "NIFTY FIN SERVICE"], display: "Nifty Financial Services" },
  { symbol: "MIDCPNIFTY", match: ["MIDCPNIFTY", "NIFTY MID SELECT"], display: "Nifty Midcap Select" },
  { symbol: "SENSEX", match: ["SENSEX", "BSE SENSEX"], display: "BSE Sensex" },
  { symbol: "BANKEX", match: ["BANKEX", "BSE BANKEX"], display: "BSE Bankex" },
];

function toRupeeTick(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0.05;
  // master expresses tick size in paise (5.0 => 0.05, 10.0 => 0.10)
  return n >= 1 ? n / 100 : n;
}

function expiryMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e11) return n;
    const p = Date.parse(v);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

export async function discover(): Promise<DiscoveryResult> {
  const fail = (error: string): DiscoveryResult => {
    setUniverse([], "NONE", error);
    return { ok: false, count: 0, stocks: 0, foEligible: 0, indices: 0, error, source: "UPSTOX_INSTRUMENT_MASTER", exchanges: [] };
  };

  const [nse, bse] = await Promise.all([
    fetchInstrumentMaster("NSE"),
    fetchInstrumentMaster("BSE").catch(() => null),
  ]);
  if (!nse || !nse.length) return fail("NSE instrument master download/parse failed — check outbound network access to assets.upstox.com.");

  const exchanges = ["NSE"];
  if (bse?.length) exchanges.push("BSE");
  const rows = [...nse, ...(bse ?? [])];
  const now = Date.now();

  // ---- pass 1: classify master rows -------------------------------------
  const equities = new Map<string, any>();      // trading_symbol -> EQ row
  const indexRows = new Map<string, any>();     // UPPER(trading_symbol|name) -> index row
  const futures: any[] = [];                    // live FUT contracts
  const optionUnderlyings = new Set<string>();  // underlyings with live CE/PE

  for (const r of rows) {
    const seg = String(r.segment ?? "");
    const type = String(r.instrument_type ?? "");

    if (seg === "NSE_EQ" || seg === "BSE_EQ") {
      if (!EQUITY_TYPES.has(type)) continue;
      if (r.security_type && r.security_type !== "NORMAL" && r.security_type !== "SME") continue;
      const sym = String(r.trading_symbol ?? "").trim();
      if (!sym || !r.instrument_key) continue;
      // NSE listing wins when a symbol exists on both exchanges
      const prev = equities.get(sym);
      if (!prev || (prev.segment === "BSE_EQ" && seg === "NSE_EQ")) equities.set(sym, r);
      continue;
    }

    if (seg === "NSE_INDEX" || seg === "BSE_INDEX") {
      const ts = String(r.trading_symbol ?? "").trim().toUpperCase();
      const nm = String(r.name ?? "").trim().toUpperCase();
      if (ts) indexRows.set(ts, r);
      if (nm && !indexRows.has(nm)) indexRows.set(nm, r);
      continue;
    }

    if (seg === "NSE_FO" || seg === "BSE_FO") {
      const exp = expiryMs(r.expiry);
      if (exp == null || exp < now) continue;            // drop expired contracts
      if (type === "FUT") futures.push({ ...r, _expiry: exp });
      else if (type === "CE" || type === "PE") {
        const u = String(r.underlying_symbol ?? r.asset_symbol ?? "").trim();
        if (u) optionUnderlyings.add(u);
      }
    }
  }

  // ---- pass 2: nearest live futures contract per underlying -------------
  const frontFut = new Map<string, any>();
  for (const f of futures) {
    const u = String(f.underlying_symbol ?? f.asset_symbol ?? "").trim();
    if (!u) continue;
    const prev = frontFut.get(u);
    if (!prev || f._expiry < prev._expiry) frontFut.set(u, f);   // nearest expiry = current contract
  }

  // ---- pass 3: build the registry ---------------------------------------
  const items: Instrument[] = [];
  const seen = new Set<string>();

  // indices first (resolved from the master, keys taken verbatim)
  for (const def of INDEX_ALIASES) {
    let row: any = null;
    for (const m of def.match) {
      row = indexRows.get(m.toUpperCase());
      if (row) break;
    }
    if (!row || !row.instrument_key) continue;
    const fut = frontFut.get(def.symbol)
      ?? futures.filter((f) => f.underlying_key === row.instrument_key).sort((a, b) => a._expiry - b._expiry)[0];
    items.push({
      symbol: def.symbol,
      name: def.display,
      kind: "index",
      instrumentKey: row.instrument_key,
      futuresKey: fut?.instrument_key,
      futuresSymbol: fut?.trading_symbol,
      futuresExpiry: fut?._expiry,
      futuresLotSize: fut ? Number(fut.lot_size) || undefined : undefined,
      foEligible: !!fut,
      exchange: String(row.exchange ?? (def.symbol === "SENSEX" || def.symbol === "BANKEX" ? "BSE" : "NSE")),
      segment: String(row.segment ?? ""),
      exchangeToken: row.exchange_token ? String(row.exchange_token) : undefined,
      sector: "INDEX",
      basePrice: 0,
      lotSize: fut ? Number(fut.lot_size) || 0 : 0,
      tickSize: toRupeeTick(fut?.tick_size ?? 5),
    });
    seen.add(def.symbol);
  }

  // every listed equity — F&O eligibility is an independent flag, NOT a gate
  for (const [sym, r] of equities) {
    if (seen.has(sym)) continue;
    const fut = frontFut.get(sym);
    // link futures by underlying_key too (authoritative), falling back to symbol
    const futByKey = fut ?? futures.find((f) => f.underlying_key === r.instrument_key);
    items.push({
      symbol: sym,
      name: String(r.name ?? sym),
      kind: "stock",
      instrumentKey: r.instrument_key,
      futuresKey: futByKey?.instrument_key,
      futuresSymbol: futByKey?.trading_symbol,
      futuresExpiry: futByKey?._expiry,
      futuresLotSize: futByKey ? Number(futByKey.lot_size) || undefined : undefined,
      foEligible: !!futByKey,
      exchange: String(r.exchange ?? "NSE"),
      segment: String(r.segment ?? "NSE_EQ"),
      isin: r.isin ? String(r.isin) : undefined,
      exchangeToken: r.exchange_token ? String(r.exchange_token) : undefined,
      sector: futByKey ? "F&O" : "CASH",
      basePrice: 0,
      lotSize: futByKey ? Number(futByKey.lot_size) || 1 : 1,
      tickSize: toRupeeTick(r.tick_size),
    });
    seen.add(sym);
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "index" ? -1 : 1;
    if (a.foEligible !== b.foEligible) return a.foEligible ? -1 : 1;
    return a.symbol.localeCompare(b.symbol);
  });

  setUniverse(items, "UPSTOX_INSTRUMENT_MASTER");
  const stocks = items.filter((i) => i.kind === "stock").length;
  const foEligible = items.filter((i) => i.foEligible && i.kind === "stock").length;
  const indices = items.filter((i) => i.kind === "index").length;
  void optionUnderlyings;
  return { ok: true, count: items.length, stocks, foEligible, indices, error: null, source: "UPSTOX_INSTRUMENT_MASTER", exchanges };
}

/** Lazily discover; refresh every 6h. Concurrent callers share one promise. */
export async function ensureDiscovery(): Promise<DiscoveryResult> {
  if (registry.items.length && Date.now() - state.at < 6 * 3600_000) {
    return {
      ok: true, count: registry.items.length,
      stocks: registry.items.filter((i) => i.kind === "stock").length,
      foEligible: registry.items.filter((i) => i.foEligible && i.kind === "stock").length,
      indices: registry.items.filter((i) => i.kind === "index").length,
      error: null, source: registry.source, exchanges: ["NSE", "BSE"],
    };
  }
  if (state.pending) return state.pending;
  state.pending = discover().finally(() => { state.at = Date.now(); state.pending = null; });
  return state.pending;
}

export function discoveryStatus() {
  return {
    source: registry.source,
    count: registry.items.length,
    stocks: registry.items.filter((i) => i.kind === "stock").length,
    foEligible: registry.items.filter((i) => i.foEligible && i.kind === "stock").length,
    indices: registry.items.filter((i) => i.kind === "index").length,
    discoveredAt: registry.discoveredAt,
    error: registry.error,
  };
}

/** exported for unit tests against recorded fixtures */
export function parseMasterRows(rows: any[], nowMs = Date.now()): Instrument[] {
  const saved = { items: registry.items, source: registry.source, error: registry.error, at: registry.discoveredAt };
  const origNow = Date.now;
  try {
    Date.now = () => nowMs;
    const out = buildFromRows(rows, nowMs);
    return out;
  } finally {
    Date.now = origNow;
    setUniverse(saved.items, saved.source, saved.error);
    registry.discoveredAt = saved.at;
  }
}

/** pure builder used by parseMasterRows (mirrors discover()'s pass 1-3) */
function buildFromRows(rows: any[], now: number): Instrument[] {
  const equities = new Map<string, any>();
  const indexRows = new Map<string, any>();
  const futures: any[] = [];
  for (const r of rows) {
    const seg = String(r.segment ?? "");
    const type = String(r.instrument_type ?? "");
    if (seg === "NSE_EQ" || seg === "BSE_EQ") {
      if (!EQUITY_TYPES.has(type)) continue;
      if (r.security_type && r.security_type !== "NORMAL" && r.security_type !== "SME") continue;
      const sym = String(r.trading_symbol ?? "").trim();
      if (!sym || !r.instrument_key) continue;
      const prev = equities.get(sym);
      if (!prev || (prev.segment === "BSE_EQ" && seg === "NSE_EQ")) equities.set(sym, r);
    } else if (seg === "NSE_INDEX" || seg === "BSE_INDEX") {
      const ts = String(r.trading_symbol ?? "").trim().toUpperCase();
      const nm = String(r.name ?? "").trim().toUpperCase();
      if (ts) indexRows.set(ts, r);
      if (nm && !indexRows.has(nm)) indexRows.set(nm, r);
    } else if (seg === "NSE_FO" || seg === "BSE_FO") {
      const exp = expiryMs(r.expiry);
      if (exp == null || exp < now) continue;
      if (type === "FUT") futures.push({ ...r, _expiry: exp });
    }
  }
  const frontFut = new Map<string, any>();
  for (const f of futures) {
    const u = String(f.underlying_symbol ?? f.asset_symbol ?? "").trim();
    if (!u) continue;
    const prev = frontFut.get(u);
    if (!prev || f._expiry < prev._expiry) frontFut.set(u, f);
  }
  const items: Instrument[] = [];
  const seen = new Set<string>();
  for (const def of INDEX_ALIASES) {
    let row: any = null;
    for (const m of def.match) { row = indexRows.get(m.toUpperCase()); if (row) break; }
    if (!row?.instrument_key) continue;
    const fut = frontFut.get(def.symbol) ?? futures.filter((f) => f.underlying_key === row.instrument_key).sort((a, b) => a._expiry - b._expiry)[0];
    items.push({
      symbol: def.symbol, name: def.display, kind: "index", instrumentKey: row.instrument_key,
      futuresKey: fut?.instrument_key, futuresSymbol: fut?.trading_symbol, futuresExpiry: fut?._expiry,
      futuresLotSize: fut ? Number(fut.lot_size) || undefined : undefined, foEligible: !!fut,
      exchange: String(row.exchange ?? "NSE"), segment: String(row.segment ?? ""),
      exchangeToken: row.exchange_token ? String(row.exchange_token) : undefined,
      sector: "INDEX", basePrice: 0, lotSize: fut ? Number(fut.lot_size) || 0 : 0, tickSize: toRupeeTick(fut?.tick_size ?? 5),
    });
    seen.add(def.symbol);
  }
  for (const [sym, r] of equities) {
    if (seen.has(sym)) continue;
    const fut = frontFut.get(sym) ?? futures.find((f) => f.underlying_key === r.instrument_key);
    items.push({
      symbol: sym, name: String(r.name ?? sym), kind: "stock", instrumentKey: r.instrument_key,
      futuresKey: fut?.instrument_key, futuresSymbol: fut?.trading_symbol, futuresExpiry: fut?._expiry,
      futuresLotSize: fut ? Number(fut.lot_size) || undefined : undefined, foEligible: !!fut,
      exchange: String(r.exchange ?? "NSE"), segment: String(r.segment ?? "NSE_EQ"),
      isin: r.isin ? String(r.isin) : undefined, exchangeToken: r.exchange_token ? String(r.exchange_token) : undefined,
      sector: fut ? "F&O" : "CASH", basePrice: 0, lotSize: fut ? Number(fut.lot_size) || 1 : 1,
      tickSize: toRupeeTick(r.tick_size),
    });
    seen.add(sym);
  }
  items.sort((a, b) => (a.kind !== b.kind ? (a.kind === "index" ? -1 : 1) : a.foEligible !== b.foEligible ? (a.foEligible ? -1 : 1) : a.symbol.localeCompare(b.symbol)));
  return items;
}
