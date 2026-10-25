/**
 * Shared futures & option-chain data service (spec §2, §4, §11).
 *
 * ROOT CAUSES FIXED HERE
 *  B9  Option expiry: /v2/option/contract returns `expiry` as EPOCH MS, but
 *      the code compared it against a "YYYY-MM-DD" string and then passed the
 *      raw number to /v2/option/chain?expiry_date=. Number >= string coerces
 *      to NaN, so the comparison was always false and the fallback sent an
 *      epoch number as expiry_date -> Upstox rejected every chain request.
 *      FIX: normalise epoch -> "YYYY-MM-DD" (IST) before selection + request.
 *  B10 Delta-OI depended on `prev_oi`, which the quote API frequently omits,
 *      so OI change was permanently null. FIX: derive previous OI from the
 *      futures contract's own daily candles (v3 candles carry OI at index 6).
 *  B11 Futures selection took "the first row returned". FIX: nearest
 *      NON-EXPIRED contract only.
 */

import type { Instrument } from "./types";
import { fetchFullQuote, fetchHistoricalCandles, fetchOptionContracts, fetchOptionChain } from "./upstox";
import { classifyStrikes, interpretPriceOI, unavailableFutures, unavailableOptions } from "./derivatives";
import { istParts, shiftDate } from "./candles";

/** epoch-ms (or ISO) -> "YYYY-MM-DD" in IST, the format Upstox expects. */
export function toExpiryDate(v: unknown): string | null {
  if (v == null) return null;
  let ms: number | null = null;
  if (typeof v === "number" && Number.isFinite(v)) ms = v;
  else if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e11) ms = n;
    else {
      const p = Date.parse(v);
      if (Number.isFinite(p)) ms = p;
    }
  }
  if (ms == null) return null;
  return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/** Nearest non-expired expiry from a contract list, as "YYYY-MM-DD". */
export function selectExpiry(rows: any[], todayStr: string): { expiry: string | null; all: string[] } {
  const all = [...new Set(
    (rows ?? []).map((r) => toExpiryDate(r?.expiry)).filter((x): x is string => !!x),
  )].sort();
  const expiry = all.find((e) => e >= todayStr) ?? null;
  return { expiry, all };
}

export interface FuturesSnapshot {
  available: boolean;
  reason: string;
  symbol: string;
  futuresKey: string | null;
  futuresSymbol: string | null;
  expiry: string | null;
  daysToExpiry: number | null;
  underlyingPrice: number | null;
  price: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  oi: number | null;
  prevOI: number | null;
  deltaOI: number | null;
  deltaOIPct: number | null;
  oiSource: string | null;
  basis: number | null;
  basisPct: number | null;
  priceOI: { label: string; provisional: boolean; caveat: string } | null;
  lotSize: number | null;
  ts: number | null;
  quality: string;
  missing: string[];
}

const g = globalThis as typeof globalThis & {
  __pgFut?: { oi: Map<string, { at: number; v: any }>; chain: Map<string, { at: number; v: any }>; contracts: Map<string, { at: number; v: any[] }> };
};
const cache = (g.__pgFut ??= { oi: new Map(), chain: new Map(), contracts: new Map() });

/** Previous-session OI for a futures contract, from its own daily candles. */
/**
 * Previous-session OI for the SAME futures contract.
 *
 * DEFECT FIXED: the previous code selected `withOI[withOI.length - 2]`.
 * The v3 historical-candle endpoint EXCLUDES the current session (verified
 * live: requesting today with a 5-day window returned only prior dates), and
 * our adapter sorts ascending — so the LAST element is already the previous
 * session. Using `length - 2` therefore compared today's OI against the
 * session BEFORE the previous one, corrupting ΔOI by one full session.
 *
 * Selection is now by DATE, not array position, and explicitly excludes
 * today so a payload that unexpectedly included the current session can
 * never be mistaken for the previous one.
 */
async function previousOI(futuresKey: string): Promise<{ prevOI: number | null; source: string; priorDate: string | null }> {
  const hit = cache.oi.get(futuresKey);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const today = istParts(Date.now()).dateStr;
  try {
    const rows = await fetchHistoricalCandles(futuresKey, "days", 1, today, shiftDate(today, -12));

    // date-keyed, ascending, excluding today
    const dated = rows
      .map((r) => ({ ...r, date: new Date(r.ts + 5.5 * 3600_000).toISOString().slice(0, 10) }))
      .filter((r) => r.date < today)
      .filter((r) => Number.isFinite(r.oi) && r.oi >= 0)   // genuine zero is allowed
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // most recent COMPLETED session strictly before today
    const prior = dated[0];
    const out = prior
      ? { prevOI: prior.oi as number, source: `previous-session OI from daily candle ${prior.date} (same contract)`, priorDate: prior.date }
      : { prevOI: null, source: "no completed-session daily candle with an OI field was returned for this contract", priorDate: null };
    cache.oi.set(futuresKey, { at: Date.now(), v: out });
    return out;
  } catch (err) {
    const out = { prevOI: null, source: `OI history request failed: ${err instanceof Error ? err.message : String(err)}`, priorDate: null };
    cache.oi.set(futuresKey, { at: Date.now(), v: out });
    return out;
  }
}

