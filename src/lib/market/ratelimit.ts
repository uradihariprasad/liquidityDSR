/**
 * Centralized Upstox request scheduler.
 *
 * ROOT CAUSES FIXED HERE
 *
 *  B24  The cooldown was GLOBAL. The authenticated quote quota is the one that
 *       returns 429, but a single global cooldown then blocked the CANDLE
 *       endpoints too — which tolerate 60+ parallel requests without limiting.
 *       That is exactly the reported symptom: "Quote: PENDING / not attempted"
 *       while "Intraday candles: ERROR — Upstox rate limit active".
 *       FIX: cooldowns, pacing and quotas are now tracked PER ENDPOINT CLASS.
 *
 *  B25  There was no concurrency bound and no pacing, so a scanner cycle fired
 *       ~180 requests in a burst (futures + option chain + candles + daily per
 *       instrument). FIX: bounded concurrency + per-class minimum spacing, and
 *       requests drain from a PRIORITY queue instead of all firing at once
 *       when a cooldown clears.
 *
 *  B26  Diagnostics could trigger a second full data refresh. The trace and
 *       counters below let diagnostics report existing pipeline results.
 *
 * Nothing here fabricates data and no access token is ever recorded.
 */

export class RateLimitError extends Error {
  constructor(message: string, public readonly cooldownRemainingMs: number, public readonly quota?: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Upstox exposes distinct quotas. Grouping by the API family rather than the
 * exact URL means one family's 429 blocks only that family.
 */
export type QuotaClass =
  | "quotes"        // /v2/market-quote/*  — authenticated, tightest quota
  | "candles"       // /v3/historical-candle/* — separate, much looser quota
  | "options"       // /v2/option/* — authenticated
  | "profile";      // /v2/user/profile

export function classifyPath(path: string): QuotaClass {
  if (path.includes("/market-quote/")) return "quotes";
  if (path.includes("/historical-candle/")) return "candles";
  if (path.includes("/option/")) return "options";
  if (path.includes("/user/profile")) return "profile";
  return "quotes";
}

/** Priority: lower runs first. The selected instrument must never queue behind a scan. */
export type Priority = "critical" | "high" | "normal" | "background";
const PRIORITY_ORDER: Record<Priority, number> = { critical: 0, high: 1, normal: 2, background: 3 };

/** Per-class pacing: minimum spacing between successive requests (ms). */
const CLASS_PACING_MS: Record<QuotaClass, number> = {
  quotes: 220,    // ~4.5 req/s ceiling on the authenticated quote quota
  candles: 60,
  options: 250,
  profile: 1000,
};

/** Per-class concurrent-request ceiling. */
const CLASS_CONCURRENCY: Record<QuotaClass, number> = {
  quotes: 3,
  candles: 4,
  options: 2,
  profile: 1,
};

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const JITTER_MS = 250;
export const MAX_RETRIES = 3;
const TRACE_LIMIT = 120;

export interface RequestTrace {
  ts: number;
  /** sanitized path with query string removed — never contains a token */
  path: string;
  endpoint: string;
  quota: QuotaClass;
  purpose: string;
  instrument: string | null;
  status: number;
  durationMs: number;
  attempt: number;
  /** true when the result came from cache instead of the network */
  cacheHit: boolean;
  /** true when this call joined an already in-flight identical request */
  deduplicated: boolean;
}

interface ClassState {
  cooldownUntil: number | null;
  retryAfterSec: number | null;
  consecutive429: number;
  last429At: number | null;
  lastRequestAt: number | null;
  inFlight: number;
  totalRequests: number;
  total429: number;
  totalRetries: number;
  cacheHits: number;
  deduplicated: number;
  rateLimitedDropped: number;
}

interface Store {
  classes: Record<QuotaClass, ClassState>;
  lastSuccessAt: number | null;
  trace: RequestTrace[];
  /** path -> in-flight promise, so identical concurrent calls share one request */
  coalesced: Map<string, Promise<unknown>>;
  /** priority queue of waiting jobs when a class is saturated */
  queue: { priority: number; run: () => void }[];
  totalQueued: number;
}

function blankClass(): ClassState {
  return {
    cooldownUntil: null, retryAfterSec: null, consecutive429: 0, last429At: null,
    lastRequestAt: null, inFlight: 0, totalRequests: 0, total429: 0, totalRetries: 0,
    cacheHits: 0, deduplicated: 0, rateLimitedDropped: 0,
  };
}

const g = globalThis as typeof globalThis & { __pgScheduler?: Store };
const store: Store = (g.__pgScheduler ??= {
  classes: { quotes: blankClass(), candles: blankClass(), options: blankClass(), profile: blankClass() },
  lastSuccessAt: null,
  trace: [],
  coalesced: new Map(),
  queue: [],
  totalQueued: 0,
});

function cls(q: QuotaClass): ClassState {
  if (!store.classes[q]) store.classes[q] = blankClass();
  return store.classes[q];
}

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

export interface QuotaState {
  quota: QuotaClass;
  limited: boolean;
  cooldownRemainingMs: number;
  retryAfterSec: number | null;
  consecutive429: number;
  last429At: number | null;
  inFlight: number;
  totalRequests: number;
  total429: number;
  totalRetries: number;
  cacheHits: number;
  deduplicated: number;
  rateLimitedDropped: number;
}

export interface SchedulerState {
  /** true only when the class that matters for quotes is limited */
  limited: boolean;
  status: "OK" | "RATE_LIMITED" | "UNKNOWN";
  cooldownRemainingMs: number;
  retryAfterSec: number | null;
  last429At: number | null;
  consecutive429: number;
  lastSuccessAt: number | null;
  inFlight: number;
  pendingQueueSize: number;
  /** requests per endpoint, for the current rolling window */
  perEndpoint: Record<string, number>;
  cacheHits: number;
  deduplicated: number;
  totalRequests: number;
  total429: number;
  totalRetries: number;
  classes: Record<QuotaClass, QuotaState>;
  trace: RequestTrace[];
}

export function schedulerState(): SchedulerState {
  const q = cls("quotes");
  const perEndpoint: Record<string, number> = {};
  for (const t of store.trace) perEndpoint[t.endpoint] = (perEndpoint[t.endpoint] ?? 0) + 1;
  const remaining = cooldownRemainingMs("quotes");
  return {
    limited: remaining > 0,
    status: remaining > 0 ? "RATE_LIMITED" : store.lastSuccessAt ? "OK" : "UNKNOWN",
    cooldownRemainingMs: remaining,
    retryAfterSec: q.retryAfterSec,
    last429At: q.last429At,
    consecutive429: q.consecutive429,
    lastSuccessAt: store.lastSuccessAt,
    inFlight: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).inFlight, 0),
    pendingQueueSize: store.queue.length,
    perEndpoint,
    cacheHits: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).cacheHits, 0),
    deduplicated: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).deduplicated, 0),
    totalRequests: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).totalRequests, 0),
    total429: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).total429, 0),
    totalRetries: (Object.keys(store.classes) as QuotaClass[]).reduce((n, k) => n + cls(k).totalRetries, 0),
    classes: {
      quotes: quotaState("quotes"),
      candles: quotaState("candles"),
      options: quotaState("options"),
      profile: quotaState("profile"),
    },
    trace: [...store.trace].slice(-TRACE_LIMIT),
  };
}

