import { NextRequest, NextResponse } from "next/server";
import { getAnalysis, TIMEFRAMES } from "@/lib/market/engine";
import { getInstrument } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const tfRaw = Number(req.nextUrl.searchParams.get("tf") ?? "5");
  const tf = (TIMEFRAMES as readonly number[]).includes(tfRaw) ? tfRaw : 5;
  // Always returns a renderable bundle — unknown/disconnected states are
  // expressed inside the payload (quality + waitReason) rather than as a 404,
  // so every panel can explain itself instead of rendering blank.
  const bundle = await getAnalysis(symbol, tf);
  return NextResponse.json(bundle);
}
