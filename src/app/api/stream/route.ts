import { NextRequest } from "next/server";
import { engineStatus, getCoordinatedSnapshot } from "@/lib/market/engine";
import { rateLimitState } from "@/lib/market/ratelimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-Sent Events channel.
 *
 * ROOT CAUSE B19 (fixed): this route previously called getSnapshot() on its own
 * 4-second timer PER CLIENT, so N connected tabs triggered N independent
 * market-data refreshes every 4 seconds.
 *
 * It now uses getCoordinatedSnapshot(), which gives every client the SAME
 * shared cache entry: one refresh per symbol per TTL window, a much longer TTL
 * while the market is closed, and a failure that never discards the last
 * known-good snapshot. Each payload carries its own data timestamp, age and a
 * `stale` flag so cached values are never presented as live.
 */
export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get("symbol") ?? "NIFTY").toUpperCase();
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        if (closed) return;
        try {
          const coordinated = await getCoordinatedSnapshot(symbol);
          const payload = {
            ts: Date.now(),
            status: engineStatus(),
            rateLimit: rateLimitState(),
            symbol,
            snapshot: coordinated.snapshot,
            // cache/freshness metadata so the client can label staleness
            freshness: {
              dataTs: coordinated.dataTs,
              cachedAt: coordinated.cachedAt,
              ageMs: coordinated.ageMs,
              stale: coordinated.stale,
              session: coordinated.session,
              refreshIntervalMs: coordinated.refreshIntervalMs,
              errorCount: coordinated.errorCount,
              lastError: coordinated.lastError,
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          if (!closed) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: "snapshot push failed" })}\n\n`));
          }
        }
      };
      await push();
      // Tick faster than the refresh TTL so clients observe cooldown changes,
      // while the actual market-data refresh stays coordinated server-side.
      const timer = setInterval(push, 2000);
      req.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(timer);
        try { controller.close(); } catch { /* noop */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
