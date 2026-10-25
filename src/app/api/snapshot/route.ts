import { NextRequest, NextResponse } from "next/server";
import { getSnapshot } from "@/lib/market/engine";
import { getInstrument } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  if (!getInstrument(symbol)) {
    return NextResponse.json({ error: `Unknown instrument "${symbol}".` }, { status: 404 });
  }
  return NextResponse.json(await getSnapshot(symbol));
}
