/**
 * Central market-data + analytics engine — LIVE DATA ONLY.
 *
 * Every candle, quote, depth book, option chain and futures tick comes from
 * the Upstox HTTP APIs once an access token is connected. When disconnected,
 * or when the API fails, surfaces report explicit UNAVAILABLE states — the
 * engine fabricates absolutely nothing.
 */

import type {
  AnalysisBundle, Candle, DataQuality, DepthAnalysis, IndicatorSnapshots, Instrument,
} from "./types";
import { registry, getInstrument, currentUniverse, foUniverse, suggestSymbols } from "./universe";
import { ensureDiscovery, discoveryStatus } from "./discovery";
import { emptyDiagnostics, stage, categorize, type InstrumentDiagnostics } from "./diagnostics";
import { rateLimitState, schedulerState } from "./ratelimit";
import { buildDepthSnapshot, type DepthSnapshot } from "./depth";
import { unsupportedFlow } from "./flow";
import { detectAbsorption } from "./absorption";
import { detectStagedSweeps, activeStagedSweep } from "./sweepstages";
import { buildBuyerSellerIntelligence, type BuyerSellerIntelligence } from "./buyerSeller";
import { buildOiOverlay, DEFAULT_OI_OVERLAY_CONFIG } from "./oizones";
import { buildSREngine } from "./srEngine";
import { aggregate, istParts, marketSession, prevTradingDate, shiftDate, type MarketSession } from "./candles";
import { emaSeries, rsiSeries, atrSeries, bollingerSeries, vwapSeries, relVolSeries, lastNonNull } from "./indicators";
import { analyzeStructure, detectConsolidation, swingPoints } from "./structure";
import { volumeProfile } from "./profile";
import { buildZones } from "./zones";
import { classifyMovement } from "./movement";
import { detectSweeps, activeSweep } from "./sweeps";
import { computeFMPI } from "./fmpi";
import { generateScenario, DEFAULT_RISK } from "./trades";
import {
  upstoxConfigured, fetchQuotes, fetchIntradayCandles, fetchHistoricalCandles,
  fetchOptionContracts, fetchOptionChain, fetchFullQuote,
} from "./upstox";
import { unavailableFutures, unavailableOptions } from "./derivatives";
import { futuresSnapshot, optionChainIntel } from "./futures";
import type { QuickFeature } from "./scanner";
import { getRuntimeConfig } from "./runtime";
import { getAuthState } from "./credentials";

export const TIMEFRAMES = [1, 2, 3, 5, 15, 30] as const;

export function engineMode(): "LIVE_UPSTOX" | "DISCONNECTED" {
  return upstoxConfigured() ? "LIVE_UPSTOX" : "DISCONNECTED";
}

export function engineStatus() {
  const mode = engineMode();
  const session = marketSession(Date.now());
  const disc = discoveryStatus();
  const rl = rateLimitState();
  const notes: string[] = [];
  if (rl.limited) {
    notes.push(`Upstox API is rate-limited — requests are backing off for ${Math.ceil(rl.cooldownRemainingMs / 1000)}s. Cached data continues to be served and is labelled stale, never live.`);
  }
  const authState = getAuthState();
  if (mode === "DISCONNECTED") {
    notes.push(
      authState.expired
        ? `Upstox token expired — ${authState.expiredReason ?? "the credential was rejected"}. Enter a new token in the connect box at the top left to resume live data.`
        : "No Upstox access token connected — the terminal is live-data-only and is idle. Use the connect box at the top left.",
    );
  } else if (disc.count === 0) {
    notes.push(disc.error ?? "Instrument discovery not completed yet — first scan will trigger it (instrument master download takes a few seconds).");
  } else {
    notes.push(`F&O universe discovered dynamically from the Upstox instrument master (${disc.count} instruments).`);
  }
  notes.push("Streaming uses the documented controlled polling fallback against Upstox quote/candle APIs; browser updates arrive over SSE.");
  return {
    mode,
    session,
    connection: mode === "LIVE_UPSTOX" ? "TOKEN_CONNECTED" : "NOT_CONNECTED",
    auth: (() => { const a = getAuthState(); return { source: a.source, masked: a.masked, validated: a.validated, userName: a.userName, expired: a.expired, expiredReason: a.expiredReason }; })(),
    universeSource: disc.source === "UPSTOX_INSTRUMENT_MASTER" ? "UPSTOX_INSTRUMENT_MASTER" : "NONE",
    universeSize: disc.count,
    discoveryError: disc.error,
    timeframes: TIMEFRAMES,
    serverTime: Date.now(),
    notes,
    // Shared API health. Per-quota-class so a quote-quota 429 is never
    // misreported as every data source failing.
    rateLimit: (() => {
      const st = schedulerState();
      return {
        status: st.status,
        limited: st.limited,
        cooldownRemainingMs: st.cooldownRemainingMs,
        retryAfterSec: st.retryAfterSec,
        last429At: st.last429At,
        lastSuccessAt: st.lastSuccessAt,
        totalRequests: st.totalRequests,
        total429: st.total429,
        totalRetries: st.totalRetries,
        cacheHits: st.cacheHits,
        deduplicated: st.deduplicated,
        inFlight: st.inFlight,
        pendingQueueSize: st.pendingQueueSize,
        perEndpoint: st.perEndpoint,
        classes: st.classes,
        // sanitized request trace: endpoint, status, purpose, duration,
        // instrument and quota. Paths never contain an access token.
        trace: st.trace.slice(-40),
      };
    })(),
    lastSuccessfulFetch: schedulerState().lastSuccessAt,
  };
}

// ---------------------------------------------------------------------------
// Data-quality helper
// ---------------------------------------------------------------------------

