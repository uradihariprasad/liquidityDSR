"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Global manual-scan trigger.
 *
 * A manual scan must NOT interrupt the automatic 30-second polling cycle.
 * Each panel owns its own `setInterval` via `usePoll`; that interval keeps
 * running regardless of a manual trigger. The manual scan simply:
 *   1. POSTs to /api/scanner (server-side forced refresh)
 *   2. Broadcasts a "pg:scan" window event so visible panels can refresh
 *      their display immediately instead of waiting up to 30s.
 *
 * The auto-scan timer is never cleared or reset by this.
 */

export const SCAN_EVENT = "pg:scan";

export interface ScanResult {
  ok: boolean;
  scanned: number;
  analysed: number;
  error: string | null;
  at: number;
}

export function triggerManualScan(): Promise<ScanResult> {
  return (async () => {
    try {
      const res = await fetch("/api/scanner", { method: "POST" });
      if (!res.ok) throw new Error(`scan failed (HTTP ${res.status})`);
      const json = await res.json();
      const out: ScanResult = {
        ok: true,
        scanned: json?.coverage?.scanned ?? 0,
        analysed: json?.coverage?.fullyAnalysed ?? json?.scheduler?.fullyAnalysed ?? 0,
        error: null,
        at: Date.now(),
      };
      // broadcast AFTER the server has new data, so listeners fetch fresh state
      window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: out }));
      return out;
    } catch (err) {
      const out: ScanResult = {
        ok: false, scanned: 0, analysed: 0,
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
      window.dispatchEvent(new CustomEvent(SCAN_EVENT, { detail: out }));
      return out;
    }
  })();
}

/**
 * Subscribe to manual-scan broadcasts. Returns the latest result so a panel
 * can show "manual scan completed" feedback. The panel's own polling
 * interval is unaffected — this only supplements it.
 */
export function useScanListener(onScan?: () => void): { lastScan: ScanResult | null } {
  const [lastScan, setLastScan] = useState<ScanResult | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ScanResult;
      setLastScan(detail);
      // let the caller refresh its own data without touching its interval
      onScan?.();
    };
    window.addEventListener(SCAN_EVENT, handler);
    return () => window.removeEventListener(SCAN_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { lastScan };
}
