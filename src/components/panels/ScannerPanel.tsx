"use client";

import { useEffect, useState } from "react";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { usePoll, fmtPx, fmtPct, changeColor, stateTone } from "@/lib/client/api";
import { useScanListener } from "@/lib/client/scanTrigger";
import { TrendingUp, TrendingDown, AlertTriangle, Zap, Radar, Loader2 } from "lucide-react";

const SCAN_INTERVAL_MS = 30_000;

function CandidateCard({ c, onPick }: { c: any; onPick: (s: string) => void }) {
  return (
    <button onClick={() => onPick(c.symbol)} className="w-full text-left rounded-md border hairline bg-panel2 hover:border-info/40 px-2.5 py-2 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] font-bold">{c.symbol}</span>
        <span className={`num text-[11px] ${changeColor(c.changePct)}`}>{fmtPx(c.price)} {fmtPct(c.changePct)}</span>
        <span className="flex-1" />
        <Chip tone="mute">rank {c.rankScore}</Chip>
        <Chip tone="info">FMPI {c.fmpi.toFixed(0)}</Chip>
        <Chip tone={c.direction === "BULLISH" ? "up" : "down"}>{c.direction}</Chip>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[9.5px] text-ink3">
        <span>relVol <span className="num text-ink2">{c.relVol.toFixed(2)}×</span></span>
        <span>structure <span className="num text-ink2">{c.structure}</span></span>
        <span className={`truncate ${stateTone(c.state) === "up" ? "text-up/80" : stateTone(c.state) === "down" ? "text-down/80" : ""}`}>{c.state.replace(/_/g, " ")}</span>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {c.reasons.slice(0, 3).map((r: string, i: number) => (
          <div key={i} className="text-[10px] text-ink2 leading-snug flex gap-1.5"><span className="text-up mt-0.5">▸</span>{r}</div>
        ))}
      </div>
      <div className="mt-1 text-[9.5px] text-ink3 leading-snug"><span className="text-warn/80">invalidates:</span> {c.invalidation[0]}</div>
      <div className="mt-0.5 text-[9px] text-ink3/80 italic">{c.dominanceLabel}</div>
    </button>
  );
}

