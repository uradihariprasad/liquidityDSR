/**
 * Upstox credential store.
 *
 * The access token is held ONLY in server memory (globalThis singleton) or
 * the UPSTOX_ACCESS_TOKEN environment variable. It is never persisted to
 * the database, never written to logs, and never embedded in any client
 * response except as a masked preview (first4…last2) owned by the user who
 * entered it.
 */

export interface AuthState {
  connected: boolean;
  /** true when a token exists but Upstox rejected it (401/403) */
  expired: boolean;
  expiredReason: string | null;
  expiredAt: number | null;
  source: "runtime" | "env" | null;
  masked: string | null;
  validated: boolean;
  userName: string | null;
  validationError: string | null;
  connectedAt: number | null;
  checkedAt: number | null;
}

interface Store {
  token: string | null;
  validated: boolean;
  userName: string | null;
  validationError: string | null;
  connectedAt: number | null;
  checkedAt: number | null;
  /** set the moment any Upstox call is rejected with 401/403 */
  expired: boolean;
  expiredReason: string | null;
  expiredAt: number | null;
}

const g = globalThis as typeof globalThis & { __pulsegridAuth?: Store };
export const store: Store = (g.__pulsegridAuth ??= {
  token: null,
  validated: false,
  userName: null,
  validationError: null,
  connectedAt: null,
  checkedAt: null,
  expired: false,
  expiredReason: null,
  expiredAt: null,
});

/** A token that Upstox rejected is treated as absent by every data module. */
export function getAccessToken(): string | null {
  if (store.expired) return null;
  if (store.token) return store.token;
  const env = process.env.UPSTOX_ACCESS_TOKEN;
  if (env && env.trim().length > 10) return env.trim();
  return null;
}

/**
 * Record that the current token was rejected by Upstox. Called by the API
 * adapter on 401/403 so the whole application immediately stops fetching with
 * a dead credential and reports the true cause instead of generic errors.
 */
export function markTokenExpired(reason: string): void {
  if (store.expired) return;
  store.expired = true;
  store.expiredReason = reason;
  store.expiredAt = Date.now();
  store.validated = false;
  store.validationError = reason;
}

/** A token is usable only when present AND not rejected. */
export function hasToken(): boolean {
  return getAccessToken() != null;
}

export function tokenSource(): "runtime" | "env" | null {
  if (store.token) return "runtime";
  const env = process.env.UPSTOX_ACCESS_TOKEN;
  if (env && env.trim().length > 10) return "env";
  return null;
}

function mask(t: string): string {
  if (t.length <= 8) return "•••";
  return `${t.slice(0, 4)}…${t.slice(-2)}`;
}

/** Installing a new token always clears any previous expiry flag. */
export function setRuntimeToken(token: string, meta: { validated: boolean; userName: string | null; error: string | null }): AuthState {
  store.token = token.trim();
  store.validated = meta.validated;
  store.userName = meta.userName;
  store.validationError = meta.error;
  store.connectedAt = Date.now();
  store.checkedAt = Date.now();
  store.expired = false;
  store.expiredReason = null;
  store.expiredAt = null;
  return getAuthState();
}

export function markValidation(valid: boolean, userName: string | null, error: string | null): void {
  store.validated = valid;
  store.userName = userName;
  store.validationError = error;
  store.checkedAt = Date.now();
  if (!valid && error && /401|403|rejected|expired/i.test(error)) {
    markTokenExpired(error);
  }
}

export function clearRuntimeToken(): void {
  store.token = null;
  store.validated = false;
  store.userName = null;
  store.validationError = null;
  store.connectedAt = null;
  store.checkedAt = null;
  store.expired = false;
  store.expiredReason = null;
  store.expiredAt = null;
}

/** True when an env-provided token is in place (even if expired). */
function envTokenPresent(): boolean {
  const env = process.env.UPSTOX_ACCESS_TOKEN;
  return !!env && env.trim().length > 10;
}

export function getAuthState(): AuthState {
  const runtimeToken = store.token;
  const src = runtimeToken ? "runtime" : envTokenPresent() ? "env" : null;
  const raw = runtimeToken ?? (envTokenPresent() ? process.env.UPSTOX_ACCESS_TOKEN!.trim() : null);
  return {
    // "connected" means a credential is installed; `expired` qualifies it
    connected: raw != null,
    expired: store.expired,
    expiredReason: store.expiredReason,
    expiredAt: store.expiredAt,
    source: src,
    masked: raw ? mask(raw) : null,
    validated: store.expired ? false : store.validated,
    userName: store.expired ? null : store.userName,
    validationError: store.expired ? store.expiredReason : store.validationError,
    connectedAt: store.connectedAt,
    checkedAt: store.checkedAt,
  };
}

