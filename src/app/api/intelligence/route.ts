import { NextRequest, NextResponse } from "next/server";
import { getAnalysis } from "@/lib/market/engine";
import { capabilityRegistry } from "@/lib/market/capabilities";
import { flowCapability } from "@/lib/market/flow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * MODULE A + G — capability registry and unified buyer/seller intelligence.
 * Reuses the cached analysis bundle, so it never triggers a second
 * market-data refresh (Module I requirement).
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const tfRaw = Number(req.nextUrl.searchParams.get("tf") ?? "5");
  const tf = [1, 2, 3, 5, 15, 30].includes(tfRaw) ? tfRaw : 5;

  const bundle = await getAnalysis(symbol, tf);
  const bs = (bundle as any)?.buyerSeller ?? null;

  return NextResponse.json({
    symbol,
    tf,
    ts: Date.now(),
    capabilities: capabilityRegistry(),
    flowCapability: flowCapability(),
    intelligence: bs,
  });
}
