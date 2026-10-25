import { NextResponse } from "next/server";
import { engineStatus } from "@/lib/market/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(engineStatus());
}
