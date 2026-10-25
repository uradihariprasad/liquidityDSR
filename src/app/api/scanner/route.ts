import { NextRequest, NextResponse } from "next/server";
import { quickFeatures, engineStatus, invalidateScanCache, getAnalysis, scanState } from "@/lib/market/engine";
import { runScanner, DEFAULT_SCANNER_CONFIG } from "@/lib/market/scanner";
import { getRuntimeConfig } from "@/lib/market/runtime";
import { evaluateAlertRules, markFired } from "@/lib/market/alerts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cfgFrom(url: URL) {
  const cfg = { ...DEFAULT_SCANNER_CONFIG, ...getRuntimeConfig().scanner };
  const countParam = Number(url.searchParams.get("count") ?? "");
  if (Number.isFinite(countParam) && countParam > 0 && countParam <= 20) cfg.count = countParam;
  return cfg;
}

/** evaluate alerts for the top-ranked candidates (best-effort, persisted) */
async function evaluateScanAlerts(result: ReturnType<typeof runScanner>) {
  const cfg = getRuntimeConfig().alerts;
  const top = [...(result.bullish ?? []), ...(result.bearish ?? [])].slice(0, 6);
  const fired: any[] = [];
  for (const c of top) {
    try {
      const bundle = await getAnalysis(c.symbol, 5);
      if (!bundle || !bundle.candles.length) continue;
      const events = evaluateAlertRules(bundle, { fmpiHigh: cfg.fmpiHigh, fmpiLow: cfg.fmpiLow });
      if (events.length) {
        markFired(events);
        fired.push(...events);
        try {
          const { db } = await import("@/db");
          const { alertEvents } = await import("@/db/schema");
          await db.insert(alertEvents).values(events.map((e) => ({
            ts: e.ts, symbol: e.symbol, kind: e.kind, severity: e.severity, message: e.message,
            price: e.price, detail: e.detail as any, dedupeKey: e.dedupeKey,
          })));
        } catch { /* best-effort persistence */ }
      }
    } catch { /* ignore per-symbol alert failures */ }
  }
  return fired;
}

export async function GET(req: NextRequest) {
  const feats = await quickFeatures(false);
  const cfg = cfgFrom(req.nextUrl);
  const result = runScanner(feats, engineStatus().universeSource, cfg);
  // progressive-scheduler coverage (per-instrument freshness + progress)
  (result as any).scheduler = scanState().coverage;
  // auto-alert evaluation piggybacks on the 30s auto-scan cadence
  const status = engineStatus();
  if (status.mode === "LIVE_UPSTOX" && feats.length) {
    const fired = await evaluateScanAlerts(result);
    (result as any).alertsFired = fired.length;
  }
  return NextResponse.json(result);
}

/** POST — manual scan: bypasses the scan cache and evaluates immediately. */
export async function POST(req: NextRequest) {
  invalidateScanCache();
  const feats = await quickFeatures(true);
  const cfg = cfgFrom(req.nextUrl ?? new URL("http://x/"));
  const result = runScanner(feats, engineStatus().universeSource, cfg);
  const status = engineStatus();
  if (status.mode === "LIVE_UPSTOX" && feats.length) {
    const fired = await evaluateScanAlerts(result);
    (result as any).alertsFired = fired.length;
  }
  (result as any).manual = true;
  return NextResponse.json(result);
}
