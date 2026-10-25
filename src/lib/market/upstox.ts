/**
 * Upstox live-data adapter (primary market-data source when configured).
 *
 * Implements the official HTTP APIs:
 *  - GET /v2/market-quote/quotes         live quotes (batch instrumental keys)
 *  - GET /v2/market-quote/ohlc           OHLC snapshot
 *  - GET /v3/historical-candle/...       historical + intraday candles
 *  - GET /v2/option/chain                option chain with Greeks/OI
 *  - GET /v2/option/contract             option contracts for an underlying
 *  - Instrument master (assets.upstox.com) for dynamic F&O universe discovery
 *
 * The access token is read ONLY from process.env.UPSTOX_ACCESS_TOKEN and is
 * never logged, never sent to the client, never persisted. All errors are
 * mapped to structured results; NOTHING here fabricates data — when the API
 * fails or is unconfigured, callers receive explicit UNAVAILABLE results.
 *
 * Streaming note: Upstox live ticks are protobuf-over-WebSocket. This
 * adapter implements the officially documented controlled polling fallback
 * (quote endpoint) which the platform uses for live updates; the WebSocket
 * protobuf feed is listed as a known limitation in the README.
 */

import { getAccessToken, hasToken, markTokenExpired, getAuthState } from "./credentials";
import {
  RateLimitError, MAX_RETRIES, parseRetryAfter, registerRateLimit, registerSuccess,
  noteRequest, noteRetry, noteCacheHit, noteDeduplicated, noteRateLimitedDrop,
  waitForCooldown, cooldownRemainingMs, coalesce, classifyPath, recordTrace,
  acquireSlot, releaseSlot, type Priority,
} from "./ratelimit";

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface UpstoxQuote {
  /** canonical instrument key, e.g. NSE_EQ|INE467B01029 */
  instrumentKey: string;
  /** data-map key as returned by the API, e.g. NSE_EQ:TCS */
  dataKey: string | null;
  /** trading symbol, e.g. TCS */
  symbol: string | null;
  lastPrice: number | null;
  ohlc: { open: number; high: number; low: number; close: number } | null;
  prevClose: number | null;
  volume: number | null;
  oi: number | null;
  prevOI: number | null;
  totalBuyQty: number | null;
  totalSellQty: number | null;
  /** depth with Upstox's zero-quantity placeholder rows REMOVED */
  depth: { buy: DepthLevel[]; sell: DepthLevel[] } | null;
  ts: number | null;
}

const BASE = "https://api.upstox.com";

/**
 * Upstox pads the depth arrays with placeholder rows
 * ({ quantity: 0, price: 0, orders: 0 }). Those are NOT real liquidity and
 * must be discarded, otherwise OBI is computed from phantom levels.
 */
function realDepthLevels(levels: any): DepthLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l: any) => ({
      price: Number(l?.price),
      quantity: Number(l?.quantity),
      orders: Number(l?.orders ?? 0),
    }))
    .filter((l) => Number.isFinite(l.price) && l.price > 0 && Number.isFinite(l.quantity) && l.quantity > 0)
    .sort((a, b) => b.price - a.price);
}

function normalizeDepth(d: any): UpstoxQuote["depth"] | null {
  if (!d || typeof d !== "object") return null;
  const buy = realDepthLevels(d.buy);
  const sell = realDepthLevels(d.sell);
  if (!buy.length && !sell.length) return null;
  // asks are returned best-first; keep ascending by price for display
  sell.sort((a, b) => a.price - b.price);
  return { buy, sell };
}

/** Parse one quote object from /v2/market-quote/quotes or /v3 equivalents. */
function parseQuote(raw: any, fallbackKey: string, dataKey: string): UpstoxQuote | null {
  if (!raw || typeof raw !== "object") return null;
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };
  const lastPrice = num(raw.last_price) ?? num(raw.lastPrice);
  const ohlc = raw.ohlc
    ? { open: Number(raw.ohlc.open), high: Number(raw.ohlc.high), low: Number(raw.ohlc.low), close: Number(raw.ohlc.close) }
    : null;
  const tsRaw = raw.timestamp ?? raw.last_trade_time;
  const ts = tsRaw ? (Number.isFinite(Number(tsRaw)) && Number(tsRaw) > 1e11 ? Number(tsRaw) : Date.parse(String(tsRaw))) : null;
  return {
    instrumentKey: String(raw.instrument_token ?? raw.instrumentKey ?? fallbackKey),
    dataKey: dataKey ?? null,
    symbol: raw.symbol ? String(raw.symbol).toUpperCase() : null,
    lastPrice,
    ohlc: ohlc && Number.isFinite(ohlc.close) && ohlc.close > 0 ? ohlc : null,
    prevClose: num(raw.prev_close_price) ?? num(raw.prevClose) ?? null,
    volume: num(raw.volume),
    oi: num(raw.oi),
    prevOI: num(raw.previous_oi) ?? num(raw.prev_oi) ?? null,
    totalBuyQty: num(raw.total_buy_quantity),
    totalSellQty: num(raw.total_sell_quantity),
    depth: normalizeDepth(raw.depth),
    ts: Number.isFinite(ts) ? ts : null,
  };
}

