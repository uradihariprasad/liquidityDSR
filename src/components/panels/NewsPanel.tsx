"use client";

import { useState } from "react";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { usePoll, timeAgo } from "@/lib/client/api";
import { ExternalLink, Newspaper, AlertOctagon } from "lucide-react";

const TONE: Record<string, string> = { BULLISH: "up", BEARISH: "down", NEUTRAL: "mute", UNCERTAIN: "warn" };
const IMPACT: Record<string, string> = { HIGH: "down", MEDIUM: "warn", LOW: "mute" };

export default function NewsPanel({ symbol, onPick }: { symbol: string; onPick: (s: string) => void }) {
  const [mode, setMode] = useState<"market" | "symbol">("market");
  const { data, loading } = usePoll(`/api/news${mode === "symbol" ? `?symbol=${symbol}` : ""}`, 120000, [mode, symbol]);
  const items = data?.items ?? [];
  const related = items.filter((n: any) => n.related);

  return (
    <div className="h-full flex flex-col gap-2.5 fade-up">
      <div className="flex items-center gap-2">
        <button onClick={() => setMode("market")} className={`h-7 px-3 rounded-md border text-[10.5px] font-semibold ${mode === "market" ? "border-info/40 text-info bg-info/10" : "hairline2 text-ink3"}`}>Indian market & macro</button>
        <button onClick={() => setMode("symbol")} className={`h-7 px-3 rounded-md border text-[10.5px] font-semibold ${mode === "symbol" ? "border-info/40 text-info bg-info/10" : "hairline2 text-ink3"}`}>{symbol}-specific</button>
        <span className="flex-1" />
        <Chip tone={data?.status === "OK" ? "up" : "warn"}>{data?.status === "OK" ? `${items.length} items · ${data.source}` : "source unavailable"}</Chip>
        {data && <span className="text-[9.5px] text-ink3">fetched {timeAgo(data.fetchedAt)}</span>}
      </div>

      {data?.status === "UNAVAILABLE" && (
        <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
          <AlertOctagon size={15} className="text-warn mt-0.5 shrink-0" />
          <div>
            <div className="text-[11.5px] font-semibold text-warn">News source unreachable — nothing is fabricated</div>
            <div className="text-[10.5px] text-ink2 mt-0.5">{data.error}</div>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 grid grid-cols-12 gap-2.5">
        <Panel title={mode === "symbol" ? `News mapped to ${symbol}` : "Latest coverage (Google News RSS)"} className="col-span-12 xl:col-span-8">
          {loading && !data && <EmptyState title="Fetching news…" />}
          <div className="space-y-2">
            {items.map((n: any) => (
              <article key={n.id} className="rounded-md border hairline bg-panel2 px-3 py-2.5 hover:border-line2 transition-colors">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <a href={n.link} target="_blank" rel="noreferrer" className="text-[12px] font-semibold leading-snug hover:text-info transition-colors flex items-start gap-1.5">
                      {n.headline}
                      <ExternalLink size={11} className="shrink-0 mt-0.5 text-ink3" />
                    </a>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Chip tone={TONE[n.tone] as any}>{n.tone}</Chip>
                      <Chip tone={IMPACT[n.impact] as any}>{n.impact} impact</Chip>
                      {n.related && (
                        <button onClick={() => onPick(n.related)}>
                          <Chip tone="violet" title="Open synchronized intelligence view">{n.related} ↗</Chip>
                        </button>
                      )}
                      <span className="text-[9.5px] text-ink3">{n.source} · {timeAgo(n.publishedTs)}</span>
                      {!n.verified && <span className="text-[8.5px] text-ink3 italic">impact = keyword heuristic, unverified</span>}
                    </div>
                    <p className="mt-1.5 text-[10.5px] text-ink2 leading-relaxed line-clamp-2">{n.summary}</p>
                    <div className="mt-1 text-[9px] text-ink3/80">{n.impactReason}</div>
                  </div>
                </div>
              </article>
            ))}
            {data?.status === "OK" && !items.length && <EmptyState title="No items in the recent window" detail="The 24h/dedup filter may have removed repeated headlines." />}
          </div>
        </Panel>

        <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5 min-h-0">
          <Panel title={`Linked to supported instruments (${related.length})`} className="flex-1">
            <div className="space-y-1.5">
              {related.slice(0, 12).map((n: any) => (
                <button key={n.id} onClick={() => onPick(n.related)} className="w-full text-left rounded border hairline bg-panel2 px-2.5 py-2 hover:border-info/40 transition-colors">
                  <div className="flex items-center gap-1.5">
                    <Chip tone="violet">{n.related}</Chip>
                    <Chip tone={TONE[n.tone] as any}>{n.tone}</Chip>
                    <span className="text-[8.5px] text-ink3 ml-auto">{timeAgo(n.publishedTs)}</span>
                  </div>
                  <div className="text-[10px] text-ink2 mt-1 leading-snug line-clamp-2">{n.headline}</div>
                </button>
              ))}
              {!related.length && <EmptyState title="No instrument-linked headlines" detail="Headlines are linked by conservative symbol/name matching — ambiguous mentions are deliberately unlinked." />}
            </div>
          </Panel>
          <Panel title="News interpretation rules" className="shrink-0">
            <ul className="space-y-1 text-[10px] text-ink2 leading-relaxed">
              <li>· Factual events (source + timestamp) are separated from the platform&apos;s impact interpretation.</li>
              <li>· A bullish/bearish headline is NEVER an automatic buy/sell suggestion — it routes into the synchronized intelligence view for evidence-based assessment.</li>
              <li>· Headlines are deduplicated by normalized text; publication time ≠ event time.</li>
              <li>· Sources: legitimate public RSS (Google News); terms & rate limits respected via server-side caching.</li>
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