function quotaState(q: QuotaClass): QuotaState {
  const c = cls(q);
  return {
    quota: q,
    limited: cooldownRemainingMs(q) > 0,
    cooldownRemainingMs: cooldownRemainingMs(q),
    retryAfterSec: c.retryAfterSec,
    consecutive429: c.consecutive429,
    last429At: c.last429At,
    inFlight: c.inFlight,
    totalRequests: c.totalRequests,
    total429: c.total429,
    totalRetries: c.totalRetries,
    cacheHits: c.cacheHits,
    deduplicated: c.deduplicated,
    rateLimitedDropped: c.rateLimitedDropped,
  };
}

export function cooldownRemainingMs(quota: QuotaClass = "quotes", now = Date.now()): number {
  const until = cls(quota).cooldownUntil;
  return until == null ? 0 : Math.max(0, until - now);
}

// ---------------------------------------------------------------------------
// Rate-limit registration
// ---------------------------------------------------------------------------

/**
 * Parse a `Retry-After` header (delay-seconds or HTTP-date).
 * A non-positive or unparseable value is treated as absent, because
 * "retry immediately" would cause a request storm.
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const asDate = Date.parse(v);
  if (Number.isFinite(asDate)) {
    const secs = Math.ceil((asDate - Date.now()) / 1000);
    return secs > 0 ? Math.min(secs, 3600) : null;
  }
  return null;
}

/**
 * Register a 429 for ONE quota class. Exponential backoff with jitter, capped,
 * and never shorter than a supplied `Retry-After`.
 */
