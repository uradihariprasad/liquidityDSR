/**
 * Per-instrument diagnostics (spec §14).
 *
 * Records the outcome of every stage of the pipeline so the UI can explain
 * exactly where an instrument failed:
 *   symbol → canonical instrument → instrument key → quote → candles →
 *   depth → option chain → indicators/FMPI
 *
 * Access tokens and auth headers are NEVER recorded here.
 */

export type StageStatus = "OK" | "EMPTY" | "ERROR" | "SKIPPED" | "PENDING";

export interface StageResult {
  status: StageStatus;
  at: number | null;
  detail: string;
  count?: number;
  latencyMs?: number;
}

export type FailureCategory =
  | "NONE"
  | "NOT_CONNECTED"
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "INSTRUMENT_UNRESOLVED"
  | "CONTRACT_UNAVAILABLE"
  | "NO_HISTORY"
  | "MARKET_CLOSED"
  | "STALE_FEED"
  | "API_ERROR"
  | "INSUFFICIENT_DATA";

export interface InstrumentDiagnostics {
  symbolEntered: string;
  resolvedSymbol: string | null;
  resolvedName: string | null;
  instrumentKey: string | null;
  futuresKey: string | null;
  exchange: string | null;
  segment: string | null;
  foEligible: boolean | null;
  stages: {
    discovery: StageResult;
    resolve: StageResult;
    quote: StageResult;
    candles: StageResult;
    dailyHistory: StageResult;
    depth: StageResult;
    optionChain: StageResult;
    indicators: StageResult;
  };
  freshness: {
    lastQuoteTs: number | null;
    lastTickTs: number | null;
    lastCandleTs: number | null;
    lastDepthTs: number | null;
    lastOptionChainTs: number | null;
  };
  failureCategory: FailureCategory;
  failureDetail: string | null;
  nextStep: string | null;
  suggestions: string[];
}

export function stage(status: StageStatus, detail: string, extra: Partial<StageResult> = {}): StageResult {
  return { status, at: status === "PENDING" ? null : Date.now(), detail, ...extra };
}

export function emptyDiagnostics(symbol: string): InstrumentDiagnostics {
  const p = stage("PENDING", "not attempted");
  return {
    symbolEntered: symbol,
    resolvedSymbol: null,
    resolvedName: null,
    instrumentKey: null,
    futuresKey: null,
    exchange: null,
    segment: null,
    foEligible: null,
    stages: { discovery: p, resolve: p, quote: p, candles: p, dailyHistory: p, depth: p, optionChain: p, indicators: p },
    freshness: { lastQuoteTs: null, lastTickTs: null, lastCandleTs: null, lastDepthTs: null, lastOptionChainTs: null },
    failureCategory: "NONE",
    failureDetail: null,
    nextStep: null,
    suggestions: [],
  };
}

/** Map a raw error message to a user-actionable failure category. */
export function categorize(message: string): { category: FailureCategory; nextStep: string } {
  const m = message.toLowerCase();
  if (m.includes("not connected") || m.includes("no token")) {
    return { category: "NOT_CONNECTED", nextStep: "Connect an Upstox access token using the box at the top-left of the header." };
  }
  if (m.includes("401") || m.includes("token rejected") || m.includes("expired")) {
    return { category: "AUTH_ERROR", nextStep: "The Upstox token was rejected — generate a fresh access token and reconnect. Tokens expire daily." };
  }
  if (m.includes("429") || m.includes("rate limit")) {
    return { category: "RATE_LIMIT", nextStep: "Upstox rate limit reached. The engine backs off automatically; reduce scan frequency or watchlist size if it persists." };
  }
  if (m.includes("not in the discovered") || m.includes("unknown instrument")) {
    return { category: "INSTRUMENT_UNRESOLVED", nextStep: "The symbol is not present in the Upstox instrument master. Check the exact trading symbol (it may have been renamed or delisted) and use search." };
  }
  if (m.includes("no intraday candles") || m.includes("no candles")) {
    return { category: "NO_HISTORY", nextStep: "Upstox returned no intraday candles. This is expected before the session opens; intraday history builds from 09:15 IST." };
  }
  if (m.includes("no futures") || m.includes("contract")) {
    return { category: "CONTRACT_UNAVAILABLE", nextStep: "No live derivative contract maps to this underlying — cash-market analysis remains available." };
  }
  if (m.includes("stale")) {
    return { category: "STALE_FEED", nextStep: "The feed stopped updating. Check connectivity and token validity; signals are suppressed while data is stale." };
  }
  if (m.includes("insufficient")) {
    return { category: "INSUFFICIENT_DATA", nextStep: "Not enough completed candles yet for this timeframe. Wait for more bars or switch to a lower timeframe." };
  }
  return { category: "API_ERROR", nextStep: "An upstream API call failed. The exact message is shown above; the rest of the application continues to work." };
}
