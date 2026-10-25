import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_ITEMS = ["NIFTY", "BANKNIFTY", "SENSEX", "RELIANCE", "HDFCBANK", "TCS", "INFY", "SBIN", "BAJFINANCE", "KOTAKBANK"];

/**
 * Seeds the default watchlist once the universe has been discovered.
 * Symbols are stored ONLY if they resolve against the live instrument
 * master, so a renamed/delisted ticker is never persisted as a dead row.
 */
async function ensureDefault() {
  const { db } = await import("@/db");
  const { watchlists, watchlistItems } = await import("@/db/schema");
  const { getInstrument } = await import("@/lib/market/universe");
  const { ensureDiscovery } = await import("@/lib/market/discovery");
  const { upstoxConfigured } = await import("@/lib/market/upstox");
  if (upstoxConfigured()) await ensureDiscovery();

  const existing = await db.select().from(watchlists).limit(1);
  let wlId: number;
  if (existing.length === 0) {
    const [wl] = await db.insert(watchlists).values({ name: "Core F&O", isDefault: true }).returning();
    wlId = wl.id;
  } else {
    wlId = existing[0].id;
  }
  // backfill resolvable defaults (idempotent — unique index guards duplicates)
  const have = new Set((await db.select().from(watchlistItems)).map((i) => i.symbol));
  for (const sym of DEFAULT_ITEMS) {
    if (have.has(sym)) continue;
    const inst = getInstrument(sym);
    if (!inst) continue;
    try {
      await db.insert(watchlistItems).values({ watchlistId: wlId, symbol: inst.symbol, kind: inst.kind, instrumentKey: inst.instrumentKey });
    } catch { /* unique constraint — already present */ }
  }
}

export async function GET() {
  try {
    await ensureDefault();
    const { db } = await import("@/db");
    const { watchlists, watchlistItems } = await import("@/db/schema");
    const wls = await db.select().from(watchlists);
    const items = await db.select().from(watchlistItems);
    return NextResponse.json({ watchlists: wls.map((w) => ({ ...w, items: items.filter((i) => i.watchlistId === w.id) })) });
  } catch (err) {
    return NextResponse.json({ watchlists: [], note: "Watchlists unavailable (database not reachable). Using session-local instruments." });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim().slice(0, 60);
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
    const { db } = await import("@/db");
    const { watchlists } = await import("@/db/schema");
    const [wl] = await db.insert(watchlists).values({ name }).returning();
    return NextResponse.json({ watchlist: wl });
  } catch {
    return NextResponse.json({ error: "failed to create watchlist" }, { status: 500 });
  }
}
