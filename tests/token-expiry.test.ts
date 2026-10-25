/**
 * Token-expiry detection tests.
 *
 * Upstox access tokens expire daily. The application must detect rejection,
 * stop fetching with the dead credential, report the true cause, and prompt
 * the user for a NEW token (rather than implying nothing was configured).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  store, getAccessToken, hasToken, markTokenExpired, clearRuntimeToken,
  setRuntimeToken, getAuthState,
} from "@/lib/market/credentials";
import { fetchQuotes, validateToken } from "@/lib/market/upstox";
import { categorize } from "@/lib/market/diagnostics";

const TOKEN = "valid-token-used-for-expiry-tests";

beforeEach(() => {
  clearRuntimeToken();
  delete process.env.UPSTOX_ACCESS_TOKEN;
  vi.unstubAllGlobals();
});

describe("credential store expiry state", () => {
  it("reports connected with no expiry when a fresh token is installed", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: "tester", error: null });
    const s = getAuthState();
    expect(s.connected).toBe(true);
    expect(s.expired).toBe(false);
    expect(hasToken()).toBe(true);
    expect(getAccessToken()).toBe(TOKEN);
  });

  it("marks the token expired on rejection and stops returning it", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: "tester", error: null });
    markTokenExpired("Upstox rejected the access token (HTTP 401)");
    expect(store.expired).toBe(true);
    // the dead credential must not be handed to any data module
    expect(getAccessToken()).toBeNull();
    expect(hasToken()).toBe(false);
  });

  it("keeps reporting that a credential is installed, but flags it expired", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: "tester", error: null });
    markTokenExpired("expired");
    const s = getAuthState();
    expect(s.connected).toBe(true);      // a credential exists…
    expect(s.expired).toBe(true);        // …but it is rejected
    expect(s.expiredReason).toBe("expired");
    expect(s.expiredAt).toBeGreaterThan(0);
    expect(s.validated).toBe(false);     // no longer considered valid
    expect(s.userName).toBeNull();
  });

  it("clears the expiry flag when a NEW token is installed", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: "tester", error: null });
    markTokenExpired("expired");
    expect(getAuthState().expired).toBe(true);
    setRuntimeToken("brand-new-token-1234567890", { validated: true, userName: "tester", error: null });
    const s = getAuthState();
    expect(s.expired).toBe(false);
    expect(s.expiredReason).toBeNull();
    expect(getAccessToken()).toBe("brand-new-token-1234567890");
    expect(hasToken()).toBe(true);
  });

  it("is idempotent — repeated rejection keeps the first reason and timestamp", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    markTokenExpired("first reason");
    const at = store.expiredAt;
    markTokenExpired("second reason");
    expect(store.expiredReason).toBe("first reason");
    expect(store.expiredAt).toBe(at);
  });

  it("disconnect fully resets the expiry state", () => {
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    markTokenExpired("expired");
    clearRuntimeToken();
    const s = getAuthState();
    expect(s.expired).toBe(false);
    expect(s.connected).toBe(false);
    expect(getAccessToken()).toBeNull();
  });
});

describe("API adapter marks expiry on 401/403", () => {
  it("records expiry when Upstox returns 401", async () => {
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow(/401/);
    expect(store.expired).toBe(true);
    expect(store.expiredReason).toMatch(/401/);
    // subsequent calls must not even attempt a request with the dead token
    expect(getAccessToken()).toBeNull();
  });

  it("treats 403 as a per-endpoint entitlement issue, NOT a dead token", async () => {
    // 401 = the credential is invalid (global). 403 = the token is valid but
    // this specific resource is not enabled for the app (e.g. index
    // derivatives / option chain). A 403 must NOT disable the whole session,
    // otherwise one unentitled endpoint blocks every other working channel.
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403, headers: new Map(), json: async () => ({}) }));
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow(/403/);
    expect(store.expired).toBe(false);                 // session stays alive
    expect(getAccessToken()).toBe(TOKEN);              // other channels keep working
  });

  it("does NOT mark expiry on a rate-limit or server error", async () => {
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow(/429/);
    expect(store.expired).toBe(false);
    expect(getAccessToken()).toBe(TOKEN);   // still usable after backoff
  });

  it("raises a distinct message that asks for a NEW token once expired", async () => {
    setRuntimeToken(TOKEN, { validated: true, userName: null, error: null });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow();
    // the next call now fails before reaching fetch, with the expiry wording
    vi.stubGlobal("fetch", vi.fn());
    await expect(fetchQuotes(["NSE_EQ|INE467B01029"])).rejects.toThrow(/token has expired|enter an access token/i);
  });
});

describe("token validation detects expiry", () => {
  it("a rejected validation token is marked expired via markValidation", async () => {
    const { markValidation } = await import("@/lib/market/credentials");
    setRuntimeToken(TOKEN, { validated: true, userName: "u", error: null });
    markValidation(false, null, "Upstox profile check failed (HTTP 401).");
    expect(store.expired).toBe(true);
  });
  it("validateToken reports rejection without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const r = await validateToken("some-token-value-1234");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/401/);
  });
});

describe("expiry is diagnosed as an authentication problem", () => {
  it("categorises the expiry message as AUTH_ERROR with a re-entry next step", () => {
    const c = categorize("Upstox access token has expired — enter a new token in the connect box to resume live data");
    expect(c.category).toBe("AUTH_ERROR");
    expect(c.nextStep).toMatch(/fresh access token|generate a fresh/i);
  });
  it("categorises a 401 rejection as AUTH_ERROR", () => {
    expect(categorize("Upstox token rejected (401) — enter a new access token").category).toBe("AUTH_ERROR");
  });
  it("does not confuse expiry with being unconfigured", () => {
    const expired = categorize("Upstox access token has expired — enter a new token");
    const fresh = categorize("Upstox is not connected — enter an access token in the connect box");
    expect(expired.category).toBe("AUTH_ERROR");
    expect(fresh.category).toBe("NOT_CONNECTED");
    expect(expired.category).not.toBe(fresh.category);
  });
});
