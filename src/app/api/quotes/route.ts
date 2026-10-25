import { NextRequest, NextResponse } from "next/server";
import { batchQuotes } from "@/lib/market/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/quotes?symbols=TCS,RELIANCE,...
 * One batched Upstox call for an entire watchlist. Each row carries its own
 * state (LIVE / QUOTE_UNAVAILABLE / INSTRUMENT_UNAVAILABLE / NOT_CONNECTED /
 * AUTH_ERROR / RATE_LIMIT) and freshness timestamp — never a silent dash.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("symbols") ?? "";
  const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 120);
  if (!symbols.length) return NextResponse.json({ rows: [], ts: Date.now() });
  const rows = await batchQuotes(symbols);
  return NextResponse.json({ rows, ts: Date.now() });
}
