/**
 * Manual scan trigger tests.
 * Verifies the manual scan does NOT interrupt the automatic 30s cycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { triggerManualScan, SCAN_EVENT, useScanListener } from "@/lib/client/scanTrigger";


// minimal window stub for the node environment
(globalThis as any).window = {
  dispatchEvent: (e: any) => {
    const h = ((globalThis as any).__handlers ??= []);
    h.forEach((fn: any) => fn(e));
  },
  addEventListener: (_: string, fn: any) => {
    ((globalThis as any).__handlers ??= []).push(fn);
  },
  removeEventListener: (_: string, fn: any) => {
    const h = (globalThis as any).__handlers ?? [];
    const i = h.indexOf(fn);
    if (i >= 0) h.splice(i, 1);
  },
};

describe("manual scan trigger", () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("POSTs to /api/scanner and broadcasts a success event", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ coverage: { scanned: 219, fullyAnalysed: 40 }, scheduler: { fullyAnalysed: 40 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const events: any[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener(SCAN_EVENT, handler);
    try {
      const r = await triggerManualScan();
      expect(r.ok).toBe(true);
      expect(r.scanned).toBe(219);
      expect(r.analysed).toBe(40);
      expect(events).toHaveLength(1);
      expect(events[0].ok).toBe(true);
    } finally {
      window.removeEventListener(SCAN_EVENT, handler);
    }
  });

  it("broadcasts a failure event on HTTP error without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    const events: any[] = [];
    const handler = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener(SCAN_EVENT, handler);
    try {
      const r = await triggerManualScan();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/500/);
      expect(events).toHaveLength(1);
    } finally {
      window.removeEventListener(SCAN_EVENT, handler);
    }
  });

  it("does NOT clear or reset any polling interval", async () => {
    // The trigger only dispatches a window event; it never touches timers.
    // Simulate an active 30s interval and confirm it keeps firing.
    let ticks = 0;
    const interval = setInterval(() => ticks++, 20);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ coverage: { scanned: 1, fullyAnalysed: 1 } }),
    }));

    await triggerManualScan();
    await new Promise((r) => setTimeout(r, 70));
    expect(ticks).toBeGreaterThanOrEqual(3);   // interval kept running
    clearInterval(interval);
  });

  it("the auto-scan interval in ScannerPanel is 30 seconds", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/panels/ScannerPanel.tsx", "utf8");
    expect(src).toMatch(/SCAN_INTERVAL_MS\s*=\s*30_000/);
    // the interval must be created with usePoll, not cleared on manual scan
    expect(src).toMatch(/usePoll\("\/api\/scanner",\s*SCAN_INTERVAL_MS\)/);
    // the panel's own ticker cleanup is fine; what matters is that no manual
    // scan path clears the polling interval. usePoll owns that interval.
    expect(src).not.toMatch(/clearInterval\(.*scan/i);
  });

  it("the header ScanButton does not reset the panel's timer", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync("src/components/Terminal.tsx", "utf8");
    // the button calls triggerManualScan, which only POSTs + dispatches
    expect(src).toMatch(/triggerManualScan/);
    // Terminal legitimately clears its own 1s countdown ticker; what matters
    // is that the scan button path does not clear the 30s polling interval.
    const scanBtn = src.slice(src.indexOf('function ScanButton'), src.indexOf('function IndexTick'));
    expect(scanBtn).not.toMatch(/clearInterval|setInterval/);
  });
});

