/**
 * Rate-limit coordination tests (429, Retry-After, concurrency, cache reuse,
 * market-closed mode and recovery).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  parseRetryAfter, registerRateLimit, registerSuccess, schedulerState, noteCacheHit, noteDeduplicated,
  cooldownRemainingMs, waitForCooldown, coalesce, __resetScheduler, MAX_RETRIES,
  classifyPath, acquireSlot, releaseSlot, recordTrace,
} from "@/lib/market/ratelimit";
import { fetchQuotes } from "@/lib/market/upstox";
import { setRuntimeToken, clearRuntimeToken } from "@/lib/market/credentials";
import { getCoordinatedSnapshot, snapshotTtlMs } from "@/lib/market/engine";
import type { QuotaClass } from "@/lib/market/ratelimit";
import { marketSession } from "@/lib/market/candles";

beforeEach(() => {
  __resetScheduler();
  clearRuntimeToken();
  delete process.env.UPSTOX_ACCESS_TOKEN;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetScheduler();
});

describe("Retry-After parsing", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter("120")).toBe(120);
    // `Retry-After: 0` means "retry immediately"; honouring that literally
    // would produce a request storm, so it is treated as absent and our own
    // exponential backoff is used instead.
    expect(parseRetryAfter("0")).toBeNull();
  });
  it("parses an HTTP-date into remaining seconds", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).not.toBeNull();
    expect(secs!).toBeGreaterThan(5);
    expect(secs!).toBeLessThanOrEqual(11);
  });
  it("returns null for absent or unparseable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
    expect(parseRetryAfter("-3")).toBeNull();
  });
});

describe("429 registration and shared cooldown", () => {
  it("applies an exponential backoff that grows with consecutive 429s", () => {
    const first = registerRateLimit("quotes", null, 1_000_000);
    const second = registerRateLimit("quotes", null, 1_100_000);
    const third = registerRateLimit("quotes", null, 1_200_000);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
  it("caps the backoff at a maximum", () => {
    for (let i = 0; i < 12; i++) registerRateLimit("quotes", null, 1_000_000 + i);
    const capped = registerRateLimit("quotes", null, 2_000_000);
    expect(capped).toBeLessThanOrEqual(30_000 + 250 + 1);
  });
  it("honours Retry-After when it is longer than the computed backoff", () => {
    const applied = registerRateLimit("quotes", 45, 1_000_000); // 45s header
    expect(applied).toBeGreaterThanOrEqual(45_000);
  });
  it("sets a single shared cooldown that all callers observe", () => {
    registerRateLimit("quotes", 2, Date.now());
    const s = schedulerState();
    expect(s.limited).toBe(true);
    expect(s.status).toBe("RATE_LIMITED");
    expect(s.consecutive429).toBe(1);
    expect(s.total429).toBe(1);
    expect(cooldownRemainingMs()).toBeGreaterThan(0);
  });
  it("a successful call clears the cooldown and the backoff ladder", () => {
    registerRateLimit("quotes", 2, Date.now());
    registerRateLimit("quotes", 2, Date.now());
    expect(schedulerState().consecutive429).toBe(2);
    registerSuccess("quotes");
    const s = schedulerState();
    expect(s.limited).toBe(false);
    expect(s.consecutive429).toBe(0);
    expect(s.cooldownRemainingMs).toBe(0);
    expect(s.status).toBe("OK");
    expect(s.lastSuccessAt).toBeGreaterThan(0);
  });
});

describe("waitForCooldown", () => {
  it("returns immediately when no cooldown is active", async () => {
    expect(await waitForCooldown("quotes", 50)).toBe(true);
  });
  it("waits for a short cooldown to expire", async () => {
    registerRateLimit("quotes", null, Date.now() - 1200); // nearly expired
    const cleared = await waitForCooldown("quotes", 3000);
    expect(cleared).toBe(true);
    expect(cooldownRemainingMs()).toBe(0);
  });
  it("gives up rather than holding a request for the whole long cooldown", async () => {
    registerRateLimit("quotes", 120, Date.now()); // 120s
    const t0 = Date.now();
    const cleared = await waitForCooldown("quotes", 200);
    expect(cleared).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(cooldownRemainingMs()).toBeGreaterThan(0);
  });
});

describe("request coalescing (no retry storm)", () => {
  it("concurrent identical calls share ONE underlying request", async () => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 40));
      return calls;
    };
    const results = await Promise.all([
      coalesce("key", fn),
      coalesce("key", fn),
      coalesce("key", fn),
      coalesce("key", fn),
      coalesce("key", fn),
    ]);
    expect(calls).toBe(1);             // only one network call
    expect(results.every((r) => r === 1)).toBe(true);
  });
  it("sequential calls are not coalesced", async () => {
    let calls = 0;
    const fn = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return calls; };
    await coalesce("k", fn);
    await coalesce("k", fn);
    expect(calls).toBe(2);
  });
});

describe("upstoxFetch 429 retry behaviour", () => {
  const KEY = "NSE_EQ|INE467B01029";

  it("retries a 429 and succeeds once Upstox recovers", async () => {
    setRuntimeToken("token-for-429-tests-123456", { validated: false, userName: null, error: null });
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, status: 429, headers: new Map([["retry-after", "0"]]) };
      return {
        ok: true, status: 200,
        headers: new Map(),
        json: async () => ({ status: "success", data: {} }),
      };
    }));
    const out = await fetchQuotes([KEY]);
    expect(attempts).toBe(3);                       // retried twice then succeeded
    expect(schedulerState().total429).toBe(2);
    expect(schedulerState().status).toBe("OK");     // recovered
    expect(schedulerState().totalRetries).toBe(2);
    expect(out).toEqual({});
  });

  it("gives up after the maximum retry count and reports the cooldown", async () => {
    setRuntimeToken("token-for-429-tests-123456", { validated: false, userName: null, error: null });
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      attempts += 1;
      return { ok: false, status: 429, headers: new Map() };
    }));
    await expect(fetchQuotes([KEY])).rejects.toThrow(/429|rate limit/i);
    expect(attempts).toBe(MAX_RETRIES + 1);         // initial + MAX_RETRIES
    expect(schedulerState().total429).toBe(MAX_RETRIES + 1);
    expect(schedulerState().limited).toBe(true);
  });

  it("does NOT retry non-429 errors", async () => {
    setRuntimeToken("token-for-429-tests-123456", { validated: false, userName: null, error: null });
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      attempts += 1;
      return { ok: false, status: 500, headers: new Map() };
    }));
    await expect(fetchQuotes([KEY])).rejects.toThrow(/500/);
    expect(attempts).toBe(1);                       // no retry on a server error
    expect(schedulerState().total429).toBe(0);
  });

  it("concurrent calls to the same endpoint issue one request, not a storm", async () => {
    setRuntimeToken("token-for-429-tests-123456", { validated: false, userName: null, error: null });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, status: 200, headers: new Map(), json: async () => ({ status: "success", data: {} }) };
    }));
    await Promise.all([fetchQuotes([KEY]), fetchQuotes([KEY]), fetchQuotes([KEY])]);
    expect(calls).toBe(1);
  });

  it("records a successful fetch timestamp for the UI", async () => {
    setRuntimeToken("token-for-429-tests-123456", { validated: false, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({
      ok: true, status: 200, headers: new Map(), json: async () => ({ status: "success", data: {} }),
    })));
    await fetchQuotes([KEY]);
    expect(schedulerState().lastSuccessAt).toBeGreaterThan(0);
    expect(schedulerState().status).toBe("OK");
  });
});

describe("market-closed refresh cadence", () => {
  it("polls far less often while the market is closed", () => {
    const open = snapshotTtlMs("OPEN");
    const closed = snapshotTtlMs("CLOSED");
    const preOpen = snapshotTtlMs("PRE_OPEN");
    expect(open).toBe(4000);
    expect(preOpen).toBeGreaterThan(open);
    expect(closed).toBeGreaterThanOrEqual(10 * open);
  });
  it("reports the live session from the IST clock", () => {
    expect(["OPEN", "CLOSED", "PRE_OPEN"]).toContain(marketSession(Date.now()));
  });
});

describe("coordinated snapshot cache", () => {
  it("exposes freshness metadata so cached data is never labelled live", async () => {
    const s = await getCoordinatedSnapshot("__NONEXISTENT__");
    expect(s).toHaveProperty("stale");
    expect(s).toHaveProperty("dataTs");
    expect(s).toHaveProperty("ageMs");
    expect(s).toHaveProperty("session");
    expect(s).toHaveProperty("refreshIntervalMs");
    expect(s).toHaveProperty("errorCount");
    expect(typeof s.stale).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Per-quota-class isolation (root cause B24)
// ---------------------------------------------------------------------------

describe("per-quota-class cooldown isolation", () => {
  it("classifies endpoints into their Upstox quota families", () => {
    expect(classifyPath("/v2/market-quote/quotes?instrument_key=x")).toBe("quotes");
    expect(classifyPath("/v2/market-quote/ltp?instrument_key=x")).toBe("quotes");
    expect(classifyPath("/v3/historical-candle/intraday/NSE_EQ%7Cx/minutes/1")).toBe("candles");
    expect(classifyPath("/v3/historical-candle/NSE_EQ%7Cx/minutes/1/2026-01-02/2026-01-01")).toBe("candles");
    expect(classifyPath("/v2/option/chain?instrument_key=x")).toBe("options");
    expect(classifyPath("/v2/option/contract?instrument_key=x")).toBe("options");
    expect(classifyPath("/v2/user/profile")).toBe("profile");
  });

  it("a quotes 429 does NOT block the candle quota (B24 regression)", () => {
    // 45s Retry-After on the quote quota
    registerRateLimit("quotes", 45, Date.now());
    expect(cooldownRemainingMs("quotes")).toBeGreaterThan(40_000);
    // the candle quota must remain completely unaffected
    expect(cooldownRemainingMs("candles")).toBe(0);
    expect(schedulerState().classes.candles.limited).toBe(false);
    expect(schedulerState().classes.candles.total429).toBe(0);
  });

  it("a candles 429 does NOT block the quote quota", () => {
    registerRateLimit("candles", 30, Date.now());
    expect(cooldownRemainingMs("candles")).toBeGreaterThan(25_000);
    expect(cooldownRemainingMs("quotes")).toBe(0);
    expect(schedulerState().classes.quotes.limited).toBe(false);
  });

  it("each class keeps its own 429 counters and backoff ladder", () => {
    registerRateLimit("quotes", null, Date.now());
    registerRateLimit("quotes", null, Date.now());
    registerRateLimit("options", null, Date.now());
    const st = schedulerState();
    expect(st.classes.quotes.total429).toBe(2);
    expect(st.classes.quotes.consecutive429).toBe(2);
    expect(st.classes.options.total429).toBe(1);
    expect(st.classes.options.consecutive429).toBe(1);
    expect(st.classes.candles.total429).toBe(0);
  });

  it("clearing one class leaves the other limited", () => {
    registerRateLimit("quotes", 60, Date.now());
    registerRateLimit("candles", 60, Date.now());
    registerSuccess("quotes");
    expect(schedulerState().classes.quotes.limited).toBe(false);
    expect(schedulerState().classes.candles.limited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded concurrency + pacing (root cause B25)
// ---------------------------------------------------------------------------

describe("bounded concurrency", () => {
  it("caps concurrent requests per quota class", async () => {
    let concurrent = 0;
    let peak = 0;
    const jobs = Array.from({ length: 12 }, () =>
      (async () => {
        await acquireSlot("quotes", "normal");
        try {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 60));
        } finally {
          concurrent -= 1;
          releaseSlot("quotes");
        }
      })(),
    );
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(3);      // CLASS_CONCURRENCY.quotes
    expect(schedulerState().classes.quotes.inFlight).toBe(0);
  });

  it("caps the candle class at its own (higher) limit", async () => {
    let concurrent = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 10 }, () =>
      (async () => {
        await acquireSlot("candles", "normal");
        try {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 50));
        } finally {
          concurrent -= 1;
          releaseSlot("candles");
        }
      })(),
    ));
    expect(peak).toBeLessThanOrEqual(4);      // CLASS_CONCURRENCY.candles
    expect(peak).toBeGreaterThan(1);          // and it did run in parallel
  });

  it("releases slots even when the job throws", async () => {
    const run = async () => {
      await acquireSlot("quotes", "critical");
      try { throw new Error("boom"); } finally { releaseSlot("quotes"); }
    };
    await expect(run()).rejects.toThrow("boom");
    expect(schedulerState().classes.quotes.inFlight).toBe(0);
  });
});

describe("request trace", () => {
  it("records endpoint, status, duration and purpose for each request", () => {
    recordTrace({
      path: "/v3/historical-candle/intraday/NSE_EQ%7CINE467B01029/minutes/1",
      endpoint: "/v3/historical-candle/intraday",
      quota: "candles", purpose: "chart-intraday", instrument: "NSE_EQ|INE467B01029",
      status: 200, durationMs: 240, attempt: 0, cacheHit: false, deduplicated: false,
    });
    recordTrace({
      path: "/v2/market-quote/quotes?instrument_key=NSE_EQ%7CINE467B01029",
      endpoint: "/v2/market-quote/quotes",
      quota: "quotes", purpose: "batch-quotes", instrument: "NSE_EQ|INE467B01029",
      status: 429, durationMs: 90, attempt: 0, cacheHit: false, deduplicated: false,
    });
    const st = schedulerState();
    expect(st.trace.length).toBeGreaterThanOrEqual(2);
    const last = st.trace[st.trace.length - 1];
    expect(last.status).toBe(429);
    expect(last.quota).toBe("quotes");
    expect(last.purpose).toBe("batch-quotes");
    expect(typeof last.durationMs).toBe("number");
    expect(st.perEndpoint["/v2/market-quote/quotes"]).toBeGreaterThanOrEqual(1);
  });

  it("never stores an access token in the trace", () => {
    recordTrace({
      path: "/v2/market-quote/quotes?instrument_key=x", endpoint: "/v2/market-quote/quotes",
      quota: "quotes", purpose: "batch-quotes", instrument: "x",
      status: 200, durationMs: 10, attempt: 0, cacheHit: false, deduplicated: false,
    });
    const raw = JSON.stringify(schedulerState().trace);
    expect(raw).not.toMatch(/Bearer /i);
    expect(raw).not.toMatch(/access_token/i);
  });
});

describe("counters for observability", () => {
  it("exposes cache hits and deduplication counters per class", () => {
    noteCacheHit("quotes");
    noteCacheHit("quotes");
    noteDeduplicated("quotes");
    const st = schedulerState();
    expect(st.classes.quotes.cacheHits).toBeGreaterThanOrEqual(2);
    expect(st.classes.quotes.deduplicated).toBeGreaterThanOrEqual(1);
  });
});
