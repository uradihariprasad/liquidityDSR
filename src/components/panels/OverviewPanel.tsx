"use client";

import { Panel, Stat, Chip, EmptyState } from "@/components/ui";
import { fmtPct, fmtPx, fmtBig, changeColor, stateTone } from "@/lib/client/api";
import { usePoll } from "@/lib/client/api";
import { TrendingUp, TrendingDown, AlertTriangle } from "lucide-react";

function StockRow({ s, onPick, extra }: { s: any; onPick: (x: string) => void; extra?: string }) {
  return (
    <button onClick={() => onPick(s.symbol)} className="w-full flex items-center gap-2 px-2 py-[5px] rounded hover:bg-panel3 text-left group">
      <span className="text-[11px] font-bold w-[86px] truncate group-hover:text-info transition-colors">{s.symbol}</span>
      <span className="num text-[10.5px] text-ink2 w-[70px] text-right">{fmtPx(s.price)}</span>
      <span className={`num text-[10.5px] w-[58px] text-right ${changeColor(s.changePct)}`}>{fmtPct(s.changePct)}</span>
      <span className="num text-[10px] text-ink3 w-[46px] text-right">{s.relVol ? `${s.relVol.toFixed(1)}×` : "—"}</span>
      <span className="flex-1 text-right">{extra ? <Chip tone="mute">{extra}</Chip> : null}</span>
    </button>
  );
}