/**
 * Index a parsed quote under every identifier a caller might reasonably look
 * it up by. The API keys `data` by `<EXCHANGE>:<TRADING_SYMBOL>` (e.g.
 * "NSE_EQ:NHPC"), while the rest of the app keys by instrument_key
 * (e.g. "NSE_EQ|INE848E01016"). Indexing both prevents silent lookup misses.
 */
function indexQuote(out: Record<string, UpstoxQuote>, q: UpstoxQuote): void {
  // authoritative identifiers first (unique)
  out[q.instrumentKey] = q;
  out[q.instrumentKey.replace(/\|/g, ":")] = q;
  if (q.dataKey) out[q.dataKey] = q;
  // symbol is a convenience fallback only — never overwrite a canonical entry,
  // because the same trading symbol can exist on more than one exchange.
  if (q.symbol && !out[q.symbol]) out[q.symbol] = q;
}

export function upstoxConfigured(): boolean {
  return hasToken();
}

/**
 * Centralized HTTP coordination for EVERY Upstox API call.
 *
 * 429 handling (documented):
 *  - honours `Retry-After` when Upstox supplies it
 *  - otherwise exponential backoff with jitter, capped at 30s
 *  - ONE shared cooldown per 429, so concurrent requests cannot each decide
 *    to retry independently and create a request storm
 *  - up to MAX_RETRIES attempts, then the call fails with a RateLimitError
 *  - identical in-flight requests are coalesced into a single network call
 */
export interface FetchOpts {
  /** why this request exists — recorded in the trace, never a token */
  purpose?: string;
  /** sanitized instrument identifier for the trace */
  instrument?: string | null;
  /** selected-instrument traffic must never queue behind a scan */
  priority?: Priority;
  /** treat an existing fresh cached value as sufficient (records a cache hit) */
  cacheHit?: boolean;
}

/**
 * Centralized HTTP coordination for EVERY Upstox API call.
 *
 * Per-quota-class cooldown (B24): a 429 on the authenticated quote quota no
 * longer blocks the candle endpoints, which have a separate and much looser
 * quota. Bounded concurrency, per-class pacing and a priority queue (B25)
 * prevent the scanner from firing ~180 requests in a burst, and stop every
 * pending request from firing simultaneously when a cooldown clears.
 *
 * 429 handling: honour `Retry-After` when supplied, otherwise exponential
 * backoff with jitter capped at 30s, up to MAX_RETRIES attempts.
 */
