"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** lightweight polling data hook */
/**
 * Polling hook with strict race protection (spec §3).
 *
 * `seq` guards against out-of-order responses, and `keyRef` ensures a
 * response belonging to a PREVIOUS url (i.e. the previously selected
 * instrument) can never populate the current view — when the url changes
 * the stale data is cleared immediately so no other instrument's values
 * linger on screen.
 */
export function usePoll<T = any>(url: string | null, intervalMs: number, deps: unknown[] = []): { data: T | null; error: string | null; loading: boolean; lastFetch: number; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const seq = useRef(0);
  const keyRef = useRef<string | null>(url);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    const myKey = url;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // discard late responses AND responses for a different instrument/url
      if (my !== seq.current || myKey !== keyRef.current) return;
      setData(json);
      setError(null);
      setLastFetch(Date.now());
    } catch (err) {
      if (my !== seq.current || myKey !== keyRef.current) return;
      if ((err as any)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (my === seq.current && myKey === keyRef.current) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    // url changed => previous instrument's state must not persist
    if (keyRef.current !== url) {
      keyRef.current = url;
      seq.current++;
      setData(null);
      setError(null);
    }
    setLoading(true);
    load();
    if (timer.current) clearInterval(timer.current);
    if (intervalMs > 0) timer.current = setInterval(load, intervalMs);
    return () => {
      if (timer.current) clearInterval(timer.current);
      abortRef.current?.abort();
    };
  }, [url, intervalMs, ...deps]);

  return { data, error, loading, lastFetch, refresh: load };
}

export async function postJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function putJSON(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export function fmtPx(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digits ?? (Math.abs(v) >= 10000 ? 1 : Math.abs(v) >= 100 ? 2 : 2);
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

export function fmtBig(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
}

export function fmtTimeShort(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString("en-IN", { hour12: false, hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dirColor(dir: string | null | undefined): string {
  if (dir === "BULLISH" || dir === "LONG" || dir === "UP") return "text-up";
  if (dir === "BEARISH" || dir === "SHORT" || dir === "DOWN") return "text-down";
  return "text-ink2";
}

export function changeColor(v: number | null | undefined): string {
  if (v == null) return "text-ink2";
  if (v > 0.005) return "text-up";
  if (v < -0.005) return "text-down";
  return "text-ink2";
}

export function stateTone(state: string | null | undefined): "up" | "down" | "warn" | "info" | "mute" {
  if (!state) return "mute";
  if (state.includes("BULLISH") || state.includes("UPSIDE") || state.includes("FAILED_BREAKDOWN")) return "up";
  if (state.includes("BEARISH") || state.includes("DOWNSIDE") || state.includes("FAILED_BREAKOUT")) return "down";
  if (state.includes("SWEEP") || state.includes("REVERSAL") || state.includes("DEVELOPING") || state.includes("SHIFT")) return "warn";
  if (state.includes("CONFLICTING") || state.includes("INSUFFICIENT")) return "mute";
  return "info";
}
