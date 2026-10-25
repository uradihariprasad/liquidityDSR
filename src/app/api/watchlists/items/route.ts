import { NextRequest, NextResponse } from "next/server";
import { getInstrument } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const watchlistId = Number(body.watchlistId);
    const symbol = String(body.symbol ?? "").toUpperCase();
    const inst = getInstrument(symbol);
    if (!watchlistId || !inst) return NextResponse.json({ error: "valid watchlistId and symbol required" }, { status: 400 });
    const { db } = await import("@/db");
    const { watchlistItems } = await import("@/db/schema");
    const [item] = await db.insert(watchlistItems).values({ watchlistId, symbol: inst.symbol, kind: inst.kind, instrumentKey: inst.instrumentKey }).returning();
    return NextResponse.json({ item });
  } catch (err: any) {
    if (String(err?.message ?? "").includes("duplicate")) return NextResponse.json({ error: "already in watchlist" }, { status: 409 });
    return NextResponse.json({ error: "failed to add item" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = Number(req.nextUrl.searchParams.get("id"));
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { db } = await import("@/db");
    const { watchlistItems } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(watchlistItems).where(eq(watchlistItems.id, id));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "failed to remove item" }, { status: 500 });
  }
}