export default function OverviewPanel({ overview, onPick }: { overview: any; onPick: (s: string) => void }) {
  const status = overview?.status;
  const b = overview?.breadth;
  const total = (b?.advancers ?? 0) + (b?.decliners ?? 0) + (b?.unchanged ?? 0) || 1;
  const advPct = ((b?.advancers ?? 0) / total) * 100;
  const decPct = ((b?.decliners ?? 0) / total) * 100;

  return (
    <div className="h-full overflow-auto space-y-2.5 fade-up">
      {/* top: indices + breadth + notes */}
      <div className="grid grid-cols-12 gap-2.5">
        {[
          { k: "nifty", label: "NIFTY 50" },
          { k: "sensex", label: "BSE SENSEX" },
          { k: "banknifty", label: "NIFTY BANK" },
        ].map(({ k, label }) => {
          const s = overview?.indices?.[k];
          return (
            <Panel key={k} className="col-span-12 md:col-span-4" pad>
              <div className="flex items-start justify-between">
                <div>
                  <div className="panel-label">{label}</div>
                  <button onClick={() => onPick(s?.symbol ?? "NIFTY")} className={`num text-[26px] font-bold mt-1 hover:text-info transition-colors ${changeColor(s?.changePct)}`}>
                    {fmtPx(s?.price, 0)}
                  </button>
                  <div className={`num text-[12px] mt-0.5 ${changeColor(s?.changePct)}`}>
                    {s?.change > 0 ? "+" : ""}{fmtPx(s?.change)} ({fmtPct(s?.changePct)})
                  </div>
                </div>
                <div className="text-right space-y-1">
                  <Chip tone={stateTone(s?.state)}>{(s?.state ?? "—").replace(/_/g, " ")}</Chip>
                  <div className="text-[10px] text-ink3">FMPI <span className="num text-ink2">{s?.fmpi?.toFixed?.(1) ?? "—"}</span></div>
                  <div className="text-[10px] text-ink3">relVol <span className="num text-ink2">{s?.relVol?.toFixed?.(2) ?? "—"}×</span></div>
                </div>
              </div>
            </Panel>
          );
        })}
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        {/* breadth */}
        <Panel title={`Market breadth — ${overview?.coverage?.stocksScanned ?? "…"} instruments scanned`} className="col-span-12 lg:col-span-4">
          <div className="flex items-center gap-3 mt-1">
            <Stat label="Advancers" value={b?.advancers ?? "—"} tone="text-up" />
            <Stat label="Decliners" value={b?.decliners ?? "—"} tone="text-down" />
            <Stat label="Unchanged" value={b?.unchanged ?? "—"} />
          </div>
          <div className="mt-3 h-3 rounded-full overflow-hidden flex border hairline">
            <div className="bg-up/80" style={{ width: `${advPct}%` }} />
            <div className="bg-line2" style={{ width: `${100 - advPct - decPct}%` }} />
            <div className="bg-down/80" style={{ width: `${decPct}%` }} />
          </div>
          <div className="mt-2 text-[10px] text-ink3">
            Breadth is computed from the engine&apos;s per-instrument quick analysis ({status?.universeSource === "UPSTOX_INSTRUMENT_MASTER" ? "dynamically discovered Upstox F&O universe" : "awaiting connection"}).
          </div>
          <div className="mt-3 grid grid-cols-3 sm:grid-cols-5 gap-1">
            {(overview?.sectors ?? []).map((s: any) => (
              <div key={s.sector} className={`rounded border hairline px-1 py-1 text-center ${s.avgChangePct >= 0 ? "bg-up/5" : "bg-down/5"}`} title={`${s.count} instruments`}>
                <div className="text-[8.5px] text-ink3 truncate">{s.sector}</div>
                <div className={`num text-[10px] font-semibold ${changeColor(s.avgChangePct)}`}>{fmtPct(s.avgChangePct)}</div>
              </div>
            ))}
          </div>
        </Panel>

        {/* gainers / losers */}
        <Panel title="Top relative movers (quality-filtered universe)" className="col-span-12 lg:col-span-4" right={<Chip tone="up">gainers</Chip>}>
          <div className="divide-y divide-line/60">
            {(overview?.gainers ?? []).map((s: any) => <StockRow key={s.symbol} s={s} onPick={onPick} extra={s.state?.includes("BREAKOUT") ? "BO" : undefined} />)}
            {!overview && <EmptyState title="Loading…" />}
          </div>
        </Panel>
        <Panel title="Weakest movers" className="col-span-12 lg:col-span-4" right={<Chip tone="down">losers</Chip>}>
          <div className="divide-y divide-line/60">
            {(overview?.losers ?? []).map((s: any) => <StockRow key={s.symbol} s={s} onPick={onPick} extra={s.state?.includes("BREAKDOWN") ? "BD" : undefined} />)}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-12 gap-2.5">
        <Panel title="Engine status & data quality" className="col-span-12 lg:col-span-6">
          <div className="space-y-1.5 text-[11px]">
            <div className="flex gap-2"><span className="text-ink3 w-[130px]">Mode</span><Chip tone={status?.mode === "DISCONNECTED" ? "warn" : "up"}>{status?.mode}</Chip></div>
            <div className="flex gap-2"><span className="text-ink3 w-[130px]">Session</span><span className="text-ink2">{status?.session} — {status?.sessionNote}</span></div>
            <div className="flex gap-2"><span className="text-ink3 w-[130px]">Universe</span><span className="text-ink2">{status?.universeSource} ({status?.universeSize} instruments)</span></div>
            <div className="flex gap-2"><span className="text-ink3 w-[130px]">Connection</span><span className="text-ink2">{status?.connection}</span></div>
            <div className="flex gap-2"><span className="text-ink3 w-[130px]">Timeframes</span><span className="text-ink2">{(status?.timeframes ?? []).map((m: number) => `${m}m`).join(" · ")}</span></div>
            {(status?.notes ?? []).map((n: string, i: number) => (
              <div key={i} className="flex gap-1.5 text-[10.5px] text-ink3"><AlertTriangle size={11} className="mt-0.5 shrink-0 text-warn" />{n}</div>
            ))}
          </div>
        </Panel>
        <Panel title="Methodology & honesty notes" className="col-span-12 lg:col-span-6">
          <ul className="space-y-1.5 text-[10.5px] text-ink2 leading-relaxed list-none">
            <li>· Every state, zone, score and scenario on this platform is computed from documented rules (see README §9–§12). No unexplained BUY/SELL labels are shown.</li>
            <li>· Directly observed data, calculated metrics, estimates and unavailable channels are labelled distinctly across panels.</li>
            <li>· FMPI is a momentum composite (0–100), never a win probability. Thresholds are configurable; no accuracy percentage is claimed.</li>
            <li>· True footprint / executed order-flow attribution requires trade-level aggressor data, which the Upstox quote API does not provide — those panels show capability states instead of invented numbers.</li>
            <li>· The terminal is live-data-only: with no Upstox token connected it stays idle — there is no simulated/demo feed anywhere.</li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