/** Complete futures snapshot for an underlying, using the mapped contract. */
export async function futuresSnapshot(inst: Instrument, underlyingPrice: number | null): Promise<FuturesSnapshot> {
  const missing: string[] = [];
  const base: FuturesSnapshot = {
    available: false, reason: "", symbol: inst.symbol,
    futuresKey: inst.futuresKey ?? null, futuresSymbol: inst.futuresSymbol ?? null,
    expiry: inst.futuresExpiry ? toExpiryDate(inst.futuresExpiry) : null,
    daysToExpiry: inst.futuresExpiry ? Math.max(0, Math.round((inst.futuresExpiry - Date.now()) / 86400000)) : null,
    underlyingPrice, price: null, change: null, changePct: null, volume: null,
    oi: null, prevOI: null, deltaOI: null, deltaOIPct: null, oiSource: null,
    basis: null, basisPct: null, priceOI: null,
    lotSize: inst.futuresLotSize ?? inst.lotSize ?? null,
    ts: null, quality: "UNAVAILABLE", missing,
  };

  if (!inst.futuresKey) {
    return { ...base, reason: `${inst.symbol} has no live futures contract in the current instrument master (cash-only scrip). Cash analysis remains available.` };
  }

  let q: any = null;
  try {
    q = await fetchFullQuote(inst.futuresKey);
  } catch (err) {
    return { ...base, reason: `Futures quote request failed for ${inst.futuresKey}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!q || q.lastPrice == null || !Number.isFinite(q.lastPrice) || q.lastPrice <= 0) {
    return { ...base, reason: `No valid futures quote returned for ${inst.futuresSymbol ?? inst.futuresKey} (normal outside market hours).` };
  }

  // Upstox supplies prev_close_price on the full quote; fall back to ohlc.close.
  const prevClose = q.prevClose ?? q.ohlc?.close ?? null;
  const change = prevClose ? q.lastPrice - prevClose : null;
  if (prevClose == null) missing.push("previous close (change/%change unavailable)");

  const oi: number | null = Number.isFinite(q.oi) && q.oi > 0 ? q.oi : null;
  if (oi == null) missing.push("open interest not present in the quote payload");
  // Upstox field name is `previous_oi` (normalised in the adapter).
  let prevOI: number | null = q.prevOI != null && q.prevOI > 0 ? q.prevOI : null;
  let oiSource = prevOI != null ? "previous_oi from the quote payload" : null;
  if (oi != null && prevOI == null) {
    const hist = await previousOI(inst.futuresKey);
    prevOI = hist.prevOI;
    oiSource = hist.source;
    if (prevOI == null) missing.push("previous-session OI (delta-OI cannot be computed)");
  }
  const deltaOI = oi != null && prevOI != null ? oi - prevOI : null;

  const basis = underlyingPrice != null && underlyingPrice > 0 ? q.lastPrice - underlyingPrice : null;
  if (underlyingPrice == null) missing.push("underlying price (basis unavailable)");

  return {
    ...base,
    available: true,
    reason: "",
    price: q.lastPrice,
    change,
    changePct: prevClose ? ((change as number) / prevClose) * 100 : null,
    volume: Number.isFinite(q.volume) ? q.volume : null,
    oi, prevOI, deltaOI,
    deltaOIPct: deltaOI != null && prevOI ? (deltaOI / prevOI) * 100 : null,
    oiSource,
    basis,
    basisPct: basis != null && underlyingPrice ? (basis / underlyingPrice) * 100 : null,
    priceOI: change != null && deltaOI != null ? interpretPriceOI(change, deltaOI) : null,
    ts: q.ts ?? Date.now(),
    quality: missing.length ? "PARTIAL" : "OK",
    missing,
  };
}

/** Option chain for the underlying with correct expiry normalisation (B9). */
export async function optionChainIntel(inst: Instrument, spot: number, atr: number): Promise<any> {
  if (!inst.foEligible) {
    return unavailableOptions(inst.symbol, `${inst.symbol} is not F&O eligible in the current instrument master — no option chain exists for this scrip.`);
  }
  const ck = `${inst.symbol}|${Math.round(spot / 25)}`;
  const hit = cache.chain.get(ck);
  if (hit && Date.now() - hit.at < 45_000) return hit.v;

  const today = istParts(Date.now()).dateStr;
  try {
    let cRows = cache.contracts.get(inst.symbol);
    if (!cRows || Date.now() - cRows.at > 6 * 3600_000) {
      cRows = { at: Date.now(), v: await fetchOptionContracts(inst.instrumentKey) };
      cache.contracts.set(inst.symbol, cRows);
    }
    const { expiry, all } = selectExpiry(cRows.v, today);
    if (!expiry) {
      const out = unavailableOptions(inst.symbol, all.length
        ? `All ${all.length} option expiries returned for ${inst.symbol} are in the past (latest ${all[all.length - 1]}).`
        : `No option contracts returned by Upstox for ${inst.instrumentKey}.`);
      cache.chain.set(ck, { at: Date.now(), v: out });
      return out;
    }
    const chain = await fetchOptionChain(inst.instrumentKey, expiry);
    if (!chain?.length) {
      const out = unavailableOptions(inst.symbol, `Option chain for ${inst.symbol} expiry ${expiry} returned no rows.`);
      cache.chain.set(ck, { at: Date.now(), v: out });
      return out;
    }
    const intel = classifyStrikes(chain, spot, Math.max(atr, spot * 0.002));
    intel.underlying = inst.symbol;
    intel.expiry = expiry;
    (intel as any).expiries = all.filter((e) => e >= today).slice(0, 6);
    (intel as any).rowsReceived = chain.length;
    cache.chain.set(ck, { at: Date.now(), v: intel });
    return intel;
  } catch (err) {
    const out = unavailableOptions(inst.symbol, `Option-chain request failed: ${err instanceof Error ? err.message : String(err)}`);
    cache.chain.set(ck, { at: Date.now(), v: out });
    return out;
  }
}

export { unavailableFutures };
