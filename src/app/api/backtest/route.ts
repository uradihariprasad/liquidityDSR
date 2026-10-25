import { NextRequest, NextResponse } from "next/server";
import { runBacktest, DEFAULT_BACKTEST } from "@/lib/market/backtest";
import { getInstrument } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const symbols = Array.isArray(body.symbols)
    ? body.symbols.map((s: any) => String(s).toUpperCase()).filter((s: string) => getInstrument(s)).slice(0, 12)
    : DEFAULT_BACKTEST.symbols;
  const params = {
    symbols,
    days: Math.min(60, Math.max(5, Number(body.days) || DEFAULT_BACKTEST.days)),
    tfMinutes: [5, 15].includes(Number(body.tfMinutes)) ? Number(body.tfMinutes) : 5,
    rr: Math.min(4, Math.max(0.8, Number(body.rr) || DEFAULT_BACKTEST.rr)),
    costBps: Math.min(30, Math.max(0, Number(body.costBps ?? DEFAULT_BACKTEST.costBps))),
    slippageBps: Math.min(20, Math.max(0, Number(body.slippageBps ?? DEFAULT_BACKTEST.slippageBps))),
    minRelVol: Math.min(3, Math.max(0.8, Number(body.minRelVol) || DEFAULT_BACKTEST.minRelVol)),
    fmpiLiteMin: Math.min(80, Math.max(30, Number(body.fmpiLiteMin) || DEFAULT_BACKTEST.fmpiLiteMin)),
  };
  const result = await runBacktest(params);

  // persist run (best-effort, available results only)
  if (result?.available) {
    try {
      const { db } = await import("@/db");
      const { backtestRuns } = await import("@/db/schema");
      await db.insert(backtestRuns).values({ params: result.params as any, metrics: result.metrics as any, note: result.dataNote });
    } catch {
      /* DB persistence is best-effort; the result is returned regardless */
    }
  }
  return NextResponse.json(result);
}

export async function GET() {
  // recent persisted runs
  try {
    const { db } = await import("@/db");
    const { backtestRuns } = await import("@/db/schema");
    const { desc } = await import("drizzle-orm");
    const rows = await db.select().from(backtestRuns).orderBy(desc(backtestRuns.id)).limit(10);
    return NextResponse.json({ runs: rows });
  } catch (err) {
    return NextResponse.json({ runs: [], note: "Backtest history unavailable (database not reachable)." });
  }
}
