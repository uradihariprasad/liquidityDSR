"use client";

import { Panel, Chip, Row, EvidenceList, EmptyState, FeedGate } from "@/components/ui";
import { fmtPx, fmtBig, fmtTime, timeAgo, changeColor } from "@/lib/client/api";
import type { PanelProps } from "./common";

const VERDICT_TONE: Record<string, any> = {
  BULLISH_EVIDENCE: "up",
  BEARISH_EVIDENCE: "down",
  ABSORPTION_CANDIDATE: "violet",
  LIQUIDITY_SWEEP_CANDIDATE: "warn",
  CONFLICTING_EVIDENCE: "info",
  INSUFFICIENT_DATA: "mute",
};

const STAGE_TONE: Record<string, any> = {
  UNTOUCHED: "mute",
  TOUCHED: "mute",
  PENETRATED: "info",
  SWEEP_CANDIDATE: "warn",
  RECLAIM_CONFIRMED: "cyan",
  FOLLOW_THROUGH_CONFIRMED: "up",
  INVALIDATED: "down",
};

const DATA_CLASS_TONE: Record<string, any> = {
  DISPLAYED_DEPTH: "cyan",
  EXECUTED_FLOW: "violet",
  PRICE_STRUCTURE: "info",
  VOLUME_PROFILE: "warn",
};