async function upstoxFetch(path: string, timeoutMs = 9000, opts: FetchOpts = {}): Promise<any> {
  const token = getAccessToken();
  if (!token) {
    throw new Error(
      getAuthState().expired
        ? "Upstox access token has expired — enter a new token in the connect box to resume live data"
        : "Upstox is not connected — enter an access token in the connect box",
    );
  }

  const quota = classifyPath(path);
  const purpose = opts.purpose ?? "unspecified";
  const instrument = opts.instrument ?? null;
  const priority = opts.priority ?? "normal";

  return coalesce(`upstox:${path}`, async () => {
    // a coalesced joiner is a deduplicated request, not a second network call
    noteDeduplicated(quota);

    if (opts.cacheHit) noteCacheHit(quota);

    let lastRateLimit: RateLimitError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // per-CLASS cooldown, so unrelated endpoints are not blocked
      const cleared = await waitForCooldown(quota);
      if (!cleared) {
        const remaining = cooldownRemainingMs(quota);
        noteRateLimitedDrop(quota);
        lastRateLimit = new RateLimitError(
          `Upstox ${quota} quota is rate-limited — next attempt in ${Math.ceil(remaining / 1000)}s`,
          remaining,
          quota,
        );
        break;
      }

      await acquireSlot(quota, priority);
      const t0 = Date.now();
      let status = 0;
      try {
        noteRequest(quota);
        const res = await fetch(`${BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        });
        status = res.status;

        if (status === 401) {
          markTokenExpired("Upstox rejected the access token (HTTP 401) — it has expired or been revoked. Enter a new token to resume.");
          recordTrace({ path, endpoint: endpointOf(path), quota, purpose, instrument, status, durationMs: Date.now() - t0, attempt, cacheHit: false, deduplicated: false });
          throw new Error("Upstox token rejected (401) — enter a new access token");
        }
        if (status === 403) {
          recordTrace({ path, endpoint: endpointOf(path), quota, purpose, instrument, status, durationMs: Date.now() - t0, attempt, cacheHit: false, deduplicated: false });
          throw new Error("Upstox denied access to this endpoint (403) — your app may not be entitled to this data. Other channels are unaffected.");
        }
        if (status === 429) {
          const retryAfterSec = parseRetryAfter(res.headers?.get?.("retry-after") ?? null);
          const appliedMs = registerRateLimit(quota, retryAfterSec);
          recordTrace({ path, endpoint: endpointOf(path), quota, purpose, instrument, status, durationMs: Date.now() - t0, attempt, cacheHit: false, deduplicated: false });
          lastRateLimit = new RateLimitError(
            `Upstox ${quota} rate limit (429) — backing off ${Math.ceil(appliedMs / 1000)}s${retryAfterSec != null ? ` (Retry-After: ${retryAfterSec}s)` : ""}`,
            appliedMs,
            quota,
          );
          if (attempt === MAX_RETRIES) break;
          noteRetry(quota);
          continue;
        }
        if (!res.ok) {
          recordTrace({ path, endpoint: endpointOf(path), quota, purpose, instrument, status, durationMs: Date.now() - t0, attempt, cacheHit: false, deduplicated: false });
          throw new Error(`Upstox HTTP ${status}`);
        }
        const json = await res.json();
        registerSuccess(quota);
        recordTrace({ path, endpoint: endpointOf(path), quota, purpose, instrument, status, durationMs: Date.now() - t0, attempt, cacheHit: false, deduplicated: false });
        return json;
      } finally {
        releaseSlot(quota);
      }
    }

    throw lastRateLimit ?? new Error("Upstox request failed");
  });
}

/** Reduce a path to its endpoint family for per-endpoint counters. */
function endpointOf(path: string): string {
  const m = path.match(/^(\/v\d+\/[^/?]+)/);
  return m ? m[1] : path.split("?")[0];
}

/**
 * Batch FULL market quotes (depth + OI + OHLC).
 *
 * VERIFIED ENDPOINT: `GET /v2/market-quote/quotes?instrument_key=...`
 * This is Upstox's documented "Full Market Quotes" API. Upstox allows up to
 * 500 instrument keys per call (error UDAPI100042 above that).
 *
 * ROOT CAUSE B13 (fixed): this app previously called
 * `/v2/market-quote/full`, which is NOT a documented Upstox endpoint. Every
 * call 404'd, so depth and futures quotes were permanently unavailable —
 * the exact "Order book not being received" / "Futures channel unavailable"
 * states shown in the screenshots.
 */
export async function fetchQuotes(instrumentKeys: string[]): Promise<Record<string, UpstoxQuote>> {
  const keys = instrumentKeys.filter(Boolean);
  if (!keys.length) return {};
  const out: Record<string, UpstoxQuote> = {};
  // Upstox caps a single call at 500 instrument keys (error UDAPI100042).
  // Batch into chunks of 450 and merge — previously keys beyond the first 450
  // were silently dropped, leaving most of the universe unquoted.
  for (let i = 0; i < keys.length; i += 450) {
    const chunk = keys.slice(i, i + 450);
    const qs = chunk.map((k) => `instrument_key=${encodeURIComponent(k)}`).join("&");
    const json = await upstoxFetch(`/v2/market-quote/quotes?${qs}`, 9000, {
      purpose: "batch-quotes",
      instrument: chunk.length === 1 ? chunk[0] : `${chunk.length} instruments`,
      priority: chunk.length === 1 ? "critical" : "background",
    });
    const data = json?.data ?? {};
    for (const [dataKey, raw] of Object.entries<any>(data)) {
      // prefer the provider's own instrument_token; fall back to the data-map key
      const q = parseQuote(raw, chunk.find((k) => k.replace(/\|/g, ":") === dataKey) ?? dataKey, dataKey);
      if (q && q.lastPrice != null) indexQuote(out, q);
    }
  }
  return out;
}

/**
 * Full quote (depth + OI) for a single instrument, via the same documented
 * endpoint. Kept as a separate function because depth/OI are only needed for
 * the currently selected instrument.
 */
export async function fetchFullQuote(instrumentKey: string): Promise<UpstoxQuote | null> {
  if (!instrumentKey) return null;
  const map = await fetchQuotes([instrumentKey]);
  return (
    map[instrumentKey]
    ?? map[instrumentKey.replace(/\|/g, ":")]
    ?? null
  );
}

/** Exposed for unit tests against recorded fixtures. */
export const __testables = { parseQuote, normalizeDepth, realDepthLevels, indexQuote };

/** Token validation via the official user profile endpoint. */
export async function validateToken(token: string): Promise<{ valid: boolean; userName: string | null; error: string | null }> {
  try {
    const res = await fetch(`${BASE}/v2/user/profile`, {
      headers: { Authorization: `Bearer ${token.trim()}`, Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
      cache: "no-store",
    });
    if (res.status === 401 || res.status === 403) return { valid: false, userName: null, error: `Token rejected by Upstox (HTTP ${res.status}) — it may be expired or invalid.` };
    if (!res.ok) return { valid: false, userName: null, error: `Upstox profile check failed (HTTP ${res.status}).` };
    const json = await res.json();
    const name = json?.data?.user_name ?? json?.data?.user_id ?? null;
    return { valid: true, userName: name, error: null };
  } catch (err) {
    return { valid: false, userName: null, error: `Network error reaching Upstox: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Intraday candles via v3. unit: "minutes", interval: 1|2|3|5|10|15|30|60; or "days"/"weeks"/"months" (1). */
export async function fetchIntradayCandles(instrumentKey: string, unit: string, interval: number, opts: { purpose?: string; priority?: Priority } = {}): Promise<{ ts: number; open: number; high: number; low: number; close: number; volume: number; oi: number }[]> {
  const json = await upstoxFetch(`/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${encodeURIComponent(unit)}/${interval}`, 12000, {
    purpose: opts.purpose ?? "intraday-candles",
    instrument: instrumentKey,
    priority: opts.priority ?? "high",
  });
  const candles = json?.data?.candles ?? [];
  return candles.map((c: any[]) => ({
    ts: Date.parse(c[0]),
    open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0, oi: c[6] ?? 0,
  })).sort((a: any, b: any) => a.ts - b.ts);
}

export async function fetchHistoricalCandles(instrumentKey: string, unit: string, interval: number, toDate: string, fromDate: string, opts: { purpose?: string; priority?: Priority } = {}): Promise<{ ts: number; open: number; high: number; low: number; close: number; volume: number; oi: number }[]> {
  const json = await upstoxFetch(`/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${encodeURIComponent(unit)}/${interval}/${toDate}/${fromDate}`, 20000, {
    purpose: opts.purpose ?? "historical-candles",
    instrument: instrumentKey,
    priority: opts.priority ?? "high",
  });
  const candles = json?.data?.candles ?? [];
  return candles.map((c: any[]) => ({
    ts: Date.parse(c[0]),
    open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0, oi: c[6] ?? 0,
  })).sort((a: any, b: any) => a.ts - b.ts);
}

/** Option contracts for an underlying (drives expiry discovery). */
export async function fetchOptionContracts(instrumentKey: string): Promise<any[]> {
  const json = await upstoxFetch(`/v2/option/contract?instrument_key=${encodeURIComponent(instrumentKey)}`);
  return json?.data ?? [];
}

/** Option chain for an underlying + expiry (includes strike OI, Greeks, LTP). */
export async function fetchOptionChain(instrumentKey: string, expiryDate: string): Promise<any[]> {
  const json = await upstoxFetch(`/v2/option/chain?instrument_key=${encodeURIComponent(instrumentKey)}&expiry_date=${encodeURIComponent(expiryDate)}`);
  return json?.data ?? [];
}

/**
 * Dynamic F&O universe discovery from the public instrument master.
 * This is a large gzipped JSON file; results are cached server-side.
 * Returns null on any failure (callers must handle the unavailable state).
 */
const masterCache = new Map<string, { at: number; data: any[] }>();

/**
 * Download + parse an official Upstox instrument master for one exchange.
 * These files are public (no auth) and gzipped JSON. Cached 6h in memory.
 * Returns null on failure — callers must surface the unavailable state.
 */
export async function fetchInstrumentMaster(exchange: "NSE" | "BSE"): Promise<any[] | null> {
  const hit = masterCache.get(exchange);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;
  try {
    const res = await fetch(`https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`, {
      signal: AbortSignal.timeout(45000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`instrument master ${exchange} HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const zlib = await import("zlib");
    // the endpoint serves gzip; some proxies transparently decompress it
    let text: string;
    try {
      text = zlib.gunzipSync(buf).toString("utf-8");
    } catch {
      text = buf.toString("utf-8");
    }
    const json = JSON.parse(text);
    if (!Array.isArray(json)) throw new Error(`unexpected ${exchange} instruments payload`);
    masterCache.set(exchange, { at: Date.now(), data: json });
    return json;
  } catch {
    return null;
  }
}

/** @deprecated use fetchInstrumentMaster — kept for callers expecting NSE only */
export async function discoverUniverse(): Promise<any[] | null> {
  return fetchInstrumentMaster("NSE");
}