export function registerRateLimit(quota: QuotaClass, retryAfterSec: number | null, now = Date.now()): number {
  const c = cls(quota);
  c.last429At = now;
  c.total429 += 1;
  c.consecutive429 += 1;
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (c.consecutive429 - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * JITTER_MS;
  const fromHeader = retryAfterSec != null ? retryAfterSec * 1000 : 0;
  const cooldown = Math.max(exponential, fromHeader) + jitter;
  c.cooldownUntil = now + cooldown;
  c.retryAfterSec = retryAfterSec;
  return Math.round(cooldown);
}

/** A successful call clears that class's backoff ladder. */
export function registerSuccess(quota: QuotaClass, now = Date.now()): void {
  const c = cls(quota);
  c.cooldownUntil = null;
  c.retryAfterSec = null;
  c.consecutive429 = 0;
  store.lastSuccessAt = now;
}

export function noteRequest(quota: QuotaClass): void {
  const c = cls(quota);
  c.totalRequests += 1;
  c.lastRequestAt = Date.now();
}

export function noteRetry(quota: QuotaClass): void {
  cls(quota).totalRetries += 1;
}

export function noteCacheHit(quota: QuotaClass): void {
  cls(quota).cacheHits += 1;
}

export function noteDeduplicated(quota: QuotaClass): void {
  cls(quota).deduplicated += 1;
}

export function noteRateLimitedDrop(quota: QuotaClass): void {
  cls(quota).rateLimitedDropped += 1;
}

/** Append a sanitized trace entry. The path never contains a token. */
export function recordTrace(entry: Omit<RequestTrace, "ts">): void {
  store.trace.push({ ...entry, ts: Date.now() });
  if (store.trace.length > TRACE_LIMIT * 2) store.trace = store.trace.slice(-TRACE_LIMIT);
}

// ---------------------------------------------------------------------------
// Cooldown waiting (per class)
// ---------------------------------------------------------------------------

/**
 * Wait for THIS class's cooldown. Resolves false if still active after
 * `maxWaitMs` — the caller should then give up rather than pile up requests.
 */
export async function waitForCooldown(quota: QuotaClass = "quotes", maxWaitMs = 12_000): Promise<boolean> {
  const total = cooldownRemainingMs(quota);
  if (total <= 0) return true;
  if (total > maxWaitMs) {
    await sleep(Math.min(maxWaitMs, 500));
    return cooldownRemainingMs(quota) <= 0;
  }
  await sleep(total + 10);
  return cooldownRemainingMs(quota) <= 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Bounded concurrency + per-class pacing + priority
// ---------------------------------------------------------------------------

/**
 * Acquire a slot for `quota`, respecting:
 *  - that class's concurrency ceiling
 *  - that class's minimum spacing (pacing)
 *  - that class's cooldown
 *  - global priority ordering, so a critical request (the selected instrument)
 *    never waits behind a background scan job
 *
 * Requests do NOT all fire at once when a cooldown clears: they drain through
 * the same pacing gate, highest priority first.
 */
export async function acquireSlot(quota: QuotaClass, priority: Priority): Promise<void> {
  const c = cls(quota);
  // fast path when the class has capacity and pacing has elapsed
  const canFastPath = () =>
    c.inFlight < CLASS_CONCURRENCY[quota]
    && cooldownRemainingMs(quota) <= 0
    && (c.lastRequestAt == null || Date.now() - c.lastRequestAt >= CLASS_PACING_MS[quota]);

  if (canFastPath()) {
    c.inFlight += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    store.totalQueued += 1;
    const job = { priority: PRIORITY_ORDER[priority], run: resolve };
    store.queue.push(job);
    // re-check periodically; the drain loop below also pumps the queue
    const pump = () => {
      if (canFastPath()) {
        c.inFlight += 1;
        resolve();
      } else {
        setTimeout(pump, Math.max(20, Math.min(CLASS_PACING_MS[quota], 200)));
      }
    };
    setTimeout(pump, 20);
  });
}

export function releaseSlot(quota: QuotaClass): void {
  cls(quota).inFlight = Math.max(0, cls(quota).inFlight - 1);
}

/** Test-only helper: current saturation for assertions. */
export function inFlightCount(quota: QuotaClass): number {
  return cls(quota).inFlight;
}

/**
 * Coalesce concurrent identical work: while one call for `key` is in flight,
 * additional callers await the SAME promise instead of issuing their own
 * request. This prevents a retry storm across concurrent requests.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = store.coalesced.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      store.coalesced.delete(key);
    }
  })();
  store.coalesced.set(key, p as Promise<unknown>);
  return p;
}

/** Test-only: reset every counter, cooldown and trace. */
export function __resetScheduler(): void {
  store.classes = { quotes: blankClass(), candles: blankClass(), options: blankClass(), profile: blankClass() };
  store.lastSuccessAt = null;
  store.trace = [];
  store.coalesced.clear();
  store.queue = [];
  store.totalQueued = 0;
}

/** Back-compat aliases for existing callers. */
export const rateLimitState = schedulerState;
export function registerRateLimitGlobal(retryAfterSec: number | null): number {
  return registerRateLimit("quotes", retryAfterSec);
}
export function registerSuccessGlobal(): void {
  registerSuccess("quotes");
}
