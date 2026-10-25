import { NextRequest, NextResponse } from "next/server";
import { getAnalysis } from "@/lib/market/engine";
import { evaluateAlertRules, markFired } from "@/lib/market/alerts";
import { scanOpportunities } from "@/lib/market/opportunities";
import { getRuntimeConfig } from "@/lib/market/runtime";
import { upstoxConfigured } from "@/lib/market/upstox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function persist(events: any[]) {
  if (!events.length) return;
  try {
    const { db } = await import("@/db");
    const { alertEvents } = await import("@/db/schema");
    await db.insert(alertEvents).values(events.map((e) => ({
      ts: e.ts, symbol: e.symbol, kind: e.kind, severity: e.severity, message: e.message,
      price: e.price, detail: e.detail as any, dedupeKey: e.dedupeKey,
    })));
  } catch { /* best-effort */ }
}

/**
 * POST — run the alert pipeline.
 *   { mode: "universe" }            scan the eligible universe (default)
 *   { mode: "symbols", symbols:[] } evaluate an explicit list
 *
 * Rules are evaluated ONLY against validated analysis for each instrument;
 * missing inputs never trigger a rule. Deduplication + cooldowns applied.
 */
export async function POST(req: NextRequest) {
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const mode = body.mode === "symbols" ? "symbols" : "universe";
  const cfg = getRuntimeConfig().alerts;

  if (!upstoxConfigured()) {
    return NextResponse.json({
      fired: [], evaluated: 0, scanned: 0, qualifyingByRule: {},
      available: false,
      reason: "Upstox is not connected — no instruments can be scanned, so no alerts can be generated.",
      ts: Date.now(),
    });
  }

  if (mode === "symbols") {
    const symbols: string[] = Array.isArray(body.symbols) ? body.symbols.map((s: any) => String(s).toUpperCase()).slice(0, 25) : [];
    const tf = Number(body.tf) || 5;
    const fired: any[] = [];
    for (const sym of symbols) {
      const bundle = await getAnalysis(sym, tf);
      if (!bundle || !bundle.candles.length) continue;
      const events = evaluateAlertRules(bundle, { fmpiHigh: cfg.fmpiHigh, fmpiLow: cfg.fmpiLow });
      if (events.length) { markFired(events); fired.push(...events); }
    }
    await persist(fired);
    return NextResponse.json({ fired, evaluated: symbols.length, scanned: symbols.length, qualifyingByRule: {}, available: true, reason: "", ts: Date.now() });
  }

  // Reuse the shared scan when it is still fresh. Forcing a full-universe
  // refresh here duplicated the quote load across /api/scanner,
  // /api/opportunities and /api/alerts and tripped the shared quote quota (B29).
  const scan = await scanOpportunities({ limit: 10 });
  await persist(scan.alerts);
  return NextResponse.json({
    fired: scan.alerts,
    evaluated: scan.evaluated,
    scanned: scan.scanned,
    qualifyingByRule: scan.qualifyingByRule,
    coverage: scan.coverage,
    available: scan.available,
    reason: scan.reason,
    ts: scan.ts,
  });
}

/** GET ?limit=&symbol= — persisted alert history + live qualifying snapshot. */
export async function GET(req: NextRequest) {
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit")) || 60);
  const symbol = req.nextUrl.searchParams.get("symbol");
  const withScan = req.nextUrl.searchParams.get("scan") === "1";

  let alerts: any[] = [];
  let note: string | null = null;
  try {
    const { db } = await import("@/db");
    const { alertEvents } = await import("@/db/schema");
    const { desc, eq } = await import("drizzle-orm");
    alerts = symbol
      ? await db.select().from(alertEvents).where(eq(alertEvents.symbol, symbol.toUpperCase())).orderBy(desc(alertEvents.id)).limit(limit)
      : await db.select().from(alertEvents).orderBy(desc(alertEvents.id)).limit(limit);
  } catch {
    note = "Alert history unavailable (database not reachable or not migrated).";
  }

  let qualifyingByRule: Record<string, any[]> = {};
  let coverage: any = null;
  let scanTs: number | null = null;
  if (withScan && upstoxConfigured()) {
    const scan = await scanOpportunities({});
    qualifyingByRule = scan.qualifyingByRule;
    coverage = scan.coverage;
    scanTs = scan.ts;
  }

  return NextResponse.json({ alerts, note, qualifyingByRule, coverage, scanTs, connected: upstoxConfigured() });
}
