import { NextRequest, NextResponse } from "next/server";
import { searchUniverse, suggestSymbols } from "@/lib/market/universe";
import { engineMode } from "@/lib/market/engine";
import { ensureDiscovery, discoveryStatus } from "@/lib/market/discovery";
import { upstoxConfigured } from "@/lib/market/upstox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const foOnly = req.nextUrl.searchParams.get("fo") === "1";
  if (upstoxConfigured()) await ensureDiscovery();
  const items = searchUniverse(q, { limit: 25, foOnly });
  const disc = discoveryStatus();
  return NextResponse.json({
    items,
    universeSource: disc.source,
    discovery: disc,
    suggestions: q && items.length === 0 ? suggestSymbols(q) : [],
    note: engineMode() === "LIVE_UPSTOX"
      ? `Universe discovered from the Upstox instrument masters: ${disc.stocks} equities (${disc.foEligible} F&O-eligible) + ${disc.indices} indices.`
      : "Connect an Upstox access token (top-left box) to discover the live instrument universe — there is no fallback/demo list.",
  });
}