function qualityFor(lastCandleTs: number | null, extra: string[] = []): DataQuality {
  const mode = engineMode();
  const warnings: string[] = [...extra];
  if (mode === "DISCONNECTED") warnings.push("Upstox not connected — no market data is being fetched. Analysis is suspended until a token is connected.");
  return {
    mode,
    status: lastCandleTs ? "OK" : mode === "DISCONNECTED" ? "UNAVAILABLE" : "STALE",
    lastTickTs: lastCandleTs ? Date.now() : null,
    lastCandleTs,
    marketSession: marketSession(Date.now()),
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Candle access (live only, with short caches)
// ---------------------------------------------------------------------------

interface CandlePack {
  candles1m: Candle[];
  dateStr: string;
  error: string | null;
  fetchedAt: number | null;
  latencyMs: number | null;
  /** trading sessions present in the merged series (YYYY-MM-DD, ascending) */
  sessions: string[];
  /** true when prior-session history was successfully merged in */
  historyLoaded: boolean;
  /** non-fatal note when history could not be fetched (chart shows today only) */
  historyError: string | null;
  rangeFrom: number | null;
  rangeTo: number | null;
}

const g = globalThis as typeof globalThis & { __pgCaches?: any; __pgSched?: any; __pgSnaps?: any };
const caches = (g.__pgCaches ??= {
  candles: new Map<string, { at: number; pack: CandlePack }>(),
  daily: new Map<string, { at: number; levels: any }>(),
  contracts: new Map<string, { at: number; rows: any[] }>(),
  chain: new Map<string, { at: number; intel: any }>(),
  depth: new Map<string, { at: number; quote: any }>(),
  bundles: new Map<string, { at: number; bundle: AnalysisBundle }>(),
  quotes: null as null | { at: number; map: Record<string, any> },
  wlQuotes: null as null | { at: number; map: Record<string, any> },
  scan: null as null | { at: number; features: QuickFeature[] },
});

/**
 * Validate a raw candle row before it can enter any downstream calculation
 * (spec §5). Rejects implausible prices, broken OHLC relationships, bad
 * timestamps and negative volume.
 */
export function isValidCandle(c: { ts: number; open: number; high: number; low: number; close: number; volume: number }): boolean {
  const { ts, open, high, low, close, volume } = c;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  for (const v of [open, high, low, close]) {
    if (!Number.isFinite(v) || v <= 0) return false;
  }
  if (high < low) return false;
  if (high < open - 1e-6 || high < close - 1e-6) return false;
  if (low > open + 1e-6 || low > close + 1e-6) return false;
  if (!Number.isFinite(volume) || volume < 0) return false;
  return true;
}

/** Deduplicate by timestamp, drop invalid rows, and sort ascending. */
export function sanitizeCandles(rows: { ts: number; open: number; high: number; low: number; close: number; volume: number }[]): { candles: Candle[]; dropped: number } {
  const byTs = new Map<number, Candle>();
  let dropped = 0;
  for (const r of rows) {
    if (!isValidCandle(r)) { dropped++; continue; }
    byTs.set(r.ts, { ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, live: false });
  }
  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { candles, dropped };
}

/** Number of PRIOR completed sessions merged in behind today (spec §1). */
export const HISTORY_SESSIONS = 4;

/**
 * Build the 1-minute series for an instrument.
 *
 * ROOT CAUSE B21 (fixed): this previously fetched ONLY the v3 intraday
 * endpoint, which returns the current session alone. Early in the day that is
 * a few dozen 1-minute candles — e.g. 133 at 11:28 IST, which is just 26
 * completed 5-minute candles. FMPI requires 30 completed candles, so it
 * returned 0.0 / INSUFFICIENT_DATA, which cascaded into "0 eligible" in the
 * scanner and an empty Trade Finder.
 *
 * It now merges real prior-session history (v3 historical-candle, which
 * EXCLUDES today) with today's intraday candles, de-duplicated by timestamp.
 * A history failure is non-fatal and surfaced as `historyError` — the chart
 * never silently pretends today's candles are the full range.
 */
async function candlePack(symbol: string, priority: "high" | "background" = "high"): Promise<CandlePack> {
  const base = {
    dateStr: istParts(Date.now()).dateStr, fetchedAt: null, latencyMs: null,
    sessions: [] as string[], historyLoaded: false, historyError: null, rangeFrom: null, rangeTo: null,
  };
  const inst = getInstrument(symbol);
  if (!inst) return { ...base, candles1m: [], error: `Unknown instrument "${symbol}" — not in the discovered universe.` };
  if (!upstoxConfigured()) return { ...base, candles1m: [], error: "Upstox is not connected." };
  const hit = caches.candles.get(symbol);
  if (hit && Date.now() - hit.at < 9000) return hit.pack;
  const t0 = Date.now();

  const today = istParts(Date.now()).dateStr;
  // widen the window so holidays/weekends still yield HISTORY_SESSIONS days
  const from = shiftDate(today, -(HISTORY_SESSIONS * 3 + 7));

  // prior sessions and today are fetched in parallel; each can fail alone
  const [histRes, intraRes] = await Promise.allSettled([
    fetchHistoricalCandles(inst.instrumentKey, "minutes", 1, today, from, { purpose: "chart-history", priority }),
    fetchIntradayCandles(inst.instrumentKey, "minutes", 1, { purpose: "chart-intraday", priority }),
  ]);

  let historyError: string | null = null;
  let histRows: any[] = [];
  if (histRes.status === "fulfilled") histRows = histRes.value;
  else historyError = `Prior-session history unavailable: ${histRes.reason instanceof Error ? histRes.reason.message : String(histRes.reason)}`;

  let intraRows: any[] = [];
  let intraError: string | null = null;
  if (intraRes.status === "fulfilled") intraRows = intraRes.value;
  else intraError = intraRes.reason instanceof Error ? intraRes.reason.message : String(intraRes.reason);

  if (!histRows.length && !intraRows.length) {
    const pack: CandlePack = {
      ...base,
      candles1m: [],
      error: intraError ?? historyError ?? `Upstox returned no candles for ${inst.instrumentKey} (holiday, or before 09:15 IST with no history).`,
      fetchedAt: Date.now(), latencyMs: Date.now() - t0, historyError,
    };
    caches.candles.set(symbol, { at: Date.now(), pack });
    return pack;
  }

  // merge + validate; sanitizeCandles de-duplicates by timestamp and sorts
  const { candles: merged, dropped } = sanitizeCandles([...histRows, ...intraRows]);

  // keep only the last N sessions plus today, so charts stay bounded
  const allSessions = [...new Set(merged.map((c) => new Date(c.ts + 5.5 * 3600_000).toISOString().slice(0, 10)))].sort();
  const keep = new Set(allSessions.slice(-(HISTORY_SESSIONS + 1)));
  const candles = merged.filter((c) => keep.has(new Date(c.ts + 5.5 * 3600_000).toISOString().slice(0, 10)));
  const sessions = [...keep].sort();

  // the final candle of the CURRENT session is the forming one
  if (candles.length) {
    const lastSession = sessions[sessions.length - 1];
    if (lastSession === today && marketSession(Date.now()) === "OPEN") {
      candles[candles.length - 1].live = true;
    }
  }

  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} malformed candle row(s) rejected by validation.`);
  if (historyError) notes.push(historyError);
  if (intraError) notes.push(`Today's intraday candles unavailable: ${intraError}`);

  const pack: CandlePack = {
    candles1m: candles,
    dateStr: today,
    error: notes.length ? notes.join(" ") : null,
    fetchedAt: Date.now(),
    latencyMs: Date.now() - t0,
    sessions,
    historyLoaded: sessions.length > 1,
    historyError,
    rangeFrom: candles.length ? candles[0].ts : null,
    rangeTo: candles.length ? candles[candles.length - 1].ts : null,
  };
  caches.candles.set(symbol, { at: Date.now(), pack });
  return pack;
}

/** Previous-day & previous-week levels from real daily history (v3). */
async function liveDayLevels(inst: Instrument): Promise<{ prevClose: number; prevHigh: number; prevLow: number; prevWeekHigh: number | null; prevWeekLow: number | null } | null> {
  const key = inst.symbol;
  const hit = caches.daily.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.levels;
  if (!upstoxConfigured()) return null;
  try {
    const today = istParts(Date.now()).dateStr;
    const from = shiftDate(today, -14);
    const rows = await fetchHistoricalCandles(inst.instrumentKey, "days", 1, today, from);
    if (!rows.length) return null;
    const trading = rows.filter((r) => r.ts < Date.parse(today + "T00:00:00Z") - 5.5 * 3600_000);
    if (!trading.length) return null;
    const prev = trading[trading.length - 1];
    const week = trading.slice(-5);
    const levels = {
      prevClose: prev.close,
      prevHigh: prev.high,
      prevLow: prev.low,
      prevWeekHigh: Math.max(...week.map((r) => r.high)),
      prevWeekLow: Math.min(...week.map((r) => r.low)),
    };
    caches.daily.set(key, { at: Date.now(), levels });
    return levels;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Indicators / chart events (reused pure engines)
// ---------------------------------------------------------------------------

export function computeIndicators(candles: Candle[], sessionStartIdx = 0): IndicatorSnapshots {
  const closes = candles.map((c) => c.close);
  const bb = bollingerSeries(closes, 20, 2);
  // VWAP is a SESSION statistic: compute it only over the current session and
  // leave earlier bars null, so a multi-day series cannot distort it.
  const vwapFull: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length) {
    const seg = vwapSeries(candles.slice(sessionStartIdx));
    for (let i = 0; i < seg.length; i++) vwapFull[sessionStartIdx + i] = seg[i];
  }
  return {
    ema9: emaSeries(closes, 9), ema21: emaSeries(closes, 21), ema50: emaSeries(closes, 50), ema200: emaSeries(closes, 200),
    vwap: vwapFull, rsi: rsiSeries(closes, 14),
    bbMid: bb.mid, bbUp: bb.up, bbLo: bb.lo,
    atr: atrSeries(candles, 14), relVol: relVolSeries(candles, 20),
  };
}

function chartEvents(
  candles: Candle[],
  atr: (number | null)[],
  structureEvents: ReturnType<typeof analyzeStructure>,
  sweeps: ReturnType<typeof detectSweeps>,
) {
  const events: { ts: number; kind: string; text: string; price: number }[] = [];
  const done = candles.filter((c) => !c.live);
  if (structureEvents.lastBOS) events.push({ ts: structureEvents.lastBOS.ts, kind: "BOS", text: `BOS ${structureEvents.lastBOS.direction}`, price: structureEvents.lastBOS.level });
  if (structureEvents.lastCHOCH) events.push({ ts: structureEvents.lastCHOCH.ts, kind: "CHOCH", text: `CHOCH ${structureEvents.lastCHOCH.direction}`, price: structureEvents.lastCHOCH.level });
  // validated sweeps only (FAILED/EXPIRED are kept out of the chart overlay)
  for (const s of sweeps) {
    if (s.state === "CONFIRMED" || s.state === "DETECTED") {
      events.push({ ts: s.ts, kind: s.state === "CONFIRMED" ? "SWEEP" : "SWEEP?", text: `${s.side} sweep ${s.state.toLowerCase()}`, price: s.extreme });
    }
  }
  for (let i = 25; i < done.length; i++) {
    const c = done[i];
    const a = atr[i];
    if (!a) continue;
    const range = c.high - c.low;
    const avgRange = done.slice(Math.max(0, i - 20), i).reduce((s, x) => s + (x.high - x.low), 0) / 20;
    if (avgRange > 0 && range > avgRange * 1.8 && Math.abs(c.close - c.open) / range > 0.6) {
      events.push({ ts: c.ts, kind: "EXPANSION", text: "range expansion", price: c.close });
    }
  }
  return events.slice(-30);
}

// ---------------------------------------------------------------------------
// Market depth (stocks via equity full quote; indices have no book)
// ---------------------------------------------------------------------------

async function liveQuoteFor(inst: Instrument, key: string): Promise<any> {
  const hit = caches.depth.get(key);
  if (hit && Date.now() - hit.at < 4000) return hit.quote;
  try {
    const q = await fetchFullQuote(key);
    caches.depth.set(key, { at: Date.now(), quote: q });
    return q;
  } catch {
    return null;
  }
}

export function buildDepth(inst: Instrument, quote: any): DepthAnalysis {
  const isIndex = inst.kind === "index";
  const sourceNote = isIndex
    ? `An index is a calculated value with no order book of its own — the book shown is the mapped FUTURES contract (${inst.futuresKey ?? "unmapped"}), never the index spot.`
    : `Equity order book for ${inst.symbol}.`;
  const capabilityNote =
    sourceNote +
    " Market depth is DISPLAYED liquidity, not executed order flow. OBI = (BidQty − AskQty) / (BidQty + AskQty) over the displayed levels; it does not guarantee directional movement. Disappeared displayed quantity may be cancelled, modified or moved — it is not reported as executed. Visible quantities are never labelled institutional orders.";
  // A payload containing depth can only have come from a live authenticated
  // call, so it is rendered on its own merit; the connection check applies
  // only when there is no payload to show.
  if (!quote?.depth || !(quote.depth.buy ?? []).length) {
    return {
      available: false,
      reason: !upstoxConfigured()
        ? "Upstox is not connected — no depth is being fetched. Connect your access token (top-left) to activate the live order book."
        : isIndex && !inst.futuresKey
          ? "No futures contract is mapped for this index, so there is no order book to display."
          : "Depth is not present in the latest quote payload — this is normal outside market hours; it populates during the live session.",
      ts: null, bestBid: null, bestAsk: null, spread: null, spreadBps: null,
      levels: [], totalBidQty: null, totalAskQty: null, obi: null, obiWindow: "5 levels (when available)",
      walls: [], capabilityNote,
    };
  }
  // Depth arrives pre-sanitised: Upstox's zero-quantity placeholder rows are
  // already removed in the adapter, so OBI uses only genuine displayed levels.
  const buy = (quote.depth.buy ?? []) as { price: number; quantity: number; orders: number }[];
  const sell = (quote.depth.sell ?? []) as { price: number; quantity: number; orders: number }[];
  const bestBid = buy[0]?.price ?? null;
  const bestAsk = sell[0]?.price ?? null;
  const totalBid = buy.reduce((a, l) => a + l.quantity, 0);
  const totalAsk = sell.reduce((a, l) => a + l.quantity, 0);
  const obi = totalBid + totalAsk > 0 ? (totalBid - totalAsk) / (totalBid + totalAsk) : null;
  const meanQty = (totalBid + totalAsk) / Math.max(1, buy.length + sell.length);
  const walls = [
    ...buy.filter((l) => l.quantity > meanQty * 2.5).map((l) => ({ side: "bid" as const, price: l.price, qty: l.quantity, note: "Displayed bid quantity > 2.5× mean displayed level." })),
    ...sell.filter((l) => l.quantity > meanQty * 2.5).map((l) => ({ side: "ask" as const, price: l.price, qty: l.quantity, note: "Displayed ask quantity > 2.5× mean displayed level." })),
  ];
  const levels = buy.slice(0, 5).map((b, i) => ({
    price: b.price, bidQty: b.quantity, askQty: sell[i]?.quantity ?? 0,
    bidOrders: b.orders ?? 0, askOrders: sell[i]?.orders ?? 0,
  }));
  return {
    available: true, reason: "", ts: quote.ts ?? Date.now(),
    bestBid, bestAsk,
    spread: bestBid != null && bestAsk != null ? Math.round((bestAsk - bestBid) * 100) / 100 : null,
    spreadBps: bestBid != null && bestAsk != null && bestBid > 0 ? Math.round(((bestAsk - bestBid) / bestBid) * 1e6) / 100 : null,
    levels, totalBidQty: totalBid, totalAskQty: totalAsk,
    obi: obi != null ? Math.round(obi * 1000) / 1000 : null,
    obiWindow: `${Math.min(5, buy.length)} levels`,
    walls, capabilityNote,
  };
}

// ---------------------------------------------------------------------------
// Option-chain intelligence (live, cached)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Full analysis bundle
// ---------------------------------------------------------------------------

export async function getAnalysis(symbol: string, tfMinutes: number, opts: { foreground?: boolean } = {}): Promise<AnalysisBundle | null> {
  const key = `${symbol}|${tfMinutes}`;
  const hit = caches.bundles.get(key);
  if (hit && Date.now() - hit.at < 2500) return hit.bundle;

  const diag = emptyDiagnostics(symbol);

  // --- stage: discovery ---------------------------------------------------
  if (!upstoxConfigured()) {
    diag.stages.discovery = stage("SKIPPED", "Upstox not connected — instrument master not downloaded.");
  } else {
    if (registry.items.length === 0) await ensureDiscovery();
    const d = discoveryStatus();
    diag.stages.discovery = d.count
      ? stage("OK", `${d.stocks} equities (${d.foEligible} F&O-eligible) + ${d.indices} indices from the Upstox masters.`, { count: d.count })
      : stage("ERROR", d.error ?? "instrument master unavailable");
  }

  // --- stage: resolve -----------------------------------------------------
  const resolved = getInstrument(symbol);
  const inst2 = resolved ?? placeholderInstrument(symbol);
  if (!resolved) {
    diag.stages.resolve = stage("ERROR", `"${symbol}" did not resolve to any record in the instrument master.`);
    diag.suggestions = suggestSymbols(symbol);
    const reason = upstoxConfigured()
      ? `"${symbol}" is not present in the Upstox instrument master — it may have been renamed, delisted, or the symbol is misspelled.${diag.suggestions.length ? ` Closest matches: ${diag.suggestions.join(", ")}.` : ""}`
      : "Upstox is not connected — connect your access token (top-left) to discover the universe and stream live data.";
    return buildUnavailableBundle(inst2, tfMinutes, reason, diag);
  }
  diag.resolvedSymbol = resolved.symbol;
  diag.resolvedName = resolved.name;
  diag.instrumentKey = resolved.instrumentKey;
  diag.futuresKey = resolved.futuresKey ?? null;
  diag.exchange = resolved.exchange;
  diag.segment = resolved.segment;
  diag.foEligible = resolved.foEligible;
  diag.stages.resolve = stage("OK", `${resolved.symbol} → ${resolved.instrumentKey} (${resolved.segment}, ${resolved.foEligible ? "F&O eligible" : "cash only"})`);

  // --- stage: intraday candles -------------------------------------------
  const pack = await candlePack(symbol, opts.foreground ? "high" : "background");
  diag.freshness.lastCandleTs = pack.candles1m.length ? pack.candles1m[pack.candles1m.length - 1].ts : null;
  diag.stages.candles = pack.candles1m.length
    ? stage(
        pack.historyLoaded ? "OK" : "EMPTY",
        `${pack.candles1m.length} one-minute candles across ${pack.sessions.length} session(s): ${pack.sessions.join(", ")}` +
          (pack.historyError ? ` — ${pack.historyError}` : ""),
        { count: pack.candles1m.length, latencyMs: pack.latencyMs ?? undefined },
      )
    : stage(
        pack.error ? "ERROR" : "EMPTY",
        // Name the affected quota so a quote-quota 429 is not misreported as a
        // candle failure, and a candle-quota 429 is not blamed on quotes.
        isRateLimitMessage(pack.error ?? "")
          ? `${pack.error} (affected quota: ${candleQuotaName()})`
          : pack.error ?? "no rows returned",
        { latencyMs: pack.latencyMs ?? undefined },
      );

  if (pack.error || !pack.candles1m.length) {
    return buildUnavailableBundle(inst2, tfMinutes, pack.error ?? "No intraday candles returned.", diag);
  }

  const computed = aggregate(pack.candles1m, tfMinutes);
  // VWAP must reset at the current session's first bar, not at the first
  // bar of the merged multi-session series.
  const sessionStartIdx = (() => {
    const d = (ts: number) => new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10);
    const last = pack.sessions.length ? pack.sessions[pack.sessions.length - 1] : null;
    if (!last) return 0;
    const i = computed.findIndex((c) => d(c.ts) === last);
    return i >= 0 ? i : 0;
  })();
  const indicators = computeIndicators(computed, sessionStartIdx);
  const atrNow = lastNonNull(indicators.atr) ?? 0;
  const structure = analyzeStructure(computed);
  // The profile uses the SAME series as the chart, zones and movement
  // classifier, and the instrument's real tick size so every level lands on a
  // tradable price for this instrument.
  const profile = volumeProfile(computed, atrNow, {
    tickSize: inst2.tickSize,
    periodLabel: pack.sessions.length > 1 ? "MULTI_SESSION" : "SINGLE_SESSION",
  });

  const dl = await liveDayLevels(inst2);
  diag.stages.dailyHistory = dl
    ? stage("OK", `previous close ${dl.prevClose}, PDH ${dl.prevHigh}, PDL ${dl.prevLow} from daily candles`)
    : stage("EMPTY", "Daily history unavailable — PDH/PDL/PWH/PWL fall back to today's session and are marked provisional.");
  diag.stages.indicators = stage("OK", `EMA/VWAP/RSI/ATR/Bollinger/relVol computed on ${tfMinutes}m series`);
  /**
   * Session scoping (critical after the history merge): day open/high/low,
   * the opening range and VWAP must describe TODAY ONLY. Using the full
   * multi-session series here would silently produce multi-day highs/lows
   * and a multi-day VWAP.
   */
  const istDay = (ts: number) => new Date(ts + 5.5 * 3600_000).toISOString().slice(0, 10);
  const currentSession = pack.sessions.length ? pack.sessions[pack.sessions.length - 1] : pack.dateStr;
  const todays1m = pack.candles1m.filter((c) => istDay(c.ts) === currentSession);
  const sessionBars = todays1m.length ? todays1m : pack.candles1m;
  const orSlice = sessionBars.slice(0, 15);
  const lastPrice = computed[computed.length - 1].close;
  const day = {
    date: currentSession,
    open: sessionBars[0]?.open ?? 0,
    high: Math.max(...sessionBars.map((c) => c.high)),
    low: Math.min(...sessionBars.map((c) => c.low)),
    prevClose: dl?.prevClose ?? 0,
    prevHigh: dl?.prevHigh ?? Math.max(...sessionBars.map((c) => c.high)),
    prevLow: dl?.prevLow ?? Math.min(...sessionBars.map((c) => c.low)),
    prevWeekHigh: dl?.prevWeekHigh ?? null,
    prevWeekLow: dl?.prevWeekLow ?? null,
    orHigh: orSlice.length >= 15 ? Math.max(...orSlice.map((c) => c.high)) : null,
    orLow: orSlice.length >= 15 ? Math.min(...orSlice.map((c) => c.low)) : null,
    replay: false,
  };

  const consolidation = detectConsolidation(computed, atrNow);
  const sweeps = detectSweeps(computed, indicators.atr, indicators.relVol);
  const vwapNow = lastNonNull(indicators.vwap);
  const zones = buildZones({
    candles: computed, atr: atrNow, swings: swingPoints(computed),
    day: { prevHigh: day.prevHigh, prevLow: day.prevLow, prevWeekHigh: day.prevWeekHigh, prevWeekLow: day.prevWeekLow, orHigh: day.orHigh, orLow: day.orLow },
    profile, consolidation, sweeps,
    // Dynamic S&R Engine: session extremes and VWAP references
    sessionHigh: sessionBars.length ? Math.max(...sessionBars.map((c) => c.high)) : null,
    sessionLow: sessionBars.length ? Math.min(...sessionBars.map((c) => c.low)) : null,
    vwap: vwapNow,
  });
  const movement = classifyMovement({ candles: computed, tfMinutes, indicators, structure, zones, profile, atrNow, sweeps });

  // ---- live derivatives channels (shared futures/options service) ------
  const futQuote = inst2.futuresKey ? await liveQuoteFor(inst2, inst2.futuresKey) : null;
  /**
   * Depth source: a stock has its own order book; an index does not, so for
   * indices we show the mapped FUTURES contract's book and label it clearly.
   */
  const depthQuote = inst2.kind === "stock"
    ? await liveQuoteFor(inst2, inst2.instrumentKey)
    : futQuote;

  const futuresIntel = await futuresSnapshot(inst2, lastPrice);

  diag.stages.quote = futuresIntel.available
    ? stage("OK", `futures ${futuresIntel.futuresSymbol ?? futuresIntel.futuresKey} @ ${futuresIntel.price} (expiry ${futuresIntel.expiry})`)
    : stage(inst2.futuresKey ? "EMPTY" : "SKIPPED", futuresIntel.reason);
  diag.freshness.lastQuoteTs = futuresIntel.ts;
  diag.freshness.lastTickTs = pack.fetchedAt;
  diag.stages.depth = depthQuote?.depth?.buy?.length
    ? stage("OK", `${depthQuote.depth.buy.length} bid / ${depthQuote.depth.sell?.length ?? 0} ask levels on ${inst2.kind === "index" ? inst2.futuresSymbol ?? "futures" : inst2.symbol}`)
    : stage("EMPTY", inst2.kind === "index" ? "Index has no own book; futures book not returned." : "No depth levels in the latest quote payload.");
  diag.freshness.lastDepthTs = depthQuote?.depth?.buy?.length ? (depthQuote.ts ?? null) : null;

  const optIntel = await optionChainIntel(inst2, lastPrice, atrNow);
  diag.stages.optionChain = optIntel?.available
    ? stage("OK", `${optIntel.strikes?.length ?? 0} classified strikes, expiry ${optIntel.expiry}`)
    : stage(inst2.foEligible ? "EMPTY" : "SKIPPED", optIntel?.reason ?? "unavailable");
  diag.freshness.lastOptionChainTs = optIntel?.available ? optIntel.ts : null;

  const fmpi = computeFMPI({
    candles: computed, indicators, structure, zones, profile, atrNow, movement,
    futures: futuresIntel.available && futuresIntel.change != null
      ? { priceAligned: Math.sign(futuresIntel.change) === Math.sign(movement.bias === "BEARISH" ? -1 : 1), oiNote: futuresIntel.priceOI?.caveat ?? null }
      : null,
    dataQuality: { status: "OK", stale: false },
  });

  const scenario = generateScenario({
    symbol, tf: `${tfMinutes}m`, candles: computed, atr: atrNow, zones, structure, fmpi, movement,
    quality: qualityFor(computed[computed.length - 1].ts),
    risk: getRuntimeConfig().risk as any,
    spreadBps: null,
  });

  const events = chartEvents(computed, indicators.atr, structure, sweeps);
  const displayCandles = computed.slice(-260);
  const sliceStart = computed.length - displayCandles.length;
  const sliceArr = (arr: (number | null)[]) => arr.slice(sliceStart);

  const bundle: AnalysisBundle = {
    symbol: inst2.symbol, label: inst2.name, kind: inst2.kind, sector: inst2.sector, tf: `${tfMinutes}m`, tfMinutes,
    ts: Date.now(),
    quality: qualityFor(computed[computed.length - 1].ts, dl ? [] : ["Daily history unavailable — PDH/PDL/PWH/PWL zones are approximated from today's session (marked provisional)."]),
    day, candles: displayCandles,
    indicators: {
      ema9: sliceArr(indicators.ema9), ema21: sliceArr(indicators.ema21), ema50: sliceArr(indicators.ema50), ema200: sliceArr(indicators.ema200),
      vwap: sliceArr(indicators.vwap), rsi: sliceArr(indicators.rsi), bbMid: sliceArr(indicators.bbMid), bbUp: sliceArr(indicators.bbUp), bbLo: sliceArr(indicators.bbLo),
      atr: sliceArr(indicators.atr), relVol: sliceArr(indicators.relVol),
    },
    last: {
      price: lastPrice,
      change: day.prevClose ? lastPrice - day.prevClose : 0,
      changePct: day.prevClose ? ((lastPrice - day.prevClose) / day.prevClose) * 100 : 0,
      volume: computed.reduce((a, c) => a + c.volume, 0),
      relVol: lastNonNull(indicators.relVol), atr: atrNow, rsi: lastNonNull(indicators.rsi), vwap: lastNonNull(indicators.vwap),
    },
    structure, zones, profile, movement, fmpi, scenario,
    depth: buildDepth(inst2, depthQuote),
    futures: futuresIntel,
    optionLevels: optIntel,
    footprint: footprintCapability(profile),
    events: events.filter((e) => displayCandles.some((c) => c.ts === e.ts)),
  };
  (bundle as any).lotSize = inst2.lotSize;
  (bundle as any).riskConfig = getRuntimeConfig().risk;
  (bundle as any).sweeps = sweeps;
  (bundle as any).activeSweep = activeSweep(sweeps);
  (bundle as any).instrumentKeys = { spot: inst2.instrumentKey, futures: inst2.futuresKey ?? null };
  (bundle as any).foEligible = inst2.foEligible;
  // MODULE G: unified buyer/seller intelligence. Uses the SAME depth snapshot
  // the depth panel uses (no second fetch) and the SAME candles/zones/sweeps.
  {
    const depthContractKey = inst2.kind === "index" ? (inst2.futuresKey ?? inst2.instrumentKey) : inst2.instrumentKey;
    const depthContractLabel = inst2.kind === "index"
      ? (inst2.futuresSymbol ?? "mapped futures contract")
      : `${inst2.symbol} (cash)`;
    const snap: DepthSnapshot | null = depthQuote?.depth
      ? buildDepthSnapshot({
          instrumentKey: inst2.instrumentKey,
          contractKey: depthContractKey,
          contractLabel: depthContractLabel,
          exchange: inst2.exchange,
          depth: depthQuote.depth,
          eventTs: depthQuote.ts ?? null,
        })
      : null;
    const flow = unsupportedFlow();
    const staged = detectStagedSweeps(computed, indicators.atr, indicators.relVol);
    const absorption = detectAbsorption({ candles: computed, zones, atr: atrNow, flow, price: lastPrice });
    (bundle as any).buyerSeller = buildBuyerSellerIntelligence({
      symbol: inst2.symbol,
      underlyingLabel: inst2.name,
      underlyingKey: inst2.instrumentKey,
      underlyingPrice: lastPrice,
      analysisContractKey: depthContractKey,
      analysisContractLabel: depthContractLabel,
      analysisContractPrice: futuresIntel.available ? futuresIntel.price : null,
      contractExpiry: futuresIntel.available ? futuresIntel.expiry : null,
      rolloverNote: inst2.futuresExpiry
        ? `Futures expiry ${new Date(inst2.futuresExpiry).toISOString().slice(0, 10)} (${Math.max(0, Math.round((inst2.futuresExpiry - Date.now()) / 86400000))} days).`
        : "No futures contract mapped for this instrument.",
      candles: computed,
      zones,
      atr: atrNow,
      depth: snap,
      flow,
      absorption,
      sweeps: staged,
      structureTrend: structure.trend,
      movementState: movement.state,
      vwap: lastNonNull(indicators.vwap),
      relativeVolume: lastNonNull(indicators.relVol),
    });
    (bundle as any).activeStagedSweep = activeStagedSweep(staged);
  // OI-Based Strike Intelligence overlay (audit §7). Built only from the
  // validated option chain; structural zones stay untouched.
  // OI-Based Strike Intelligence overlay (§7 of the liquidity audit).
  // Built FIRST so the unified S&R engine can consume its validated output.
  const oiOverlayResult = optIntel?.available
    ? buildOiOverlay(
        {
          strikes: optIntel.strikes ?? [],
          spot: lastPrice,
          atr: atrNow,
          expiry: optIntel.expiry ?? null,
          ts: optIntel.ts ?? Date.now(),
          structuralZones: (zones ?? []).map((z: any) => ({ type: z.type, bottom: z.bottom, top: z.top })),
        },
        DEFAULT_OI_OVERLAY_CONFIG,
      )
    : { available: false, reason: optIntel?.reason ?? "option chain unavailable", zones: [] as any[], note: "OI confirmation unavailable — structural zones remain visible." };
  (bundle as any).oiOverlay = oiOverlayResult;

  // §5 UNIFIED CONFLUENCE ENGINE: structural zones, volume-profile levels and
  // valid option-chain OI candidates all feed ONE ranking layer. Order flow,
  // order-book depth and aggressor data are deliberately NOT consumed here.
  (bundle as any).srEngine = buildSREngine({
    symbol: inst2.symbol,
    timeframe: `${tfMinutes}m`,
    candles: computed,
    zones,
    structure,
    profile,
    atr: atrNow,
    price: lastPrice,
    relVol: lastNonNull(indicators.relVol),
    vwap: vwapNow,
    futuresAvailable: futuresIntel.available,
    optionOiAvailable: optIntel?.available ?? false,
    oiZones: oiOverlayResult.available ? oiOverlayResult.zones : null,
  });
  }
  // Volume-profile debug output: period, timestamps and the exact levels the
  // chart overlays and the zone engine were built from (req 10).
  (bundle as any).profileDebug = profile
    ? {
        period: profile.period,
        sessions: profile.sessions,
        sessionCount: profile.sessionCount,
        timeframe: profile.timeframe,
        fromTs: profile.fromTs,
        toTs: profile.toTs,
        candlesUsed: profile.candlesUsed,
        // The chart window shows fewer bars than were analysed. Disclosed so
        // the profile period is never mistaken for "just what's visible".
        analysisCandles: computed.length,
        displayCandles: displayCandles.length,
        analysisCoversMoreThanDisplayed: computed.length > displayCandles.length,
        displayedFromTs: displayCandles.length ? displayCandles[0].ts : null,
        binCount: profile.binCount,
        binSize: profile.binSize,
        tickSize: profile.tickSize,
        calculatedAt: profile.calculatedAt,
        approximation: profile.approximation,
        priceLow: profile.priceLow,
        priceHigh: profile.priceHigh,
        poc: profile.poc,
        vah: profile.vah,
        val: profile.val,
        hvns: profile.hvns,
        lvns: profile.lvns,
        position: profile.position,
        consistency: profile.consistency,
        // which zone sources consumed these profile levels
        zoneSourcesUsingProfile: (zones ?? [])
          .filter((z: any) => /profile|POC|VAH|VAL|volume/i.test(`${z.type} ${z.source}`))
          .map((z: any) => ({ type: z.type, bottom: z.bottom, top: z.top, status: z.status, strength: z.strength })),
      }
    : null;
  (bundle as any).history = {
    sessions: pack.sessions,
    sessionsLoaded: pack.sessions.length,
    priorSessions: Math.max(0, pack.sessions.length - 1),
    historyLoaded: pack.historyLoaded,
    historyError: pack.historyError,
    rangeFrom: pack.rangeFrom,
    rangeTo: pack.rangeTo,
    oneMinuteCandles: pack.candles1m.length,
    timeframeCandles: computed.length,
    completedCandles: computed.filter((c) => !c.live).length,
    fetchedAt: pack.fetchedAt,
    note: pack.historyLoaded
      ? `Chart covers ${pack.sessions.length} sessions (${pack.sessions[0]} → ${pack.sessions[pack.sessions.length - 1]}); indicators use completed candles only.`
      : `Only the current session is loaded${pack.historyError ? ` — ${pack.historyError}` : ""}. History is NOT being silently substituted.`,
  };
  if (movement.state === "INSUFFICIENT_DATA") {
    diag.failureCategory = "INSUFFICIENT_DATA";
    diag.failureDetail = movement.waitReason;
    diag.nextStep = categorize("insufficient").nextStep;
  }
  (bundle as any).diagnostics = diag;

  caches.bundles.set(key, { at: Date.now(), bundle });
  if (caches.bundles.size > 150) {
    const k0 = caches.bundles.keys().next().value;
    if (k0) caches.bundles.delete(k0);
  }
  return bundle;
}


/** True when a message came from the rate limiter rather than a real API error. */
function isRateLimitMessage(msg: string): boolean {
  return /rate limit|429|backing off|rate-limited/i.test(msg);
}

/** Human-readable status of the candle quota, for accurate diagnostics. */
function candleQuotaName(): string {
  const s = schedulerState();
  return s.classes.candles.limited
    ? `candles (cooldown ${Math.ceil(s.classes.candles.cooldownRemainingMs / 1000)}s)`
    : `candles (ok; quotes quota ${s.classes.quotes.limited ? "limited" : "ok"})`;
}

function placeholderInstrument(symbol: string): Instrument {
  return {
    symbol: symbol.toUpperCase(),
    name: symbol.toUpperCase(),
    kind: "stock",
    instrumentKey: "",
    foEligible: false,
    exchange: "—",
    segment: "—",
    sector: "—",
    basePrice: 0,
    lotSize: 0,
    tickSize: 0.05,
  };
}

function buildUnavailableBundle(inst: Instrument, tfMinutes: number, reason: string, diag?: InstrumentDiagnostics): AnalysisBundle {
  const emptyInd: IndicatorSnapshots = { ema9: [], ema21: [], ema50: [], ema200: [], vwap: [], rsi: [], bbMid: [], bbUp: [], bbLo: [], atr: [], relVol: [] };
  const movement = { state: "INSUFFICIENT_DATA" as const, bias: "NEUTRAL" as const, momentum: "CONFLICTING" as const, quality: "LOW" as const, supporting: [], contradicting: [], confirmNext: [], invalidateBias: [], tradeJustified: false, waitReason: reason };
  const b: AnalysisBundle = {
    symbol: inst.symbol, label: inst.name, kind: inst.kind, sector: inst.sector, tf: `${tfMinutes}m`, tfMinutes,
    ts: Date.now(), quality: qualityFor(null, [reason]),
    day: { date: istParts(Date.now()).dateStr, open: 0, high: 0, low: 0, prevClose: 0, prevHigh: 0, prevLow: 0, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null, replay: false },
    candles: [], indicators: emptyInd,
    last: { price: 0, change: 0, changePct: 0, volume: 0, relVol: null, atr: null, rsi: null, vwap: null },
    structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
    zones: [], profile: null, movement,
    fmpi: computeFMPI({ candles: [], indicators: emptyInd, structure: { swings: [], trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 }, zones: [], profile: null, atrNow: 0, movement }),
    scenario: { status: "NO_TRADE", direction: null, setup: "NONE", symbol: inst.symbol, tf: `${tfMinutes}m`, ts: Date.now(), price: 0, level: null, entryZone: null, entryTrigger: "", stop: null, stopReason: "", t1: null, t2: null, rr: null, fmpi: null, supporting: [], contradicting: [], noTradeReasons: [reason], cancelIf: [], lifecycle: [] },
    depth: buildDepth(inst, null),
    futures: unavailableFutures(inst.symbol, reason),
    optionLevels: unavailableOptions(inst.symbol, reason),
    footprint: footprintCapability(null),
    events: [],
  };
  (b as any).lotSize = inst.lotSize;
  (b as any).riskConfig = getRuntimeConfig().risk;
  (b as any).sweeps = [];
  (b as any).activeSweep = null;
  (b as any).instrumentKeys = { spot: inst.instrumentKey, futures: inst.futuresKey ?? null };
  (b as any).foEligible = inst.foEligible;
  const d = diag ?? emptyDiagnostics(inst.symbol);
  const cat = categorize(reason);
  d.failureCategory = cat.category;
  d.failureDetail = reason;
  d.nextStep = cat.nextStep;
  (b as any).diagnostics = d;
  return b;
}

export function footprintCapability(profile: ReturnType<typeof volumeProfile>) {
  return {
    trueFootprintAvailable: false,
    requirement: "A true bid/ask footprint needs trade-level data with aggressor-side classification (each executed trade attributed to buyer-initiated or seller-initiated). The Upstox quote/depth API does not provide per-trade aggressor flags, so invented delta values are never displayed.",
    approximationAvailable: !!profile,
    approximationNote: "Candle-based volume-at-price from the documented uniform-allocation approximation (see Volume Profile). This is NOT a true footprint: no executed buy/sell split, no delta, no imbalance per price.",
    volumeAtPrice: profile ? profile.bins.filter((b) => b.volume > 0).sort((a, b) => b.volume - a.volume).slice(0, 14).sort((a, b) => b.price - a.price) : [],
  };
}

// ---------------------------------------------------------------------------
// Header snapshot
// ---------------------------------------------------------------------------

const snapCache = new Map<string, { at: number; snap: any }>();

// ---------------------------------------------------------------------------
// Coordinated snapshot service (shared across every SSE client)
//
// ROOT CAUSE B19 (fixed): /api/stream previously called getSnapshot() on its
// own 4-second timer PER CLIENT, so N browser tabs triggered N independent
// market-data refreshes. This service gives all clients one shared cache:
//   - a single refresh per symbol per TTL window (in-flight promise is reused)
//   - longer TTL while the market is CLOSED, so idle hours do not poll
//   - a failed refresh NEVER overwrites the last known-good snapshot
//   - the payload always carries its own timestamp and a `stale` flag, so
//     cached data is never presented as live
// ---------------------------------------------------------------------------

export interface CoordinatedSnapshot {
  symbol: string;
  snapshot: any;
  /** when this cached snapshot was produced (cache write time) */
  cachedAt: number;
  /** when the underlying market data was actually fetched */
  dataTs: number | null;
  ageMs: number;
  stale: boolean;
  session: MarketSession;
  refreshIntervalMs: number;
  errorCount: number;
  lastError: string | null;
  servedFromCache: boolean;
}

interface SnapSlot {
  cachedAt: number;
  dataTs: number | null;
  snapshot: any | null;
  errorCount: number;
  lastError: string | null;
  inFlight: Promise<void> | null;
}

const sharedSnaps = ((g.__pgSnaps ??= { map: new Map<string, SnapSlot>() }) as { map: Map<string, SnapSlot> });

/** Refresh interval: live during the session, much slower when closed. */
/** Refresh interval by session — exported for tests and diagnostics. */
export function snapshotTtlMs(session: MarketSession): number {
  if (session === "OPEN") return 4000;
  if (session === "PRE_OPEN") return 20_000;
  return 60_000; // CLOSED — reuse last-known data instead of polling
}

export async function getCoordinatedSnapshot(symbol: string): Promise<CoordinatedSnapshot> {
  const session = marketSession(Date.now());
  const ttl = snapshotTtlMs(session);
  let slot = sharedSnaps.map.get(symbol);
  if (!slot) {
    slot = { cachedAt: 0, dataTs: null, snapshot: null, errorCount: 0, lastError: null, inFlight: null };
    sharedSnaps.map.set(symbol, slot);
  }

  const fresh = slot.snapshot != null && Date.now() - slot.cachedAt < ttl;
  if (!fresh && !slot.inFlight) {
    // ONE refresh for all concurrent clients; the promise is shared
    slot.inFlight = (async () => {
      try {
        const snap = await getSnapshot(symbol);
        if (snap && snap.price != null && snap.price > 0) {
          // only a genuinely successful refresh replaces the cache
          slot.snapshot = snap;
          slot.cachedAt = Date.now();
          slot.dataTs = snap.ts ?? Date.now();
          slot.errorCount = 0;
          slot.lastError = null;
        } else if (slot.snapshot == null) {
          slot.snapshot = snap;
          slot.cachedAt = Date.now();
          slot.dataTs = snap?.ts ?? null;
        }
        // if the refresh came back empty but we already have good data,
        // keep the previous snapshot — never replace it with an empty one
      } catch (err) {
        // a failed refresh must NOT clear valid cached data
        slot.errorCount += 1;
        slot.lastError = err instanceof Error ? err.message : String(err);
      } finally {
        slot.inFlight = null;
      }
    })();
  }
  if (slot.inFlight) await slot.inFlight;

  const ageMs = slot.cachedAt ? Date.now() - slot.cachedAt : 0;
  return {
    symbol,
    snapshot: slot.snapshot,
    cachedAt: slot.cachedAt,
    dataTs: slot.dataTs,
    ageMs,
    // cached data older than the live TTL is explicitly NOT live
    stale: session !== "OPEN" || ageMs > snapshotTtlMs("OPEN") * 3,
    session,
    refreshIntervalMs: ttl,
    errorCount: slot.errorCount,
    lastError: slot.lastError,
    servedFromCache: slot.snapshot != null && !slot.inFlight,
  };
}

export async function getSnapshot(symbol: string): Promise<any> {
  const hit = snapCache.get(symbol);
  if (hit && Date.now() - hit.at < 2500) return hit.snap;
  const inst = getInstrument(symbol);
  if (!inst) return null;
  if (!upstoxConfigured()) {
    const snap = { symbol: inst.symbol, name: inst.name, kind: inst.kind, sector: inst.sector, price: 0, change: 0, changePct: 0, volume: 0, relVol: null, state: "INSUFFICIENT_DATA", fmpi: 0, ts: Date.now(), quality: qualityFor(null) };
    snapCache.set(symbol, { at: Date.now(), snap });
    return snap;
  }
  const bundle = await getAnalysis(symbol, 5, { foreground: true });
  const snap = {
    symbol: inst.symbol, name: inst.name, kind: inst.kind, sector: inst.sector,
    price: bundle?.last.price ?? 0, change: bundle?.last.change ?? 0, changePct: bundle?.last.changePct ?? 0,
    volume: bundle?.last.volume ?? 0, relVol: bundle?.last.relVol ?? null,
    state: bundle?.movement.state ?? "INSUFFICIENT_DATA", fmpi: bundle?.fmpi.score ?? 0,
    ts: bundle?.ts ?? Date.now(), quality: bundle?.quality ?? null,
  };
  snapCache.set(symbol, { at: Date.now(), snap });
  return snap;
}

// ---------------------------------------------------------------------------
// Scanner quick features — two-stage live scan
// ---------------------------------------------------------------------------

/**
 * Invalidate the derived scan result so the next call recomputes it.
 *
 * ROOT CAUSE B29 (fixed): this also nulled `caches.quotes`, so every manual
 * "Scan now" (and every POST to /api/scanner, /api/opportunities and
 * /api/alerts) forced a fresh ~219-instrument quote request. Several clients
 * clicking at once tripped the shared quote quota and produced the
 * "quotes quota is rate-limited" state.
 *
 * The quote cache is intentionally PRESERVED here: it has its own 25s TTL and
 * is refreshed by the normal cycle, so manual scans reuse it.
 */
export function invalidateScanCache(): void {
  caches.scan = null;
}

// ---------------------------------------------------------------------------
// Progressive universe scanner (replaces the former fixed 26-instrument cap)
//
// ROOT CAUSE B18 (fixed): quickFeatures() analysed only `slice(0, 26)` and
// scanOpportunities() only 24 instruments, so most of the eligible F&O
// universe was never evaluated and coverage could never grow.
//
// This scheduler is API-rate-limit aware and progresses across cycles:
//   Stage A  batch quote the WHOLE eligible universe (1 call per 450 keys —
//            cheap, so every instrument is quoted every cycle)
//   Stage B  full-analyse only instruments whose stored analysis is missing or
//            stale, up to a per-cycle budget (default 30). Priority:
//            never-analysed first, then oldest, then most active.
//   Stage C  merge fresh stored analyses with quote-only rows for the rest.
//
// Over successive cycles the ENTIRE universe becomes fully analysed. A
// quote-only row is never labelled as analysed or ranked as a signal.
// ---------------------------------------------------------------------------

export interface ScanEntry {
  symbol: string;
  kind: string;
  /** full-analysis feature, valid while younger than freshnessSec */
  feature: QuickFeature | null;
  lastAnalysedAt: number | null;
  lastQuoteAt: number | null;
  lastError: string | null;
}

export interface ScanCoverage {
  universe: number;
  quoted: number;
  fullyAnalysed: number;
  partiallyAnalysed: number;
  quoteOnly: number;
  insufficientData: number;
  pendingAnalysis: number;
  analysisBudgetPerCycle: number;
  freshnessSec: number;
  cyclesCompleted: number;
  lastCycleAt: number | null;
  progressPct: number;
  /** why a scan could not run at all (null when scanning normally) */
  blockedReason: string | null;
  /** instruments with a last-known quote (fresh OR cached) */
  lastKnownQuotes: number;
  /** quotes actually refreshed on the most recent quote call */
  freshQuotes: number;
  /** true when quotes are being served from cache after a failed refresh */
  quotesStale: boolean;
  lastQuoteAt: number | null;
  note: string;
}

const sched = (g.__pgSched ??= {
  entries: new Map<string, ScanEntry>(),
  cycles: 0,
  lastCycleAt: null as number | null,
  blockedReason: null as string | null,
  /** quote-stage freshness, tracked separately from analysis freshness */
  quoteStale: false,
  lastQuoteAt: null as number | null,
  freshQuoteCount: 0,
  cachedQuoteCount: 0,
});

/** Per-instrument analysis freshness + state, for diagnostics and the UI. */
export function scanState(): { entries: ScanEntry[]; coverage: ScanCoverage } {
  const cfg = getRuntimeConfig().scanner;
  const universe = sched.entries.size;
  const analysed = [...sched.entries.values()].filter((e) => e.feature && e.feature.state !== "QUOTE_ONLY" && e.feature.state !== "INSUFFICIENT_DATA");
  const fresh = analysed.filter((e) => e.lastAnalysedAt && Date.now() - e.lastAnalysedAt < (cfg.freshnessSec ?? 300) * 1000);
  const stale = analysed.length - fresh.length;
  const quoteOnly = [...sched.entries.values()].filter((e) => e.feature?.state === "QUOTE_ONLY").length;
  const insufficient = [...sched.entries.values()].filter((e) => e.feature?.state === "INSUFFICIENT_DATA" || (!e.feature && e.lastAnalysedAt)).length;
  const coverage: ScanCoverage = {
    universe,
    quoted: [...sched.entries.values()].filter((e) => e.lastQuoteAt).length,
    fullyAnalysed: fresh.length,
    partiallyAnalysed: [...sched.entries.values()].filter((e) => e.feature && e.feature.dataQuality !== "OK" && e.feature.state !== "QUOTE_ONLY" && e.feature.state !== "INSUFFICIENT_DATA").length,
    quoteOnly,
    insufficientData: insufficient,
    pendingAnalysis: stale + [...sched.entries.values()].filter((e) => !e.feature && !e.lastAnalysedAt).length,
    analysisBudgetPerCycle: cfg.analysisBudget ?? 30,
    freshnessSec: cfg.freshnessSec ?? 300,
    cyclesCompleted: sched.cycles,
    lastCycleAt: sched.lastCycleAt,
    progressPct: universe ? Math.round((fresh.length / universe) * 100) : 0,
    blockedReason: sched.blockedReason,
    lastKnownQuotes: sched.cachedQuoteCount ?? 0,
    freshQuotes: sched.freshQuoteCount ?? 0,
    quotesStale: !!sched.quoteStale,
    lastQuoteAt: sched.lastQuoteAt ?? null,
    note: sched.blockedReason ? sched.blockedReason :
      // Explains the funnel so "N analysed / M evaluated / P pending" never
      // looks contradictory: each number counts a DIFFERENT pipeline stage.
      `${universe} eligible instruments tracked · ${sched.cachedQuoteCount ?? 0} have a last-known quote ` +
      `(${sched.freshQuoteCount ?? 0} refreshed on the latest call${sched.quoteStale ? ", serving STALE cache" : ""}) · ` +
      `${fresh.length} have fresh full analysis (< ${cfg.freshnessSec ?? 300}s) · ` +
      `${stale} analysed but stale (re-analysed on a later cycle) · ` +
      `${quoteOnly} quote-only, never ranked as signals · ` +
      `${insufficient} with insufficient data. ` +
      `Only the ${fresh.length} freshly-analysed instruments enter Trade Finder ranking; ` +
      `up to ${cfg.analysisBudget ?? 30} are analysed per cycle so coverage grows progressively ` +
      `without exceeding Upstox rate limits.`,
  };
  return { entries: [...sched.entries.values()], coverage };
}

/** Convert an analysis bundle into a scanner feature. */
function featureFromBundle(bundle: any, inst: Instrument): QuickFeature {
  const brokenUp = bundle.zones.some((z: any) => (z.status === "BROKEN" || z.status === "RECLAIMED") && z.side === "resistance" && bundle.last.price > z.top);
  const brokenDn = bundle.zones.some((z: any) => (z.status === "BROKEN" || z.status === "RECLAIMED") && z.side === "support" && bundle.last.price < z.bottom);
  const near = bundle.zones.find((z: any) => z.status !== "INVALIDATED" && Math.min(Math.abs(bundle.last.price - z.top), Math.abs(bundle.last.price - z.bottom)) <= (bundle.last.atr ?? 1e9) * 0.6);
  return {
    symbol: inst.symbol, name: inst.name, kind: inst.kind, sector: inst.sector,
    price: bundle.last.price, changePct: bundle.last.changePct,
    relVol: bundle.last.relVol ?? 1, fmpi: bundle.fmpi.score, fmpiDirection: bundle.fmpi.direction,
    state: bundle.movement.state, trend: bundle.structure.trend,
    breakoutUp: brokenUp, breakoutDn: brokenDn,
    zoneNote: near ? `Interacting with ${near.type} zone (${near.status.toLowerCase()}, strength ${near.strength}).` : null,
    dataQuality: bundle.quality.status,
    dayMoveAtr: bundle.last.atr && bundle.last.atr > 0 ? (bundle.last.price - bundle.day.open) / bundle.last.atr : 0,
  };
}

function quoteOnlyFeature(inst: Instrument, ltp: number, changePct: number): QuickFeature {
  return {
    symbol: inst.symbol, name: inst.name, kind: inst.kind, sector: inst.sector,
    price: ltp, changePct, relVol: 1, fmpi: 0, fmpiDirection: "NEUTRAL",
    state: "QUOTE_ONLY", trend: "RANGE", breakoutUp: false, breakoutDn: false,
    zoneNote: null, dataQuality: "QUOTE_ONLY", dayMoveAtr: 0,
  };
}

function insufficientFeature(inst: Instrument, ltp: number, changePct: number): QuickFeature {
  return {
    symbol: inst.symbol, name: inst.name, kind: inst.kind, sector: inst.sector,
    price: ltp, changePct, relVol: 0, fmpi: 0, fmpiDirection: "NEUTRAL",
    state: "INSUFFICIENT_DATA", trend: "RANGE", breakoutUp: false, breakoutDn: false,
    zoneNote: null, dataQuality: "UNAVAILABLE", dayMoveAtr: 0,
  };
}

export async function quickFeatures(force = false): Promise<QuickFeature[]> {
  const cfg = getRuntimeConfig().scanner;
  const freshnessMs = (cfg.freshnessSec ?? 300) * 1000;
  const budget = cfg.analysisBudget ?? 30;
  if (!force && caches.scan && Date.now() - caches.scan.at < 30_000) return caches.scan.features;
  // ROOT CAUSE B22 (fixed): the scan previously returned [] silently when it
  // could not run, so the UI showed "0 scanned" with no explanation. The
  // blocking reason is now recorded and surfaced through scanState().
  if (!upstoxConfigured()) {
    sched.blockedReason = getAuthState().expired
      ? `Scan blocked — the Upstox token was rejected (${getAuthState().expiredReason ?? "expired"}). Enter a new token to resume scanning.`
      : "Scan blocked — Upstox is not connected. Enter an access token to begin scanning the universe.";
    return [];
  }
  const disc = await ensureDiscovery();
  if (!disc.ok || registry.items.length === 0) {
    sched.blockedReason = `Scan blocked — instrument discovery unavailable: ${disc.error ?? "universe is empty"}.`;
    return [];
  }
  sched.blockedReason = null;

  try {
    // ---- Stage A: quote the ENTIRE eligible universe -------------------
    const scanUniverse = [
      ...currentUniverse().filter((i) => i.kind === "index"),
      ...foUniverse().filter((i) => i.kind === "stock"),
    ];
    /**
     * Quote stage.
     *
     * ROOT CAUSE B27 (fixed): on a 429 the empty `merged` map was written
     * straight back into `caches.quotes`, DESTROYING every last-known quote.
     * The next cycle then saw an empty map and reported the whole universe as
     * unquoted — the "Quote stage failed for the whole batch" state.
     *
     * Now a failed/partial refresh MERGES over the previous good cache and the
     * cache timestamp is only advanced when at least one quote actually
     * arrived. Rows served from the old cache are marked stale, never fresh.
     */
    const prevQuotes = (caches.quotes?.map ?? {}) as Record<string, any>;
    let quoteMap = caches.quotes;
    let quoteStale = false;
    let freshQuoteCount = 0;

    const quotesAreFresh = quoteMap && Date.now() - quoteMap.at <= 25_000;
    // `force` no longer bypasses a cache that is still inside its TTL — a
    // manual click must not re-quote ~219 instruments and trip the quota.
    if (!quotesAreFresh) {
      const keys = scanUniverse.map((i) => i.instrumentKey);
      const merged: Record<string, any> = {};
      let quoteErr: string | null = null;
      let rateLimited = false;
      for (let i = 0; i < keys.length; i += 450) {
        try {
          Object.assign(merged, await fetchQuotes(keys.slice(i, i + 450)));
        } catch (err) {
          // one shared API failure must not look like every instrument failed
          quoteErr = err instanceof Error ? err.message : String(err);
          if (/rate limit|429/i.test(quoteErr)) rateLimited = true;
        }
      }
      freshQuoteCount = Object.keys(merged).length;

      if (freshQuoteCount === 0 && quoteErr) {
        // keep serving the last known-good quotes rather than wiping them
        const retained = Object.keys(prevQuotes).length;
        quoteStale = retained > 0;
        const authFailure = /401|token rejected|expired|not connected/i.test(quoteErr);
        sched.blockedReason = rateLimited
          ? `Upstox quotes quota is rate-limited — ${retained > 0 ? `serving ${retained} cached quotes (STALE)` : "no cached quotes available"}. Scanning resumes automatically after the cooldown.`
          : authFailure
            ? `Upstox rejected the access token while quoting — enter a new token to resume scanning.${retained > 0 ? ` ${retained} cached quotes retained (STALE).` : ""}`
            : `Quote refresh failed: ${quoteErr}${retained > 0 ? ` — serving ${retained} cached quotes (STALE).` : "."}`;
        // retain the OLD map and the OLD timestamp so freshness stays honest
        quoteMap = caches.quotes ?? { at: 0, map: {} };
      } else {
        // merge fresh over previous so a partial batch never loses coverage
        const combined = { ...prevQuotes, ...merged };
        quoteStale = quoteErr != null;
        sched.blockedReason = quoteErr
          ? `Partial quote coverage — ${freshQuoteCount} refreshed, remainder served from cache: ${quoteErr}`
          : null;
        quoteMap = { at: Date.now(), map: combined };
        caches.quotes = quoteMap;
      }
    }
    const qmap = (quoteMap?.map ?? prevQuotes) as Record<string, any>;
    const quotesAgeMs = quoteMap?.at ? Date.now() - quoteMap.at : null;
    sched.quoteStale = quoteStale || (quotesAgeMs != null && quotesAgeMs > 60_000);
    sched.lastQuoteAt = quoteMap?.at ?? null;
    sched.freshQuoteCount = freshQuoteCount;
    sched.cachedQuoteCount = Object.keys(qmap).length;

    // register/refresh every instrument's quote
    for (const inst of scanUniverse) {
      let e = sched.entries.get(inst.symbol);
      if (!e) {
        e = { symbol: inst.symbol, kind: inst.kind, feature: null, lastAnalysedAt: null, lastQuoteAt: null, lastError: null };
        sched.entries.set(inst.symbol, e);
      }
      const q = qmap[inst.instrumentKey] ?? qmap[inst.instrumentKey.replace(/\|/g, ":")] ?? qmap[inst.symbol];
      if (q?.lastPrice != null) e.lastQuoteAt = q.ts ?? Date.now();
    }

    // ---- Stage B: pick instruments needing analysis (budgeted) --------
    const now = Date.now();
    const needsAnalysis = scanUniverse
      .map((inst) => {
        const e = sched.entries.get(inst.symbol)!;
        const q = qmap[inst.instrumentKey] ?? qmap[inst.instrumentKey.replace(/\|/g, ":")] ?? qmap[inst.symbol];
        const ltp = q?.lastPrice ?? 0;
        const prevClose = q?.prevClose ?? q?.ohlc?.close ?? 0;
        const changePct = prevClose > 0 && ltp > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
        const volume = q?.volume ?? 0;
        const activity = Math.abs(changePct) * Math.log10(volume + 10);
        const stale = !e.feature || !e.lastAnalysedAt || now - e.lastAnalysedAt >= freshnessMs;
        return { inst, ltp, changePct, activity, entry: e, stale };
      })
      .filter((x) => x.stale && x.ltp > 0);

    // priority: never analysed first, then oldest analysis, then activity
    needsAnalysis.sort((a, b) => {
      const aNew = a.entry.lastAnalysedAt == null ? 1 : 0;
      const bNew = b.entry.lastAnalysedAt == null ? 1 : 0;
      if (aNew !== bNew) return bNew - aNew;                       // unanalysed first
      if (aNew === 0) {
        const d = (a.entry.lastAnalysedAt ?? 0) - (b.entry.lastAnalysedAt ?? 0);
        if (d !== 0) return d;                                       // oldest first
      }
      return b.activity - a.activity;                                // then most active
    });

    const batch = needsAnalysis.slice(0, budget);
    for (const { inst, ltp, changePct, entry } of batch) {
      try {
        const bundle = await getAnalysis(inst.symbol, 5, { foreground: false });
        if (bundle && bundle.candles.length) {
          entry.feature = featureFromBundle(bundle, inst);
          entry.lastAnalysedAt = Date.now();
          entry.lastError = null;
        } else {
          entry.feature = insufficientFeature(inst, ltp, changePct);
          entry.lastAnalysedAt = Date.now();
          entry.lastError = (bundle as any)?.diagnostics?.failureDetail ?? "no candle data";
        }
      } catch (err) {
        entry.feature = insufficientFeature(inst, ltp, changePct);
        entry.lastAnalysedAt = Date.now();
        entry.lastError = err instanceof Error ? err.message : String(err);
      }
    }

    // ---- Stage C: assemble the full universe view ---------------------
    const out: QuickFeature[] = [];
    for (const inst of scanUniverse) {
      const e = sched.entries.get(inst.symbol)!;
      const q = qmap[inst.instrumentKey] ?? qmap[inst.instrumentKey.replace(/\|/g, ":")] ?? qmap[inst.symbol];
      const ltp = q?.lastPrice ?? 0;
      const prevClose = q?.prevClose ?? q?.ohlc?.close ?? 0;
      const changePct = prevClose > 0 && ltp > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;

      const fresh = e.feature && e.lastAnalysedAt && now - e.lastAnalysedAt < freshnessMs;
      if (fresh && e.feature) {
        // keep the freshest price from the live quote, analysis from the bundle
        out.push(ltp > 0 ? { ...e.feature, price: ltp, changePct: changePct || e.feature.changePct } : e.feature);
      } else if (ltp > 0) {
        out.push(quoteOnlyFeature(inst, ltp, changePct));
      } else {
        out.push(insufficientFeature(inst, ltp, changePct));
      }
    }

    sched.cycles += 1;
    sched.lastCycleAt = Date.now();
    caches.scan = { at: Date.now(), features: out };
    return out;
  } catch {
    /* On failure, keep whatever analysis state we already have rather than
       discarding coverage; the next cycle retries the remaining instruments. */
    const previous = caches.scan?.features ?? [];
    return previous;
  }
}

/**
 * Batch quotes for an arbitrary symbol list (watchlist rows, spec §4).
 * One Upstox call covers the whole list — rows do not require individual
 * selection. Every row reports its own state and freshness.
 */
export async function batchQuotes(symbols: string[]): Promise<any[]> {
  const out: any[] = [];
  if (upstoxConfigured()) await ensureDiscovery();

  const resolved: { sym: string; inst: Instrument | null }[] = symbols.map((s) => ({ sym: s.toUpperCase(), inst: getInstrument(s) }));
  const keys = resolved.filter((r) => r.inst).map((r) => r.inst!.instrumentKey);

  let qmap: Record<string, any> = {};
  let fetchError: string | null = null;
  /** true when we are serving previously-fetched quotes because the refresh failed */
  let usingCached = false;
  if (upstoxConfigured() && keys.length) {
    const hit = caches.wlQuotes as { at: number; map: Record<string, any> } | null | undefined;
    if (hit && Date.now() - hit.at < 5000) {
      qmap = hit.map;
    } else {
      try {
        for (let i = 0; i < keys.length; i += 180) {
          Object.assign(qmap, await fetchQuotes(keys.slice(i, i + 180)));
        }
        // only a genuinely successful refresh updates the good cache
        if (Object.keys(qmap).length) caches.wlQuotes = { at: Date.now(), map: qmap };
      } catch (err) {
        fetchError = err instanceof Error ? err.message : String(err);
        // ROOT CAUSE B20 (fixed): a failed refresh previously nulled every row.
        // Reuse the LAST KNOWN-GOOD quotes instead, flagged as stale, so a
        // shared API failure never looks like every instrument lost its data.
        if (hit?.map && Object.keys(hit.map).length) {
          qmap = hit.map;
          usingCached = true;
        }
      }
    }
  }

  const connected = upstoxConfigured();
  for (const { sym, inst } of resolved) {
    // Connection is checked FIRST: with no token the universe is empty, so
    // "not in the master" would be a false diagnosis of the real cause.
    if (!connected) {
      out.push({
        symbol: inst?.symbol ?? sym, name: inst?.name ?? null, state: "NOT_CONNECTED",
        reason: "Upstox is not connected — connect an access token to resolve instruments and stream quotes.",
        price: null, change: null, changePct: null, volume: null, ts: null, foEligible: inst?.foEligible ?? null,
      });
      continue;
    }
    if (!inst) {
      out.push({
        symbol: sym, name: null, state: "INSTRUMENT_UNAVAILABLE",
        reason: `"${sym}" is not present in the Upstox instrument master (renamed, delisted, or misspelled).`,
        suggestions: suggestSymbols(sym, 3),
        price: null, change: null, changePct: null, volume: null, ts: null, foEligible: null,
      });
      continue;
    }
    if (fetchError && !usingCached) {
      // No cached data available for this instrument: report the shared API
      // failure once at the response level (see `apiError` below) rather than
      // mislabelling every single instrument as rate-limited.
      out.push({
        symbol: inst.symbol, name: inst.name, state: "API_ERROR",
        reason: fetchError, price: null, change: null, changePct: null, volume: null, ts: null, foEligible: inst.foEligible,
      });
      continue;
    }
    const q = qmap[inst.instrumentKey]
      ?? qmap[inst.instrumentKey.replace(/\|/g, ":")]
      ?? qmap[inst.symbol]
      ?? null;
    const ltp = q?.lastPrice ?? null;
    const prevClose = q?.prevClose ?? q?.ohlc?.close ?? null;
    if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) {
      out.push({
        symbol: inst.symbol, name: inst.name, state: "QUOTE_UNAVAILABLE",
        reason: `No valid quote returned for ${inst.instrumentKey} (expected outside market hours or the key is not enabled for this app).`,
        price: null, change: null, changePct: null, volume: null, ts: q?.ts ?? null, foEligible: inst.foEligible,
      });
      continue;
    }
    const change = prevClose ? ltp - prevClose : null;
    out.push({
      symbol: inst.symbol, name: inst.name,
      // cached-after-failure data is never labelled live
      state: usingCached ? "STALE_CACHED" : "LIVE",
      reason: usingCached
        ? `Serving the last known-good quote because the latest refresh failed: ${fetchError}`
        : null,
      stale: usingCached,
      price: ltp,
      change,
      changePct: prevClose ? (change! / prevClose) * 100 : null,
      volume: q?.volume ?? null,
      ts: q?.ts ?? Date.now(),
      foEligible: inst.foEligible,
      instrumentKey: inst.instrumentKey,
    });
  }
  return out;
}

export async function overviewStats() {
  const feats = await quickFeatures();
  const stocks = feats.filter((f) => f.kind === "stock" && f.dataQuality !== "UNAVAILABLE");
  const adv = stocks.filter((f) => f.changePct > 0.05).length;
  const dec = stocks.filter((f) => f.changePct < -0.05).length;
  const gainers = [...stocks].sort((a, b) => b.changePct - a.changePct).slice(0, 5);
  const losers = [...stocks].sort((a, b) => a.changePct - b.changePct).slice(0, 5);
  return { advancers: adv, decliners: dec, unchanged: stocks.length - adv - dec, sectors: [], gainers, losers };
}

export { DEFAULT_RISK };
export { currentUniverse as universe };
