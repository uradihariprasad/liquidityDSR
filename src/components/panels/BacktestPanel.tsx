"use client";

import { useState } from "react";
import { Panel, Chip, EmptyState, Row, EvidenceList } from "@/components/ui";
import PriceChart from "@/components/PriceChart";
import { postJSON, usePoll, fmtTime } from "@/lib/client/api";
import type { PanelProps } from "./common";
import { Play, History } from "lucide-react";

const DEFAULT_SYMBOLS = ["RELIANCE", "HDFCBANK", "TCS", "INFY", "SBIN", "TATAMOTORS"];

function MetricCard({ title, m }: { title: string; m: any }) {
  if (!m?.setups) return (
    <div className="rounded border hairline bg-panel2 px-3 py-2.5">
      <div className="panel-label mb-1">{title}</div>
      <div className="text-[10.5px] text-ink3">no setups in this segment</div>
    </div>
  );
  return (
    <div className="rounded border hairline bg-panel2 px-3 py-2.5 space-y-1">
      <div className="panel-label">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[["setups", m.setups], ["win rate", `${m.winRate}%`], ["expectancy", `${m.expectancyBps} bps`], ["profit factor", m.profitFactor ?? "—"],
          ["avg win", `${m.avgWinBps} bps`], ["avg loss", `${m.avgLossBps} bps`], ["max DD", `${m.maxDrawdownBps} bps`], ["avg R", m.avgR]].map(([k, v]) => (
          <div key={k as string}><div className="text-[8.5px] text-ink3 uppercase tracking-wider">{k}</div><div className="num text-[13px] font-bold">{v}</div></div>
        ))}
      </div>
      <div className="text-[9.5px] text-ink3">stops {m.stops} · targets {m.targets} · EOD exits {m.eodExits} · trend-day win {m.byRegime?.trend?.winRate ?? "—"}% · range-day win {m.byRegime?.range?.winRate ?? "—"}%</div>
    </div>
  );
}

export default function BacktestPanel({ bundle }: PanelProps) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [params, setParams] = useState({ days: 20, rr: 1.5, costBps: 6, tfMinutes: 5, minRelVol: 1.3 });
  const hist = usePoll("/api/backtest", 0);

  const run = async () => {
    setRunning(true);
    try {
      const res = await postJSON("/api/backtest", { symbols: DEFAULT_SYMBOLS, ...params });
      setResult(res);
      hist.refresh();
    } finally {
      setRunning(false);
    }
  };

  const P = ({ k, step, min, max }: any) => (
    <label className="flex flex-col gap-0.5">
      <span className="text-[8.5px] uppercase tracking-wider text-ink3">{k}</span>
      <input
        type="number" step={step} min={min} max={max}
        value={(params as any)[k]}
        onChange={(e) => setParams((p) => ({ ...p, [k]: Number(e.target.value) }))}
        className="w-[76px] bg-panel3 border hairline2 rounded px-1.5 py-1 text-[11px] num outline-none focus:border-info/50"
      />
    </label>
  );

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      <div className="col-span-12 xl:col-span-7 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Historical replay — current session with rule-driven events"
          className="flex-1"
          right={<Chip tone="info">live session</Chip>}
          pad={false}
        >
          <div className="p-2 h-full">
            {bundle?.candles?.length ? <PriceChart bundle={bundle} height={380} showEma showVwap showZones showEvents showScenario /> : <EmptyState title="No data to replay" />}
          </div>
          <div className="px-3 pb-3">
            <div className="panel-label mb-1.5">Detected events (no lookahead: markers use only data available at that candle)</div>
            <div className="flex flex-wrap gap-1.5">
              {(bundle?.events ?? []).map((e: any, i: number) => (
                <Chip key={i} tone={e.kind === "SWEEP" ? "warn" : e.kind === "CHOCH" ? "violet" : e.kind === "BOS" ? "info" : "mute"}>
                  {e.kind} · {fmtTime(e.ts)}
                </Chip>
              ))}
              {!(bundle?.events ?? []).length && <span className="text-[10px] text-ink3">No structural events detected in the visible window.</span>}
            </div>
          </div>
        </Panel>
      </div>

      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Backtest — documented breakout rule set"
          className="flex-1"
          right={
            <button onClick={run} disabled={running} className="flex items-center gap-1.5 h-6 px-2.5 rounded border border-up/40 text-up text-[10px] font-semibold hover:bg-up/10 disabled:opacity-50">
              <Play size={10} /> {running ? "running…" : "run backtest"}
            </button>
          }
        >
          <div className="flex flex-wrap items-end gap-2.5 mb-3">
            <P k="days" step={1} min={5} max={60} />
            <P k="rr" step={0.1} min={0.8} max={4} />
            <P k="costBps" step={1} min={0} max={30} />
            <P k="minRelVol" step={0.1} min={0.8} max={3} />
            <div className="text-[9.5px] text-ink3 leading-snug max-w-[220px]">
              Universe: {DEFAULT_SYMBOLS.join(", ")} · timeframe {params.tfMinutes}m · conservative stop-first intrabar fills.
            </div>
          </div>

          {!result && <EmptyState title="No run yet" detail="Runs fetch real historical minute candles from Upstox and return full metrics with out-of-sample separation." />}
          {result && result.available === false && (
            <div className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
              <div className="text-[12px] font-semibold text-warn">Backtest unavailable</div>
              <div className="text-[10.5px] text-ink2 mt-1 leading-relaxed">{result.reason}</div>
              <EvidenceList title="Disclaimers" items={result.disclaimers ?? []} tone="warn" />
            </div>
          )}
          {result && result.available !== false && (
            <div className="space-y-2">
              <MetricCard title={`Overall — ${result.metrics.daysTested} days × ${result.params.symbols.length} symbols`} m={result.metrics.overall} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <MetricCard title={`In-sample (${result.metrics.inSampleDays}d)`} m={result.metrics.inSample} />
                <MetricCard title="Out-of-sample" m={result.metrics.outOfSample} />
              </div>
              <div className="text-[9.5px] text-ink3 leading-snug">{result.dataNote}</div>
              <EvidenceList title="Disclaimers (always attached)" items={result.disclaimers ?? []} tone="warn" />
            </div>
          )}
        </Panel>

        <Panel title="Recent persisted runs" className="shrink-0">
          {(hist.data?.runs ?? []).slice(0, 4).map((r: any) => (
            <div key={r.id} className="flex items-center gap-2 py-1 text-[10px] text-ink2 border-b hairline/50 last:border-b-0">
              <History size={10} className="text-ink3" />
              <span className="num">run #{r.id}</span>
              <span className="text-ink3">{new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })}</span>
              <span className="ml-auto num">setups {r.metrics?.overall?.setups ?? 0} · exp {r.metrics?.overall?.expectancyBps ?? "—"} bps</span>
            </div>
          ))}
          {!(hist.data?.runs ?? []).length && <div className="text-[10px] text-ink3 py-1">Executions are persisted to Postgres for audit.</div>}
        </Panel>
      </div>
    </div>
  );
}
