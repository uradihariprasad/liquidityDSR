import { NextRequest, NextResponse } from "next/server";
import { scanOpportunities, invalidateOpportunityCache } from "@/lib/market/opportunities";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** GET — cached (30s) universe scan for the Trade Finder top-N. */
export async function GET(req: NextRequest) {
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 10));
  const scan = await scanOpportunities({ limit });
  return NextResponse.json(scan);
}

/** POST — forced immediate rescan (manual "Scan now"). */
export async function POST(req: NextRequest) {
  const limit = Math.min(20, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 10));
  invalidateOpportunityCache();
  const scan = await scanOpportunities({ force: true, limit });

  // persist the ranked scenarios for audit/history (best-effort)
  if (scan.candidates.length) {
    try {
      const { db } = await import("@/db");
      const { tradeScenarios } = await import("@/db/schema");
      await db.insert(tradeScenarios).values(scan.candidates.map((c) => ({
        ts: c.dataTs, symbol: c.symbol, tf: "5m",
        direction: c.direction.toLowerCase(), setup: c.setup,
        status: c.status.toLowerCase(),
        entry: c.entryZone?.[0] ?? null, stop: c.stop, t1: c.t1, t2: c.t2,
        rr: c.rr, fmpi: c.fmpi,
        evidence: { supporting: c.supporting, contradicting: c.contradicting, rankReason: c.rankReason } as any,
      })));
    } catch { /* persistence is best-effort */ }
  }
  return NextResponse.json({ ...scan, manual: true });
}