export default function ScannerPanel({ onPick }: { onPick: (s: string) => void }) {
  const { data, error, loading, refresh, lastFetch } = usePoll("/api/scanner", SCAN_INTERVAL_MS);
  const [scanning, setScanning] = useState(false);
  const [, setTick] = useState(0);

  // A manual scan (header button or this panel's own button) broadcasts an
  // event; we refresh the DISPLAY immediately. The 30s auto-scan interval
  // above is never cleared or reset by this.
  const { lastScan } = useScanListener(() => { refresh(); });

  // 1s countdown ticker for the auto-scan cadence
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const manualScan = async () => {
    setScanning(true);
    try {
      await fetch("/api/scanner", { method: "POST" });
    } finally {
      await refresh();
      setScanning(false);
    }
  };

  if (loading && !data) return <EmptyState title="Scanning universe…" detail="First scan downloads the Upstox instrument master and quotes — takes a few seconds." />;
  if (!data) return <EmptyState title="Scanner unavailable" detail={error ?? "Connect Upstox to activate the live universe scan."} />;

  const nextIn = Math.max(0, Math.round((SCAN_INTERVAL_MS - (Date.now() - (data.ts || lastFetch))) / 1000));
  const disconnected = data.coverage?.universeSource === "NONE" || data.coverage?.scanned === 0;

  const Column = ({ title, items, tone, onPick }: any) => (
    <Panel title={title} right={<Chip tone={tone}>{items.length} / {data.config.count}</Chip>} className="h-full">
      <div className="space-y-2">
        {items.map((c: any) => <CandidateCard key={c.symbol} c={c} onPick={onPick} />)}
        {!items.length && <EmptyState title="No candidates meet the quality bar" detail="Lists are never padded — filters can be relaxed in Watchlists & Config." />}
      </div>
    </Panel>
  );

  return (
    <div className="h-full flex flex-col gap-2.5 fade-up">
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <button
          onClick={manualScan}
          disabled={scanning || disconnected}
          className="flex items-center gap-1.5 h-7 px-3 rounded-md bg-info/90 hover:bg-info text-black text-[11px] font-bold disabled:opacity-40"
          title="Force an immediate universe scan (bypasses the 30s cache)"
        >
          {scanning ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />}
          {scanning ? "Scanning…" : "Scan now"}
        </button>
        <Chip tone="info" title="The automatic scan runs every 30 seconds regardless of manual scans.">auto 30s · next {nextIn}s</Chip>
        {lastScan && <Chip tone={lastScan.ok ? "up" : "down"}>manual {lastScan.ok ? "ok" : "failed"}</Chip>}
        {(data as any).alertsFired > 0 && <Chip tone="warn">{(data as any).alertsFired} alerts fired</Chip>}
        <Chip tone="up" title={data.coverage.note}>{data.coverage.fullyAnalysed ?? 0} fully analysed</Chip>
        {(data.coverage.partiallyAnalysed ?? 0) > 0 && <Chip tone="warn" title="Analysed but with degraded data quality">{data.coverage.partiallyAnalysed} partial</Chip>}
        {(data.coverage.quoteOnly ?? 0) > 0 && <Chip tone="mute" title="Quoted only — awaiting candle analysis; never ranked as a signal">{data.coverage.quoteOnly} quote-only</Chip>}
        {(data.coverage.insufficientData ?? 0) > 0 && <Chip tone="warn" title="Analysis attempted but insufficient valid history">{data.coverage.insufficientData} insufficient</Chip>}
        <Chip tone="mute">coverage: {data.coverage.scanned} scanned · {data.coverage.eligible} eligible</Chip>
        <Chip tone="mute">universe: {data.coverage.universeSource}</Chip>
        <Chip tone="cyan" className="hidden xl:inline-flex">{data.formula}</Chip>
        {disconnected && <Chip tone="warn">connect Upstox to populate</Chip>}
        {data.strongestMomentum && (
          <Chip tone="warn" title="Strongest momentum right now">
            <Zap size={10} /> {data.strongestMomentum.symbol} · FMPI {data.strongestMomentum.fmpi.toFixed(0)}
          </Chip>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 flex-1 min-h-0">
        <Column title="Top bullish candidates" items={data.bullish} tone="up" onPick={onPick} />
        <Column title="Top bearish candidates" items={data.bearish} tone="down" onPick={onPick} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5 shrink-0 xl:h-[210px]">
        <Panel title="Buyer-dominant (evidence-bar: FMPI≥60 + relVol≥1.3 + structure)" className="h-full">
          <div className="space-y-1">
            {data.buyerDominant.map((c: any) => (
              <button key={c.symbol} onClick={() => onPick(c.symbol)} className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded hover:bg-panel3">
                <TrendingUp size={11} className="text-up shrink-0" />
                <span className="text-[10.5px] font-bold">{c.symbol}</span>
                <span className="num text-[9.5px] text-ink3 ml-auto">FMPI {c.fmpi.toFixed(0)} · {c.relVol.toFixed(1)}×</span>
              </button>
            ))}
            {!data.buyerDominant.length && <div className="text-[10px] text-ink3 py-2">None — dominance criteria not met; results are not forced.</div>}
          </div>
        </Panel>
        <Panel title="Seller-dominant (same bar, downside)" className="h-full">
          <div className="space-y-1">
            {data.sellerDominant.map((c: any) => (
              <button key={c.symbol} onClick={() => onPick(c.symbol)} className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded hover:bg-panel3">
                <TrendingDown size={11} className="text-down shrink-0" />
                <span className="text-[10.5px] font-bold">{c.symbol}</span>
                <span className="num text-[9.5px] text-ink3 ml-auto">FMPI {c.fmpi.toFixed(0)} · {c.relVol.toFixed(1)}×</span>
              </button>
            ))}
            {!data.sellerDominant.length && <div className="text-[10px] text-ink3 py-2">None — dominance criteria not met; results are not forced.</div>}
          </div>
        </Panel>
        <Panel title="Confirmed breaks & relVol spikes" className="h-full">
          <div className="space-y-1">
            {[...data.confirmedBreakouts.map((c: any) => ({ ...c, t: "BO ↑" })), ...data.confirmedBreakdowns.map((c: any) => ({ ...c, t: "BD ↓" }))].slice(0, 5).map((c: any) => (
              <button key={c.symbol + c.t} onClick={() => onPick(c.symbol)} className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded hover:bg-panel3">
                <Chip tone={c.t === "BO ↑" ? "up" : "down"}>{c.t}</Chip>
                <span className="text-[10.5px] font-bold">{c.symbol}</span>
                <span className="num text-[9.5px] text-ink3 ml-auto">{fmtPct(c.changePct)}</span>
              </button>
            ))}
            {data.risingRelVol.slice(0, 3).map((c: any) => (
              <button key={c.symbol} onClick={() => onPick(c.symbol)} className="w-full flex items-center gap-2 text-left px-1.5 py-1 rounded hover:bg-panel3">
                <Chip tone="cyan">RVOL</Chip>
                <span className="text-[10.5px] font-bold">{c.symbol}</span>
                <span className="num text-[9.5px] text-ink3 ml-auto">{c.relVol.toFixed(2)}×</span>
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="Warnings" className="h-full">
          <div className="space-y-1">
            {data.warnings.slice(0, 8).map((w: any, i: number) => (
              <button key={i} onClick={() => onPick(w.symbol)} className="w-full flex items-start gap-1.5 text-left px-1.5 py-1 rounded hover:bg-panel3">
                <AlertTriangle size={10} className="text-warn shrink-0 mt-0.5" />
                <span className="text-[9.5px] text-ink2 leading-snug"><b>{w.symbol}</b> — {w.warning}</span>
              </button>
            ))}
            {!data.warnings.length && <div className="text-[10px] text-ink3 py-2">No momentum-weakening or conflict warnings.</div>}
          </div>
        </Panel>
      </div>
      <div className="text-[9.5px] text-ink3 leading-snug">{data.dominanceNote}</div>
    </div>
  );
}
