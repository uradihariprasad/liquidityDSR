"use client";

import { useMemo, useState } from "react";
import { Panel, Chip, EmptyState, FeedGate } from "@/components/ui";
import { usePoll, fmtTime, fmtPx, timeAgo } from "@/lib/client/api";
import type { PanelProps } from "./common";
import { BellRing, Radar, Loader2, Filter } from "lucide-react";

const SEV: Record<string, any> = { info: "info", warning: "warn", critical: "down" };

const RULES: { id: string; desc: string; cooldown: string }[] = [
  { id: "FMPI_HIGH", desc: "FMPI crosses above the configured high threshold", cooldown: "30m" },
  { id: "FMPI_LOW", desc: "FMPI falls below the configured low threshold", cooldown: "30m" },
  { id: "MOMENTUM_STRENGTHENING", desc: "FMPI state transitions to strengthening", cooldown: "60m" },
  { id: "MOMENTUM_WEAKENING", desc: "FMPI state transitions to weakening", cooldown: "60m" },
  { id: "BREAKOUT", desc: "Confirmed close beyond resistance with relVol ≥ 1.3 + range expansion", cooldown: "60m" },
  { id: "BREAKDOWN", desc: "Confirmed close below support with relVol ≥ 1.3 + range expansion", cooldown: "60m" },
  { id: "FAILED_BREAKOUT", desc: "Break reclaimed — potential bull trap", cooldown: "60m" },
  { id: "FAILED_BREAKDOWN", desc: "Breakdown reclaimed — potential bear trap", cooldown: "60m" },
  { id: "LIQUIDITY_SWEEP", desc: "Validated breach-and-reclaim (5-criteria sweep engine)", cooldown: "60m" },
  { id: "STRUCTURAL_SHIFT", desc: "CHOCH followed by aligned structure", cooldown: "60m" },
  { id: "ZONE_TESTING", desc: "Price inside an active liquidity zone", cooldown: "30m" },
  { id: "ZONE_REJECTED", desc: "Zone defended with ≥2 rejection reactions", cooldown: "60m" },
  { id: "ZONE_BROKEN", desc: "Decisive close through the zone (side-aware)", cooldown: "60m" },
  { id: "ZONE_RECLAIMED", desc: "Close back inside after a breach", cooldown: "60m" },
  { id: "ZONE_SWEPT", desc: "Zone shows a validated sweep event", cooldown: "60m" },
  { id: "SCENARIO_CONFIRMED", desc: "Trade scenario reaches ENTRY_CONDITION_MET", cooldown: "60m" },
  { id: "FEED_HEALTH", desc: "Data feed STALE or UNAVAILABLE", cooldown: "10m" },
];

