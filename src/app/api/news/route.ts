import { NextRequest, NextResponse } from "next/server";
import { fetchNews, DEFAULT_NEWS_QUERY } from "@/lib/market/news";
import { getInstrument } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  const custom = req.nextUrl.searchParams.get("q");
  let query = custom?.trim() || DEFAULT_NEWS_QUERY;
  if (symbol) {
    const inst = getInstrument(symbol.toUpperCase());
    if (inst) {
      query = `${inst.name} stock OR ${inst.symbol} share`;
    }
  }
  const feed = await fetchNews(query, 30);
  return NextResponse.json(feed);
}
