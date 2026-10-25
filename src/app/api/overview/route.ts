import { NextResponse } from "next/server";
import { engineStatus, getSnapshot, overviewStats, quickFeatures } from "@/lib/market/engine";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const [status, nifty, sensex, banknifty, stats, feats] = await Promise.all([
    Promise.resolve(engineStatus()),
    getSnapshot("NIFTY"),
    getSnapshot("SENSEX"),
    getSnapshot("BANKNIFTY"),
    overviewStats(),
    quickFeatures(),
  ]);
  const niftyFeat = feats.find((f) => f.symbol === "NIFTY");
  return NextResponse.json({
    ts: Date.now(),
    status,
    indices: { nifty, sensex, banknifty },
    breadth: { advancers: stats.advancers, decliners: stats.decliners, unchanged: stats.unchanged },
    sectors: stats.sectors,
    gainers: stats.gainers,
    losers: stats.losers,
    marketMovement: { state: niftyFeat?.state ?? "INSUFFICIENT_DATA", fmpi: niftyFeat?.fmpi ?? 0 },
    coverage: { universeSize: status.universeSize, stocksScanned: feats.length },
  });
}
