"use client";

import { Panel, Chip, Gauge, Spark, EvidenceList, Row, EmptyState } from "@/components/ui";
import type { PanelProps } from "./common";

export default function FmpiPanel({ bundle }: PanelProps) {
  const f = bundle?.fmpi;
  if (!f) return <EmptyState title="Loading FMPI…" />;
  const comps = f.components ?? [];
  const hist = (f.history ?? []).map((h: any) => h.score);

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      {/* headline */}
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel title={`FMPI · ${bundle?.symbol} · ${bundle?.tf}`} right={<Chip tone={f.direction === "BULLISH" ? "up" : f.direction === "BEARISH" ? "down" : "mute"}>{f.direction}</Chip>}>
          <div className="flex items-center gap-4">
            <Gauge score={f.score} direction={f.direction} size={150} />
            <div className="space-y-1.5 flex-1">
              <div className="flex justify-between text-[11px]"><span className="text-ink3">classification</span><Chip tone="info">{f.classification?.replace(/_/g, " ")}</Chip></div>
              <div className="flex justify-between text-[11px]"><span className="text-ink3">state</span><Chip tone={f.state === "STRENGTHENING" ? "up" : f.state === "WEAKENING" ? "down" : f.state === "CONFLICTING" ? "warn" : "mute"}>{f.state}</Chip></div>
              <div className="flex justify-between text-[11px]"><span className="text-ink3">acceleration</span><span className="num text-ink2">{f.acceleration}</span></div>
              <div className="flex justify-between text-[11px]"><span className="text-ink3">data quality</span><span className="num text-ink2">{f.dataQuality} ×{f.dataQualityMultiplier}</span></div>
            </div>
          </div>
          <div className="mt-3">
            <div className="panel-label mb-1">score history (reproducible from completed candles)</div>
            <Spark data={hist} width={300} height={44} tone={f.direction === "BEARISH" ? "#ea3943" : "#17c784"} />
          </div>
          <div className="mt-3 rounded-md border hairline bg-panel2 px-2.5 py-2 text-[10px] text-ink3 leading-relaxed">
            FMPI is a weighted momentum composite on a 0–100 scale — <b className="text-ink2">it is not a probability of winning</b>. Unavailable channels (order flow always; futures when no contract maps) are excluded with their weight redistributed and disclosed, never treated as neutral evidence.
          </div>
        </Panel>
        <Panel title="Confirmation matrix" className="shrink-0">
          <Row k="Relative-volume confirmation" v={f.relVolumeConfirm ? "YES (≥1.3×)" : "no"} tone={f.relVolumeConfirm ? "text-up" : "text-ink3"} />
          <Row k="Structure confirmation" v={f.structureConfirm ? "YES" : "no"} tone={f.structureConfirm ? "text-up" : "text-ink3"} />
          <Row k="Order-flow confirmation" v={f.orderFlowStatus} tone={f.orderFlowStatus === "CONFIRMING" ? "text-up" : "text-warn"} />
          <Row k="Futures confirmation" v={f.futuresStatus} tone={f.futuresStatus === "CONFIRMING" ? "text-up" : "text-warn"} />
          <Row k="Liquidity context" v={f.liquidityContext} />
        </Panel>
      </div>

      {/* components */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel title="Component breakdown (documented weights)" className="flex-1">
          <div className="space-y-2">
            {comps.map((c: any) => (
              <div key={c.key} className="border-b hairline/50 pb-2 last:border-b-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold flex-1">{c.label}</span>
                  <span className="num text-[9.5px] text-ink3">w {(c.weight * 100).toFixed(0)}%</span>
                  {c.available ? (
                    <>
                      <span className="num text-[11px] font-bold w-[38px] text-right">{(c.value! * 100).toFixed(0)}</span>
                      <span className={`num text-[10px] w-[46px] text-right ${c.signed > 0.05 ? "text-up" : c.signed < -0.05 ? "text-down" : "text-ink3"}`}>
                        {c.signed > 0 ? "+" : ""}{c.signed.toFixed(2)}
                      </span>
                      <Chip tone="mute">{c.contribution?.toFixed(1)} pts</Chip>
                    </>
                  ) : (
                    <Chip tone="warn">unavailable</Chip>
                  )}
                </div>
                <div className="mt-1 h-[5px] rounded bg-panel3 overflow-hidden">
                  <div
                    className={`h-full rounded ${c.available ? (c.signed >= 0 ? "bg-up" : "bg-down") : "bg-line2"}`}
                    style={{ width: c.available && c.value != null ? `${c.value * 100}%` : "100%", opacity: c.available ? 0.85 : 0.35 }}
                  />
                </div>
                <div className="text-[9.5px] text-ink3 mt-1 leading-snug">{c.detail}</div>
              </div>
            ))}
          </div>
          {(f.penalties?.length ?? 0) > 0 && (
            <div className="mt-3">
              <div className="panel-label mb-1.5">Penalties applied (cap −0.15)</div>
              {f.penalties.map((p: any, i: number) => (
                <div key={i} className="flex justify-between text-[10.5px] py-0.5">
                  <span className="text-ink2">{p.reason}</span>
                  <span className="num text-down">−{p.amount.toFixed(2)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* reasons */}
      <div className="col-span-12 xl:col-span-3 flex flex-col gap-2.5">
        <Panel title="Reasoning" className="flex-1">
          <div className="space-y-3">
            <EvidenceList title="Supporting the score" items={f.supporting ?? []} tone="up" />
            <EvidenceList title="Reducing confidence" items={f.reducing ?? []} tone="down" />
            <EvidenceList title="Invalidation conditions" items={f.invalidation ?? []} tone="warn" />
          </div>
        </Panel>
        <Panel title="Thresholds (configurable, documented)" className="shrink-0">
          {[["0–20", "VERY WEAK"], ["20–35", "WEAK"], ["35–50", "NEUTRAL"], ["50–65", "DEVELOPING"], ["65–80", "STRONG"], ["80+", "VERY STRONG"]].map(([r, l]) => (
            <div key={r} className={`flex justify-between text-[10.5px] py-[3px] px-1.5 rounded ${f.classification?.replace(/_/g, " ") === l ? "bg-info/10 text-info" : "text-ink3"}`}>
              <span className="num">{r}</span><span>{l}</span>
            </div>
          ))}
          <div className="text-[9px] text-ink3 mt-2 leading-snug">No win-rate claim is attached to any band; thresholds are tuning inputs validated per-instrument in the Replay module.</div>
        </Panel>
      </div>
    </div>
  );
}
