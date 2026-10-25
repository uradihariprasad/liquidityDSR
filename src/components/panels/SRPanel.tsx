"use client";

import { useState } from "react";
import { Panel, Chip, EvidenceList, EmptyState } from "@/components/ui";
import { fmtPx, fmtTime } from "@/lib/client/api";
import { useScanListener } from "@/lib/client/scanTrigger";

const SR_STATE_TONE: Record<string, any> = {
  STRONG_SUPPORT: "up", SUPPORT_STRENGTHENING: "up", SUPPORT_WEAKENING: "warn",
  SUPPORT_BREAKDOWN_RISK: "down", BROKEN_SUPPORT: "down", RECLAIMED_SUPPORT: "cyan",
  STRONG_RESISTANCE: "down", RESISTANCE_STRENGTHENING: "down", RESISTANCE_WEAKENING: "warn",
  RESISTANCE_BREAKOUT_RISK: "up", BROKEN_RESISTANCE: "up", RECLAIMED_RESISTANCE: "cyan",
  UNTESTED: "mute", EXPIRED_LOW_RELEVANCE: "mute",
};

const MACHINE_TONE: Record<string, any> = {
  APPROACHING: "info", TESTING: "warn", BREAKOUT_PENDING: "warn", BREAKDOWN_PENDING: "warn",
  CONFIRMED_BREAKOUT: "up", CONFIRMED_BREAKDOWN: "down", RETEST_IN_PROGRESS: "info",
  SUCCESSFUL_RETEST: "up", FAILED_BREAKOUT: "down", FAILED_BREAKDOWN: "up",
  RECLAIMED_ZONE: "cyan", NEUTRAL: "mute",
};

const MOVEMENT_TONE: Record<string, any> = {
  BULLISH_CONTINUATION: "up", BEARISH_CONTINUATION: "down",
  PULLBACK_IN_UPTREND: "info", PULLBACK_IN_DOWNTREND: "info",
  RESISTANCE_REJECTION_CANDIDATE: "down", SUPPORT_REJECTION_CANDIDATE: "up",
  BREAKOUT_PENDING_CONFIRMATION: "warn", BREAKDOWN_PENDING_CONFIRMATION: "warn",
  FAILED_BREAKOUT: "down", FAILED_BREAKDOWN: "up", REVERSAL_CANDIDATE: "violet",
  SIDEWAYS_RANGE_BOUND: "mute", UNCERTAIN_CONFLICTING: "mute",
};

