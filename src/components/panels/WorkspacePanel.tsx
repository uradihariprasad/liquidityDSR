"use client";

import { useState } from "react";
import { Panel, Chip, Stat, EvidenceList, QualityBanner, EmptyState } from "@/components/ui";
import PriceChart from "@/components/PriceChart";
import { fmtPx, fmtPct, fmtBig, fmtTimeShort, changeColor, stateTone, usePoll, dirColor } from "@/lib/client/api";
import Diagnostics from "@/components/Diagnostics";
import type { PanelProps } from "./common";

const WL_STATE: Record<string, { tone: any; label: string }> = {
  LIVE: { tone: "up", label: "live" },
  QUOTE_UNAVAILABLE: { tone: "warn", label: "no quote" },
  INSTRUMENT_UNAVAILABLE: { tone: "down", label: "unmapped" },
  NOT_CONNECTED: { tone: "warn", label: "offline" },
  AUTH_ERROR: { tone: "down", label: "auth" },
  RATE_LIMIT: { tone: "warn", label: "limit" },
  API_ERROR: { tone: "down", label: "api err" },
};

/**
 * Watchlist rail — ONE batched quote call covers every row (spec §4), so
 * rows populate without the user selecting each stock. Each row reports its
 * own state and freshness instead of an unexplained dash.
 */