function DepthLadder({ d }: { d: any }) {
  if (!d?.bids?.length && !d?.asks?.length) return null;
  const max = Math.max(...(d.bids ?? []).map((l: any) => l.quantity), ...(d.asks ?? []).map((l: any) => l.quantity), 1);
  return (
    <div className="space-y-1">
      {(d.bids ?? []).slice(0, 5).map((l: any, i: number) => (
        <div key={`b${i}`} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="flex justify-end">
            <div className="h-[15px] rounded-l-sm bg-up/25 border-l-2 border-up" style={{ width: `${(l.quantity / max) * 100}%`, minWidth: 3 }} title={`${fmtBig(l.quantity)} @ ${fmtPx(l.price)}`} />
          </div>
          <div className="num text-[10px] text-ink2 w-[72px] text-center">{fmtPx(l.price)}</div>
          <div />
        </div>
      ))}
      {(d.asks ?? []).slice(0, 5).map((l: any, i: number) => (
        <div key={`a${i}`} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div />
          <div className="num text-[10px] text-ink2 w-[72px] text-center">{fmtPx(l.price)}</div>
          <div>
            <div className="h-[15px] rounded-r-sm bg-down/25 border-r-2 border-down" style={{ width: `${(l.quantity / max) * 100}%`, minWidth: 3 }} title={`${fmtBig(l.quantity)} @ ${fmtPx(l.price)}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function IntelligencePanel({ bundle }: PanelProps) {
  const bs = (bundle as any)?.buyerSeller;
  if (!bs) {
    return (
      <div className="h-full flex items-center justify-center">
        <EmptyState title="Intelligence unavailable" detail="No analysis bundle for this instrument." />
      </div>
    );
  }

  const d = bs.depth;
  const caps = bs.capabilities;
  const contract = bs.contract;

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up overflow-auto">
      {/* verdict + signals */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Buyer / seller intelligence"
          className="shrink-0"
          right={<Chip tone={VERDICT_TONE[bs.verdict] ?? "mute"}>{bs.verdict.replace(/_/g, " ")}</Chip>}
        >
          <div className={`rounded-md border px-2.5 py-2 ${bs.verdict === "BULLISH_EVIDENCE" ? "border-updim bg-up/5" : bs.verdict === "BEARISH_EVIDENCE" ? "border-downdim bg-down/5" : "hairline bg-panel2"}`}>
            <div className="text-[11.5px] font-semibold leading-snug">{bs.verdictReason}</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[9.5px]">
              <Chip tone="up">{bs.bullishCount} bullish</Chip>
              <Chip tone="down">{bs.bearishCount} bearish</Chip>
              {bs.signals.filter((s: any) => !s.available).length > 0 && (
                <Chip tone="warn">{bs.signals.filter((s: any) => !s.available).length} unavailable</Chip>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-1">
            {bs.signals.map((s: any) => (
              <div key={s.key} className={`rounded border px-2 py-1.5 ${s.available ? "hairline bg-panel2" : "border-warn/25 bg-warn/5"}`}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={DATA_CLASS_TONE[s.dataClass] ?? "mute"} className="shrink-0">{s.dataClass.replace(/_/g, " ")}</Chip>
                  <span className="text-[10.5px] font-semibold">{s.label}</span>
                  {!s.available && <Chip tone="mute" className="ml-auto">unavailable</Chip>}
                  {s.available && s.leans && <Chip tone={s.leans === "BULLISH" ? "up" : "down"} className="ml-auto">{s.leans}</Chip>}
                  {s.available && !s.leans && <Chip tone="mute" className="ml-auto">non-directional</Chip>}
                </div>
                <div className="text-[9.5px] text-ink2 mt-1 leading-snug">{s.detail}</div>
                {s.unavailableReason && <div className="text-[9px] text-warn/80 mt-0.5 leading-snug">{s.unavailableReason}</div>}
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {/* depth + contract */}
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Displayed order-book depth"
          className="shrink-0"
          right={<Chip tone={bs.channels.depth.available ? (bs.channels.depth.state === "STALE" ? "warn" : "up") : "mute"}>{bs.channels.depth.state}</Chip>}
        >
          {!bs.channels.depth.available ? (
            <div className="space-y-2">
              <EmptyState title="Depth unavailable" detail={bs.channels.depth.reason || d?.capabilityNote} />
              <FeedGate quality={bundle?.quality} what="Displayed depth" />
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8px] text-ink3 uppercase">best bid</div>
                  <div className="num text-[12px] font-bold text-up">{fmtPx(d.bestBid)}</div>
                  <div className="num text-[8.5px] text-ink3">{fmtBig(d.totalBidQty)}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8px] text-ink3 uppercase">best ask</div>
                  <div className="num text-[12px] font-bold text-down">{fmtPx(d.bestAsk)}</div>
                  <div className="num text-[8.5px] text-ink3">{fmtBig(d.totalAskQty)}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8px] text-ink3 uppercase">spread</div>
                  <div className="num text-[12px] font-bold">{fmtPx(d.spread)}</div>
                  <div className="num text-[8.5px] text-ink3">{d.spreadBps?.toFixed(1)} bps</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8px] text-ink3 uppercase">OBI</div>
                  <div className={`num text-[12px] font-bold ${d.obi != null && d.obi > 0.15 ? "text-up" : d.obi != null && d.obi < -0.15 ? "text-down" : ""}`}>
                    {d.obi != null ? `${(d.obi * 100).toFixed(1)}%` : "—"}
                  </div>
                  <div className="num text-[8.5px] text-ink3">{d.obiLevelsUsed} levels</div>
                </div>
              </div>
              <DepthLadder d={d} />
              <Row k="Depth timestamp" v={fmtTime(d.eventTs)} />
              <Row k="Age" v={d.ageMs != null ? `${(d.ageMs / 1000).toFixed(1)}s` : "—"} tone={d.stale ? "text-warn" : undefined} />
              {d.concentrations?.length > 0 && (
                <div>
                  <div className="panel-label mb-1">Displayed concentrations (candidates)</div>
                  {d.concentrations.slice(0, 4).map((c: any, i: number) => (
                    <div key={i} className="text-[9.5px] text-ink2">
                      <Chip tone={c.side === "bid" ? "up" : "down"}>{c.side}</Chip> {fmtBig(c.quantity)} @ {fmtPx(c.price)} ({c.ratioToMean.toFixed(1)}× mean)
                    </div>
                  ))}
                </div>
              )}
              {d.changes?.length > 0 && (
                <div>
                  <div className="panel-label mb-1">Displayed changes</div>
                  {d.changes.slice(0, 4).map((c: any, i: number) => (
                    <div key={i} className="text-[9px] text-ink3">
                      <Chip tone={c.classification === "INCREASED" || c.classification === "APPEARED" ? "up" : "warn"}>{c.classification}</Chip>{" "}
                      {c.side} {fmtPx(c.price)}: {fmtBig(c.previousQty)} → {fmtBig(c.currentQty)}
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[8.5px] text-warn/80 leading-snug">{d.capabilityNote}</div>
            </div>
          )}
        </Panel>

        <Panel title="Contract mapping (Module H)" className="shrink-0">
          <Row k="Underlying" v={`${contract.underlyingLabel}`} />
          <Row k="Underlying key" v={contract.underlyingKey} />
          <Row k="Underlying price" v={fmtPx(contract.underlyingPrice)} />
          <Row k="Analysis contract" v={contract.analysisContractLabel ?? "—"} tone="text-info" />
          <Row k="Contract key" v={contract.analysisContractKey ?? "—"} />
          <Row k="Contract price" v={fmtPx(contract.analysisContractPrice)} />
          <Row k="Expiry" v={contract.expiry ?? "—"} />
          <div className="text-[9px] text-ink3 mt-1 leading-snug">{contract.rolloverNote}</div>
          {contract.underlyingKey !== contract.analysisContractKey && (
            <div className="mt-1 text-[9px] text-info/80 leading-snug">
              Index spot has no executable order book — depth above comes from the mapped futures contract, not the index.
            </div>
          )}
        </Panel>
      </div>

      {/* flow + absorption + sweeps + capabilities */}
      <div className="col-span-12 xl:col-span-3 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Executed trade flow"
          className="shrink-0"
          right={<Chip tone={bs.channels.executedFlow.available ? "up" : "mute"}>{bs.channels.executedFlow.state}</Chip>}
        >
          {!bs.channels.executedFlow.available ? (
            <div className="rounded border border-warn/25 bg-warn/5 px-2 py-1.5 text-[9.5px] text-ink2 leading-snug">
              <div className="font-semibold text-warn mb-0.5">UNSUPPORTED on this feed</div>
              {bs.channels.executedFlow.reason}
            </div>
          ) : (
            <div className="space-y-1">
              <Row k="Aggressive buy" v={fmtBig(bs.flow.aggressiveBuyVolume)} tone="text-up" />
              <Row k="Aggressive sell" v={fmtBig(bs.flow.aggressiveSellVolume)} tone="text-down" />
              <Row k="Delta" v={fmtBig(bs.flow.delta)} />
              <Row k="Cumulative delta" v={fmtBig(bs.flow.cumulativeDelta)} />
            </div>
          )}
        </Panel>

        <Panel title="Absorption candidates" className="shrink-0">
          {[bs.absorption.buyer, bs.absorption.seller].map((a: any) => (
            <div key={a.side} className={`rounded border px-2 py-1.5 mb-1.5 ${a.detected ? "border-violet/40 bg-violet/5" : "hairline bg-panel2"}`}>
              <div className="flex items-center gap-1.5">
                <Chip tone={a.detected ? "violet" : "mute"}>{a.side.toLowerCase()}</Chip>
                {a.detected && <Chip tone="mute">{a.grade}</Chip>}
                <span className="text-[9px] text-ink3 ml-auto num">{a.presentCount}/{a.requiredCount} evidence</span>
              </div>
              <div className="text-[9px] text-ink2 mt-1 leading-snug">{a.note}</div>
              {a.detected && a.zoneRange && (
                <div className="text-[9px] text-ink3 mt-0.5 num">
                  zone {a.zoneType} {fmtPx(a.zoneRange[0])}–{fmtPx(a.zoneRange[1])}
                </div>
              )}
              {a.evidence?.map((e: any, i: number) => (
                <div key={i} className={`text-[8.5px] mt-0.5 leading-snug ${e.present ? "text-up/80" : e.unavailable ? "text-warn/70" : "text-ink3"}`}>
                  {e.present ? "✓" : e.unavailable ? "∅" : "✗"} {e.label}
                </div>
              ))}
            </div>
          ))}
        </Panel>

        <Panel title="Sweep / reclaim stages" className="flex-1 min-h-[180px]">
          <div className="space-y-1">
            {(bs.sweeps ?? []).slice().reverse().slice(0, 5).map((s: any) => (
              <div key={s.id} className="rounded border hairline bg-panel2 px-2 py-1.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Chip tone={STAGE_TONE[s.stage] ?? "mute"}>{s.stage.replace(/_/g, " ")}</Chip>
                  <Chip tone={s.direction === "BULLISH" ? "up" : "down"}>{s.direction}</Chip>
                  <span className="text-[9.5px] font-semibold num">{s.side}</span>
                  <span className="num text-[9.5px] text-ink2">@ {fmtPx(s.level)}</span>
                  <span className="text-[8.5px] text-ink3 ml-auto num">{fmtTime(s.ts)}</span>
                </div>
                <div className="text-[9px] text-ink2 mt-1 leading-snug">{s.stageReason}</div>
                {s.penetrationAtr != null && (
                  <div className="text-[8.5px] text-ink3 mt-0.5 num">pen {s.penetrationAtr.toFixed(2)}×ATR{typeof s.wickRatio === "number" ? ` · wick ${(s.wickRatio * 100).toFixed(0)}%` : ""}</div>
                )}
              </div>
            ))}
            {!(bs.sweeps ?? []).length && <EmptyState title="No sweep candidates" detail="No candle has met the penetration + reclaim criteria in the visible window." />}
          </div>
        </Panel>

        <Panel title="Data capability registry" className="shrink-0">
          <div className="flex gap-1.5 mb-1.5">
            <Chip tone="up">{caps.summary.supported} supported</Chip>
            <Chip tone="down">{caps.summary.unsupported} unsupported</Chip>
            <Chip tone="warn">{caps.summary.notVerified} not verified</Chip>
          </div>
          <div className="space-y-0.5">
            {caps.entries.map((e: any) => (
              <div key={e.capability} className="flex items-start gap-1.5">
                <Chip tone={e.state === "SUPPORTED" ? "up" : e.state === "UNSUPPORTED" ? "down" : "warn"} className="shrink-0 !px-1 !text-[8px]">
                  {e.state === "SUPPORTED" ? "SUP" : e.state === "UNSUPPORTED" ? "UNS" : "NV"}
                </Chip>
                <div className="min-w-0">
                  <div className="text-[9px] font-semibold leading-tight">{e.capability}</div>
                  <div className="text-[8.5px] text-ink3 leading-snug">{e.notes}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