export default function AlertsPanel({ bundle }: PanelProps) {
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<any>(null);
  const [q, setQ] = useState("");
  const hist = usePoll("/api/alerts?limit=80&scan=1", 30000);

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "universe" }),
      });
      setLastScan(await res.json());
    } finally {
      setScanning(false);
      hist.refresh();
    }
  };

  const alerts: any[] = hist.data?.alerts ?? [];
  const qualifying: Record<string, any[]> = lastScan?.qualifyingByRule ?? hist.data?.qualifyingByRule ?? {};
  const connected = hist.data?.connected;
  const coverage = lastScan?.coverage ?? hist.data?.coverage;

  const filtered = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (!t) return alerts;
    return alerts.filter((a) => a.symbol.includes(t) || String(a.kind).includes(t));
  }, [alerts, q]);

  const qualifyingCount = Object.values(qualifying).reduce((n, arr) => n + arr.length, 0);

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      {/* qualifying + history */}
      <div className="col-span-12 xl:col-span-7 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Currently qualifying stocks (live rule state across the scanned universe)"
          className="flex-[1.1] min-h-[220px]"
          right={
            <button onClick={runScan} disabled={scanning} className="flex items-center gap-1.5 h-6 px-2.5 rounded border border-info/40 text-info text-[10px] font-semibold hover:bg-info/10 disabled:opacity-50">
              {scanning ? <Loader2 size={10} className="animate-spin" /> : <Radar size={10} />}{scanning ? "scanning…" : "Scan universe"}
            </button>
          }
        >
          {!connected && <FeedGate quality={bundle?.quality} what="Alert scanning" extra="Rules below are configured and will evaluate automatically once instruments can be fetched." />}
          {connected && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[9.5px]">
                {(lastScan as any)?.scheduler && (
                  <>
                    <Chip tone="info" title={(lastScan as any).scheduler.note}>
                      universe {(lastScan as any).scheduler.universe}
                    </Chip>
                    <Chip tone="up">{(lastScan as any).scheduler.fullyAnalysed} analysed</Chip>
                    {(lastScan as any).scheduler.pendingAnalysis > 0 && (
                      <Chip tone="warn" title="Awaiting a later cycle — never alerted on">{(lastScan as any).scheduler.pendingAnalysis} pending</Chip>
                    )}
                    <Chip tone="mute">{(lastScan as any).scheduler.progressPct}% covered</Chip>
                  </>
                )}
                {coverage && <Chip tone="mute">{coverage.shortlist} evaluated</Chip>}
                <Chip tone={qualifyingCount ? "warn" : "mute"}>{qualifyingCount} rule matches</Chip>
                {lastScan?.fired != null && <Chip tone={lastScan.fired.length ? "up" : "mute"}>{lastScan.fired.length} new alerts fired</Chip>}
                {(lastScan?.ts ?? hist.data?.scanTs) && <span className="text-ink3">scanned {timeAgo(lastScan?.ts ?? hist.data?.scanTs)}</span>}
              </div>
              {qualifyingCount === 0 ? (
                <EmptyState
                  title="No qualifying stocks at this time"
                  detail={coverage ? `${coverage.note} Nothing is invented to populate this view.` : "Run a universe scan to evaluate the rule set against live data."}
                />
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(qualifying).map(([rule, rows]) => (
                    <div key={rule} className="rounded border hairline bg-panel2 px-2.5 py-1.5">
                      <div className="flex items-center gap-2">
                        <Chip tone="info">{rule.replace(/_/g, " ")}</Chip>
                        <span className="text-[9px] text-ink3">{rows.length} match{rows.length > 1 ? "es" : ""}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {rows.slice(0, 14).map((r: any, i: number) => (
                          <span key={i} className="text-[9.5px] num text-ink2 rounded bg-panel3 px-1.5 py-0.5" title={r.value}>
                            {r.symbol} <span className="text-ink3">{fmtPx(r.price)}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>

        <Panel
          title="Triggered alert history (persisted, deduplicated)"
          className="flex-1 min-h-[180px]"
          right={
            <div className="flex items-center gap-1.5">
              <Filter size={10} className="text-ink3" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="symbol / rule"
                className="w-[120px] bg-panel3 border hairline2 rounded px-1.5 py-0.5 text-[10px] outline-none placeholder:text-ink3" />
            </div>
          }
        >
          <div className="space-y-1">
            {filtered.map((a: any) => (
              <div key={a.id} className="flex items-center gap-2 rounded border hairline bg-panel2 px-2.5 py-1.5">
                <Chip tone={SEV[a.severity] ?? "info"}>{a.severity}</Chip>
                <Chip tone="mute">{a.kind}</Chip>
                <span className="text-[10.5px] font-bold">{a.symbol}</span>
                <span className="text-[10.5px] text-ink2 flex-1 truncate">{a.message}</span>
                <span className="num text-[9.5px] text-ink3">{a.price ? fmtPx(a.price) : ""}</span>
                <span className="num text-[9.5px] text-ink3">{fmtTime(a.ts)}</span>
              </div>
            ))}
            {!filtered.length && (
              <EmptyState title={alerts.length ? "No alerts match the filter" : "No alerts triggered yet"}
                detail={hist.data?.note ?? "Alerts fire only when a rule's conditions are met on validated data. Cooldowns prevent an unchanged condition from re-firing."} />
            )}
          </div>
        </Panel>
      </div>

      {/* rules + current instrument */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel title={`Active rules (${RULES.length}) — configured thresholds`} className="flex-1">
          <div className="space-y-1">
            {RULES.map((r) => {
              const hits = qualifying[r.id]?.length ?? 0;
              return (
                <div key={r.id} className="rounded border hairline bg-panel2 px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <BellRing size={10} className={hits ? "text-warn" : "text-ink3"} />
                    <span className="text-[10.5px] font-bold">{r.id}</span>
                    {hits > 0 && <Chip tone="warn">{hits} now</Chip>}
                    <span className="text-[9px] text-ink3 ml-auto">cooldown {r.cooldown}</span>
                  </div>
                  <div className="text-[9.5px] text-ink2 mt-0.5 leading-snug">{r.desc}</div>
                </div>
              );
            })}
          </div>
          <div className="text-[9px] text-ink3 mt-2 leading-snug">
            A listed rule is a <b className="text-ink2">configuration</b>; an entry in history is an <b className="text-ink2">actual trigger</b>. Rules whose inputs are unavailable (e.g. executed order flow) never fire as if confirmed.
          </div>
        </Panel>

        <Panel title={`Current instrument triggers — ${bundle?.symbol ?? "…"}`} className="shrink-0">
          {(bundle?.candles?.length ?? 0) === 0 ? (
            <FeedGate quality={bundle?.quality} what="Live trigger evaluation" />
          ) : (
            <div className="text-[10.5px] text-ink2 space-y-1.5">
              <div className="flex items-center gap-2"><span>FMPI <span className="num">{bundle?.fmpi?.score?.toFixed(1)}</span></span>
                {bundle?.fmpi?.score >= 70 ? <Chip tone="warn">would fire</Chip> : <Chip tone="mute">clear</Chip>}</div>
              <div className="flex items-center gap-2"><span>State {(bundle?.movement?.state ?? "—").replace(/_/g, " ")}</span>
                {["CONFIRMED_UPSIDE_BREAKOUT", "CONFIRMED_DOWNSIDE_BREAKDOWN", "POTENTIAL_LIQUIDITY_SWEEP", "FAILED_BREAKOUT", "FAILED_BREAKDOWN", "CONFIRMED_STRUCTURAL_SHIFT"].includes(bundle?.movement?.state) ? <Chip tone="warn">alert state</Chip> : <Chip tone="mute">clear</Chip>}</div>
              <div>Zones testing <span className="num">{(bundle?.zones ?? []).filter((z: any) => z.status === "TESTING").length}</span> · swept <span className="num">{(bundle?.zones ?? []).filter((z: any) => z.status === "POTENTIALLY_SWEPT").length}</span></div>
              <div className="flex items-center gap-2"><span>Feed {bundle?.quality?.status}</span>
                {["STALE", "UNAVAILABLE"].includes(bundle?.quality?.status) ? <Chip tone="down">critical</Chip> : <Chip tone="up">ok</Chip>}</div>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