function WatchRail({ current, onPick }: { current: string; onPick: (s: string) => void }) {
  const wl = usePoll("/api/watchlists", 60000);
  const items = wl.data?.watchlists?.[0]?.items ?? [];
  const symbols = items.map((i: any) => i.symbol).join(",");
  const quotes = usePoll(symbols ? `/api/quotes?symbols=${encodeURIComponent(symbols)}` : null, 5000, [symbols]);
  const rows: any[] = quotes.data?.rows ?? [];
  const bySym = new Map(rows.map((r) => [r.symbol, r]));
  const liveCount = rows.filter((r) => r.state === "LIVE").length;

  return (
    <div className="w-full xl:w-[158px] h-[155px] xl:h-auto shrink-0 rounded-lg border hairline bg-panel flex flex-col min-h-0">
      <div className="px-2.5 h-8 flex items-center justify-between border-b hairline shrink-0">
        <span className="panel-label">Watchlist</span>
        <span className="text-[8.5px] text-ink3 num">{liveCount}/{items.length} live</span>
      </div>
      <div className="flex-1 overflow-auto grid grid-cols-2 sm:grid-cols-3 xl:block auto-rows-min">
        {items.map((it: any) => {
          const q = bySym.get(it.symbol);
          const active = current === it.symbol;
          const st = WL_STATE[q?.state ?? ""] ?? { tone: "mute", label: quotes.loading ? "loading" : "—" };
          return (
            <button
              key={it.id}
              onClick={() => onPick(it.symbol)}
              title={q?.reason ?? `${it.symbol} — ${q?.name ?? ""}`}
              className={`w-full px-2.5 py-[7px] text-left border-b hairline/50 transition-colors ${active ? "bg-info/10 border-l-2 border-l-info" : "hover:bg-panel2 border-l-2 border-l-transparent"}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className={`text-[10.5px] font-bold truncate ${active ? "text-info" : ""}`}>{it.symbol}</span>
                <span className={`num text-[9.5px] ${changeColor(q?.changePct)}`}>{q?.changePct != null ? fmtPct(q.changePct) : "—"}</span>
              </div>
              <div className="flex items-center justify-between gap-1 mt-0.5">
                <span className="num text-[10px] text-ink2">{q?.price != null ? fmtPx(q.price) : "—"}</span>
                <Chip tone={st.tone} className="!px-1 !py-0 text-[8px]">{st.label}</Chip>
              </div>
              {q?.ts && (q.state === "LIVE" || q.state === "STALE_CACHED") && (
                <div className={`text-[8px] mt-0.5 num ${q.state === "STALE_CACHED" ? "text-warn/80" : "text-ink3"}`}>
                  {fmtTimeShort(q.ts)}{q.state === "STALE_CACHED" ? " · cached" : q.foEligible === false ? " · cash" : ""}
                </div>
              )}
              {q && q.state !== "LIVE" && q.state !== "STALE_CACHED" && q.reason && (
                <div className="text-[8px] text-warn/80 mt-0.5 leading-tight line-clamp-2">{q.reason}</div>
              )}
            </button>
          );
        })}
        {wl.data && !items.length && <EmptyState title="Empty watchlist" detail="Add instruments from Watchlists & Config." />}
      </div>
    </div>
  );
}

export function MovementExplanation({ movement, compact }: { movement: any; compact?: boolean }) {
  if (!movement) return null;
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={stateTone(movement.state)} className="text-[11px] px-2 py-1">{movement.state.replace(/_/g, " ")}</Chip>
        <Chip tone={movement.bias === "BULLISH" ? "up" : movement.bias === "BEARISH" ? "down" : "mute"}>bias {movement.bias}</Chip>
        <Chip tone={movement.momentum === "STRENGTHENING" ? "up" : movement.momentum === "WEAKENING" ? "down" : movement.momentum === "CONFLICTING" ? "warn" : "mute"}>
          {movement.momentum}
        </Chip>
        <Chip tone="mute">evidence {movement.quality}</Chip>
      </div>
      <EvidenceList title="Supporting evidence" items={movement.supporting ?? []} tone="up" />
      <EvidenceList title="Contradicting evidence" items={movement.contradicting ?? []} tone="down" />
      {!compact && (
        <>
          <EvidenceList title="What would confirm the next move" items={movement.confirmNext ?? []} tone="info" />
          <EvidenceList title="What invalidates the current bias" items={movement.invalidateBias ?? []} tone="warn" />
        </>
      )}
      <div className={`rounded-md border px-2.5 py-2 text-[11px] ${movement.tradeJustified ? "border-updim bg-up/5 text-up" : "border-line2 bg-panel2 text-ink2"}`}>
        {movement.tradeJustified
          ? "A trade scenario is justified by the rule set — review the scenario card; execution remains manual and disabled."
          : `System waits: ${movement.waitReason ?? "no qualifying state."}`}
      </div>
    </div>
  );
}

export function ScenarioCard({ scenario, compact }: { scenario: any; compact?: boolean }) {
  if (!scenario) return null;
  if (scenario.status === "NO_TRADE") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Chip tone="mute">NO TRADE</Chip>
          <span className="text-[10px] text-ink3">capital-protection gate active</span>
        </div>
        <EvidenceList title="Blocking conditions" items={scenario.noTradeReasons ?? []} tone="warn" />
        {!compact && <EvidenceList title="Context" items={[...(scenario.supporting ?? []), ...(scenario.contradicting ?? [])]} tone="mute" />}
      </div>
    );
  }
  const long = scenario.direction === "LONG";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={long ? "up" : "down"} className="text-[11px] px-2 py-1">{scenario.direction} · {scenario.setup.replace(/_/g, " ")}</Chip>
        <Chip tone={scenario.status === "ENTRY_CONDITION_MET" ? "warn" : "info"}>{scenario.status.replace(/_/g, " ")}</Chip>
        <Chip tone="mute">RR {scenario.rr ?? "—"}</Chip>
        <Chip tone="mute">FMPI {scenario.fmpi ?? "—"}</Chip>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="rounded border hairline bg-panel2 px-2 py-1.5">
          <div className="text-[8.5px] uppercase tracking-wider text-ink3">entry zone</div>
          <div className="num text-[11.5px] font-semibold text-info">{scenario.entryZone ? `${fmtPx(scenario.entryZone[0])} – ${fmtPx(scenario.entryZone[1])}` : "—"}</div>
        </div>
        <div className="rounded border hairline bg-panel2 px-2 py-1.5">
          <div className="text-[8.5px] uppercase tracking-wider text-ink3">invalidation (SL)</div>
          <div className="num text-[11.5px] font-semibold text-down">{fmtPx(scenario.stop)}</div>
        </div>
        <div className="rounded border hairline bg-panel2 px-2 py-1.5">
          <div className="text-[8.5px] uppercase tracking-wider text-ink3">targets</div>
          <div className="num text-[11.5px] font-semibold text-up">{fmtPx(scenario.t1)} <span className="text-ink3">/</span> {fmtPx(scenario.t2)}</div>
        </div>
      </div>
      <div className="text-[10.5px] text-ink2 leading-snug"><span className="text-ink3">Trigger:&nbsp;</span>{scenario.entryTrigger}</div>
      <div className="text-[10.5px] text-ink2 leading-snug"><span className="text-ink3">Stop logic:&nbsp;</span>{scenario.stopReason}</div>
      {!compact && (
        <>
          <EvidenceList title="Supporting" items={scenario.supporting ?? []} tone="up" />
          <EvidenceList title="Contradicting" items={scenario.contradicting ?? []} tone="down" />
          <EvidenceList title="Cancel setup if" items={scenario.cancelIf ?? []} tone="warn" />
        </>
      )}
      <div className="text-[9.5px] text-ink3 leading-snug border-t hairline pt-1.5">
        Analysis-only platform: order execution is disabled. Scenario ≠ recommendation; position sizing must respect configured risk limits.
      </div>
    </div>
  );
}

export default function WorkspacePanel({ symbol, setSymbol, bundle, bundleLoading }: PanelProps) {
  const [toggles, setToggles] = useState({ ema: true, vwap: true, zones: true, events: true, scenario: true, advanced: false, allLevels: false });
  const b = bundle;
  const toggleBtn = (k: keyof typeof toggles, label: string) => (
    <button
      key={k}
      onClick={() => setToggles((t) => ({ ...t, [k]: !t[k] }))}
      className={`h-6 px-2 rounded border text-[9.5px] font-semibold tracking-wider ${toggles[k] ? "border-info/40 text-info bg-info/10" : "hairline2 text-ink3 hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="h-full flex flex-col xl:flex-row gap-2.5 fade-up">
      <WatchRail current={symbol} onPick={setSymbol} />

      {/* chart column */}
      <div className="flex-1 min-w-0 flex flex-col gap-2.5">
        <Panel
          title={`${b?.label ?? symbol} · ${b?.tf ?? ""} · ${b?.quality?.marketSession ?? ""}`}
          className="flex-1"
          right={
            <div className="flex items-center gap-1 overflow-x-auto max-w-[58vw] sm:max-w-none">
              {toggleBtn("ema", "EMA")}
              {toggleBtn("vwap", "VWAP")}
              {toggleBtn("zones", "ZONES")}
              {toggleBtn("events", "EVENTS")}
              {toggleBtn("scenario", "TRADE")}
              {toggleBtn("advanced", "ADV")}
              {toggleBtn("allLevels", "ALL")}
            </div>
          }
          pad={false}
        >
              <div className="p-1 sm:p-2">
            {b?.candles?.length ? (
              <PriceChart bundle={b} height={420} showEma={toggles.ema} showVwap={toggles.vwap} showZones={toggles.zones} showEvents={toggles.events} showScenario={toggles.scenario} showAdvancedLabels={toggles.advanced} showAllLevels={toggles.allLevels} />
            ) : (
              <div className="p-3 space-y-2.5">
                <EmptyState
                  title={bundleLoading ? "Loading session…" : `No candle data for ${symbol}`}
                  detail={b?.diagnostics?.failureDetail ?? b?.movement?.waitReason ?? undefined}
                />
                {b?.diagnostics?.nextStep && (
                  <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-[10.5px] text-info leading-relaxed">
                    <b>Next step:</b> {b.diagnostics.nextStep}
                  </div>
                )}
                {b && <Diagnostics bundle={b} defaultOpen />}
              </div>
            )}
          </div>
        </Panel>
        <QualityBanner quality={b?.quality} />
        {b?.history && (
          <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-[10px] ${b.history.historyLoaded ? "hairline bg-panel2" : "border-warn/30 bg-warn/5"}`}>
            <span className="panel-label">chart range</span>
            <span className="num text-ink2">
              {b.history.sessions?.[0]} → {b.history.sessions?.[b.history.sessions.length - 1]}
            </span>
            <Chip tone={b.history.priorSessions >= 3 ? "up" : "warn"}>
              {b.history.priorSessions} prior + current
            </Chip>
            <span className="text-ink3 num">{b.history.timeframeCandles} candles ({b.history.completedCandles} completed)</span>
            <span className="text-ink3">updated {fmtTimeShort(b.history.fetchedAt)}</span>
            {!b.history.historyLoaded && <span className="text-warn">{b.history.historyError ?? "history unavailable — showing current session only"}</span>}
          </div>
        )}
        {b?.candles?.length > 0 && <Diagnostics bundle={b} />}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
          <Panel pad><Stat label="day open" value={fmtPx(b?.day?.open)} /></Panel>
          <Panel pad><Stat label="day high" value={fmtPx(b?.day?.high)} tone="text-up" /></Panel>
          <Panel pad><Stat label="day low" value={fmtPx(b?.day?.low)} tone="text-down" /></Panel>
          <Panel pad><Stat label="prev close" value={fmtPx(b?.day?.prevClose)} /></Panel>
          <Panel pad><Stat label="ATR" value={fmtPx(b?.last?.atr)} sub="14 · wilder" /></Panel>
          <Panel pad><Stat label="volume" value={fmtBig(b?.last?.volume)} sub={`relVol ${b?.last?.relVol?.toFixed?.(2) ?? "—"}×`} /></Panel>
        </div>
      </div>

      {/* explanation/scenario stack below chart on mobile */}
      <div className="w-full xl:w-[360px] shrink-0 flex flex-col gap-2.5 min-h-0">
        <Panel title="Market movement explanation" className="flex-[1.4] min-h-[200px]">
          <MovementExplanation movement={b?.movement} />
        </Panel>
        <Panel title="Trade scenario & risk" className="flex-1 min-h-[180px]">
          <ScenarioCard scenario={b?.scenario} compact />
        </Panel>
      </div>
    </div>
  );
}