function ZoneCard({ p, label }: { p: any; label: string }) {
  if (!p) return <div className="text-[10px] text-ink3">No reliable {label.toLowerCase()} identified</div>;
  const z = p.zone;
  return (
    <div className="rounded border hairline bg-panel2 px-2 py-1.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="panel-label">{label}</span>
        <Chip tone={SR_STATE_TONE[z.srState] ?? "mute"}>{z.srState.replace(/_/g, " ").toLowerCase()}</Chip>
        {z.roleFlipped && <Chip tone="cyan">role flipped</Chip>}
        {z.isOiDerived && <Chip tone="violet" title="Provisional — no price-action confirmation at this level">OI-only · provisional</Chip>}
        <span className="num text-[11px] font-semibold ml-auto">{fmtPx(z.bottom)}–{fmtPx(z.top)}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-2 gap-y-0.5 text-[9px] text-ink3">
        <span>dist <span className="num text-ink2">{p.distanceAtr.toFixed(2)}×ATR</span></span>
        <span>str <span className="num text-ink2">{z.strength}</span></span>
        <span>tests <span className="num text-ink2">{z.tests}</span></span>
        <span>conf <span className="num text-ink2">{z.independentConfluence}</span></span>
        <span>state <Chip tone={MACHINE_TONE[z.machineState] ?? "mute"} className="!px-1 !text-[8px]">{z.machineState.replace(/_/g, " ").toLowerCase()}</Chip></span>
      </div>
      <div className="mt-1 text-[9px] text-ink3 leading-snug">{p.selectionReason}</div>
      {z.scoreComponents && (
        <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-x-2 gap-y-0.5 text-[8.5px] text-ink3">
          {(["structure", "profile", "oi", "recency"] as const).map((k) => {
            const c = z.scoreComponents[k];
            return (
              <span key={k} title={c.available ? `${c.earned}/${c.max} points` : "unavailable — excluded from the denominator"}>
                {k === "oi" ? "OI" : k}{" "}
                {c.available
                  ? <span className="num text-ink2">{c.earned}/{c.max}</span>
                  : <span className="text-warn">n/a</span>}
              </span>
            );
          })}
          {z.scoreComponents.normalized && (
            <span className="text-warn/80 col-span-2 sm:col-span-4">
              normalised from /{z.scoreComponents.normalizingMax} — unavailable sources excluded
            </span>
          )}
        </div>
      )}
      {z.strengthBreakdown?.length > 0 && (
        <details className="mt-1">
          <summary className="text-[8.5px] text-ink3 cursor-pointer">evidence detail ({z.strength}/100)</summary>
          <div className="mt-0.5 space-y-0.5">
            {z.strengthBreakdown.map((b: any, i: number) => (
              <div key={i} className="flex justify-between gap-2 text-[8.5px]">
                <span className="text-ink3">{b.factor} — {b.detail}</span>
                <span className={`num shrink-0 ${b.points > 0 ? "text-up" : b.points < 0 ? "text-down" : "text-ink3"}`}>{b.points > 0 ? "+" : ""}{b.points}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {z.oiEvidence && (
        <div className={`mt-0.5 text-[8.5px] ${z.oiEvidence.available ? "text-ink3" : "text-warn/80"}`}>
          OI: {z.oiEvidence.available ? z.oiEvidence.reason : "unavailable — excluded from scoring"}
        </div>
      )}
      <div className="mt-0.5 text-[8.5px] text-ink3">source: {z.source}</div>
    </div>
  );
}

export default function SRPanel({ bundle }: { bundle: any }) {
  const [showAll, setShowAll] = useState(false);
  // no-op listener: this panel is driven by the parent bundle, which the
  // Terminal refreshes via /api/analysis. Registered so a manual scan marks
  // this panel as scan-aware without breaking anything.
  useScanListener();
  const sr = (bundle as any)?.srEngine;
  if (!sr) return <EmptyState title="S&R intelligence unavailable" />;

  const sc = sr.scenario;
  const dq = sr.dataQuality;

  return (
    <div className="h-full overflow-auto space-y-2.5 fade-up">
      {/* movement state */}
      <Panel
        title={`Market structure · ${sr.symbol} · ${sr.timeframe}`}
        right={<Chip tone={MOVEMENT_TONE[sc.movement] ?? "mute"}>{sc.movement.replace(/_/g, " ").toLowerCase()}</Chip>}
      >
        <div className="text-[11.5px] text-ink leading-snug">{sc.movementReason}</div>
        {sc.tradingRange && (
          <div className="mt-1.5 text-[10px] text-ink3">
            Trading range: <span className="num text-ink2">{fmtPx(sc.tradingRange.bottom)} – {fmtPx(sc.tradingRange.top)}</span>
          </div>
        )}
        {sc.noReliableZone && (
          <div className="mt-1.5 rounded border border-warn/30 bg-warn/5 px-2 py-1 text-[10px] text-warn">
            No reliable zone identified for the current price area.
          </div>
        )}
      </Panel>

      {/* §5/§8 the four dynamic levels */}
      <Panel title="Dynamic levels — R1 / R2 / S1 / S2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          <ZoneCard p={sc.levels?.R1 ?? sc.primaryResistance} label="R1 · Resistance" />
          <ZoneCard p={sc.levels?.S1 ?? sc.primarySupport} label="S1 · Support" />
          <ZoneCard p={sc.levels?.R2 ?? sc.secondaryResistance} label="R2 · Resistance" />
          <ZoneCard p={sc.levels?.S2 ?? sc.secondarySupport} label="S2 · Support" />
        </div>
        {sc.levels?.interactionZone && (
          <div className="mt-2 rounded border border-warn/30 bg-warn/5 px-2 py-1.5 text-[10px] text-warn">
            Price is currently INSIDE the {sc.levels.interactionZone.type} zone ({fmtPx(sc.levels.interactionZone.bottom)}–{fmtPx(sc.levels.interactionZone.top)}).
          </div>
        )}
        {sc.levels?.notes?.map((n: string, i: number) => (
          <div key={i} className="mt-1 text-[10px] text-ink3">{n}</div>
        ))}
        <div className="mt-1.5 text-[9px] text-ink3 leading-snug">
          R1/R2/S1/S2 are dynamically ranked market-structure zones, not classic pivot-point formulas and not guaranteed turning points.
        </div>
      </Panel>

      {/* scenario */}
      <Panel title="Scenario — trigger, target, invalidation">
        <div className="space-y-1.5">
          {sc.continuationTrigger && (
            <div className="rounded border border-info/30 bg-info/5 px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-info">candidate trigger</div>
              <div className="num text-[12px] font-bold text-info">{fmtPx(sc.continuationTrigger.level)}</div>
              <div className="text-[9.5px] text-ink2 mt-0.5 leading-snug">{sc.continuationTrigger.description}</div>
            </div>
          )}
          {sc.nextTarget && (
            <div className="rounded border border-warn/30 bg-warn/5 px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-warn">potential target</div>
              <div className="num text-[12px] font-bold text-warn">{fmtPx(sc.nextTarget.level)}</div>
              <div className="text-[9.5px] text-ink2 mt-0.5 leading-snug">{sc.nextTarget.description}</div>
            </div>
          )}
          {sc.pullbackArea && (
            <div className="rounded border hairline bg-panel2 px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-ink3">pullback area</div>
              <div className="num text-[12px] font-bold">{fmtPx(sc.pullbackArea.level)}</div>
              <div className="text-[9.5px] text-ink2 mt-0.5 leading-snug">{sc.pullbackArea.description}</div>
            </div>
          )}
          {sc.invalidationLevel && (
            <div className="rounded border border-down/40 bg-down/5 px-2 py-1.5">
              <div className="text-[9px] uppercase tracking-wider text-down">scenario invalidation</div>
              <div className="num text-[12px] font-bold text-down">{fmtPx(sc.invalidationLevel.level)}</div>
              <div className="text-[9.5px] text-ink2 mt-0.5 leading-snug">{sc.invalidationLevel.description}</div>
            </div>
          )}
          {sc.pendingConfirmations.length > 0 && (
            <EvidenceList title="Confirmations still pending" items={sc.pendingConfirmations} tone="warn" />
          )}
          <EvidenceList title="Supporting evidence" items={sc.supportingEvidence} tone="up" />
          <EvidenceList title="Conflicting evidence & risks" items={sc.conflictingEvidence} tone="down" />
        </div>
      </Panel>

      {/* all zones */}
      <Panel
        title={`All zones (${sr.zones.length}) — sorted by relevance`}
        right={
          <button
            onClick={() => setShowAll((v) => !v)}
            className={`h-6 px-2 rounded border text-[9.5px] font-semibold ${showAll ? "border-info/45 text-info bg-info/10" : "hairline2 text-ink3"}`}
          >
            {showAll ? "Hide secondary" : "Show all levels"}
          </button>
        }
      >
        <div className="space-y-1">
          {(showAll ? sr.zones : sr.zones.filter((z: any) => z.distanceAtr <= 4)).slice(0, showAll ? 20 : 10).map((z: any) => (
            <div key={z.id} className="flex items-center gap-1.5 flex-wrap rounded border hairline bg-panel2 px-2 py-1">
              <Chip tone={SR_STATE_TONE[z.srState] ?? "mute"}>{z.srState.replace(/_/g, " ").toLowerCase()}</Chip>
              <span className="text-[10px] font-semibold">{z.type}</span>
              <span className="num text-[10px] text-ink2">{fmtPx(z.bottom)}–{fmtPx(z.top)}</span>
              <span className="num text-[9px] text-ink3">str {z.strength} · {z.distanceAtr.toFixed(2)}×ATR · {z.tests}t/{z.reactions}r</span>
              {z.roleFlipped && <Chip tone="cyan">flipped</Chip>}
              {z.isOiDerived && <Chip tone="violet">OI only</Chip>}
              {z.reactionDecay && <Chip tone="warn">decaying</Chip>}
              <Chip tone={MACHINE_TONE[z.machineState] ?? "mute"} className="!px-1 !text-[8px]">{z.machineState.replace(/_/g, " ").toLowerCase()}</Chip>
              <span className="text-[8.5px] text-ink3 ml-auto num">{z.candlesSinceReaction != null ? `${z.candlesSinceReaction} bars since reaction` : "untested"}</span>
            </div>
          ))}
        </div>
      </Panel>

      {/* data quality */}
      <Panel title="Data quality">
        <div className="flex flex-wrap gap-1.5">
          <Chip tone={dq.zones === "VALID" ? "up" : "mute"}>zones {dq.zones}</Chip>
          <Chip tone={dq.profile === "VALID" ? "up" : dq.profile === "ESTIMATED" ? "warn" : "mute"}>profile {dq.profile}</Chip>
          <Chip tone={dq.futures === "VALID" ? "up" : "mute"}>futures {dq.futures}</Chip>
          <Chip tone={dq.optionOi === "VALID" ? "up" : dq.optionOi === "PARTIAL" ? "warn" : "mute"}>option OI {dq.optionOi}</Chip>
        </div>
        <div className="mt-1.5 text-[9px] text-ink3 leading-snug">{dq.note}</div>
        <div className="mt-1 text-[8.5px] text-ink3 num">calculated {fmtTime(sr.generatedAt)} · ATR {sr.atr?.toFixed(2)}</div>
      </Panel>
    </div>
  );
}
