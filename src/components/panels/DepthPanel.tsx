"use client";

import { Panel, Chip, EmptyState, Row, EvidenceList, FeedGate } from "@/components/ui";
import { fmtPx, fmtBig, fmtTime } from "@/lib/client/api";
import type { PanelProps } from "./common";
import { BookOpen, Layers3, Ban } from "lucide-react";

function DepthLadder({ depth }: { depth: any }) {
  if (!depth?.available) return null;
  const maxQty = Math.max(...depth.levels.flatMap((l: any) => [l.bidQty, l.askQty]), 1);
  return (
    <div className="space-y-1">
      {depth.levels.map((l: any, i: number) => (
        <div key={i} className="grid grid-cols-[1fr_70px_1fr] items-center gap-2">
          <div className="flex justify-end">
            <div className="h-[16px] rounded-l-sm bg-up/25 border-l-2 border-up" style={{ width: `${(l.bidQty / maxQty) * 100}%`, minWidth: 3 }} title={`${fmtBig(l.bidQty)} @ ${fmtPx(l.price)}`} />
          </div>
          <div className="num text-[10.5px] text-center text-ink2">{fmtPx(l.price)}</div>
          <div>
            <div className="h-[16px] rounded-r-sm bg-down/25 border-r-2 border-down" style={{ width: `${(l.askQty / maxQty) * 100}%`, minWidth: 3 }} title={`${fmtBig(l.askQty)} @ ${fmtPx(l.price)}`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function DepthPanel({ bundle }: PanelProps) {
  const b = bundle;
  const d = b?.depth;
  const fp = b?.footprint;
  const obi = d?.obi;

  // candle-direction volume split — a labelled proxy, not aggressor flow
  const candleFlow = (() => {
    const cs = (b?.candles ?? []).filter((c: any) => !c.live);
    if (!cs.length) return null;
    let upVol = 0;
    let downVol = 0;
    for (const c of cs) {
      if (c.close >= c.open) upVol += c.volume;
      else downVol += c.volume;
    }
    const total = upVol + downVol;
    if (total <= 0) return null;
    return { upVol, downVol, upPct: (upVol / total) * 100, skew: (upVol - downVol) / total };
  })();
  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      {/* depth */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5">
        <Panel
          title="Live market depth"
          className="flex-1"
          right={d?.available ? <Chip tone="up">observed</Chip> : <Chip tone="warn">unavailable</Chip>}
        >
          {!d?.available ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
                <Ban size={16} className="text-warn shrink-0 mt-0.5" />
                <div>
                  <div className="text-[12px] font-semibold text-warn">Order book not being received</div>
                  <div className="text-[10.5px] text-ink2 mt-1 leading-relaxed">{d?.reason}</div>
                  {b?.instrumentKeys && (
                    <div className="text-[9.5px] text-ink3 mt-1.5 num">
                      depth source: {b.kind === "index" ? (b.instrumentKeys.futures ?? "no futures mapped") : b.instrumentKeys.spot || "—"}
                    </div>
                  )}
                </div>
              </div>
              <FeedGate quality={b?.quality} what="Live depth" />
              <div className="rounded-md border hairline bg-panel2 px-3 py-2.5">
                <div className="panel-label mb-1.5">Honesty rules enforced here</div>
                <ul className="space-y-1 text-[10.5px] text-ink2 leading-relaxed">
                  <li>· The platform <b>never fabricates order books</b>. This panel activates only with observed Upstox depth.</li>
                  <li>· An index (NIFTY/SENSEX) has no executable order book — depth applies to its futures contract, clearly labelled.</li>
                  <li>· Displayed liquidity ≠ executed order flow. Disappeared displayed quantity may be cancelled — never reported as executed.</li>
                </ul>
              </div>
              <div className="rounded-md border hairline bg-panel2 px-3 py-2.5">
                <div className="panel-label mb-1.5">OBI — documented formula (active in live mode)</div>
                <div className="num text-[12px] text-info">OBI = (BidQty − AskQty) / (BidQty + AskQty)</div>
                <div className="text-[10.5px] text-ink3 mt-1 leading-relaxed">Computed over displayed levels with zero/missing-quantity guards, configurable depth window. Positive OBI does not guarantee upside movement.</div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="rounded border hairline bg-panel2 px-2 py-1.5"><div className="text-[8.5px] text-ink3 uppercase">best bid</div><div className="num text-[13px] font-bold text-up">{fmtPx(d.bestBid)}</div></div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5"><div className="text-[8.5px] text-ink3 uppercase">best ask</div><div className="num text-[13px] font-bold text-down">{fmtPx(d.bestAsk)}</div></div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5"><div className="text-[8.5px] text-ink3 uppercase">spread</div><div className="num text-[13px] font-bold">{fmtPx(d.spread)}</div><div className="text-[8.5px] text-ink3">{d.spreadBps?.toFixed(1)} bps</div></div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5"><div className="text-[8.5px] text-ink3 uppercase">OBI</div><div className={`num text-[13px] font-bold ${(obi ?? 0) > 0.1 ? "text-up" : (obi ?? 0) < -0.1 ? "text-down" : ""}`}>{obi?.toFixed(3) ?? "—"}</div><div className="text-[8.5px] text-ink3">{d.obiWindow}</div></div>
              </div>
              <DepthLadder depth={d} />
              <Row k="Total displayed bid qty" v={fmtBig(d.totalBidQty)} tone="text-up" />
              <Row k="Total displayed ask qty" v={fmtBig(d.totalAskQty)} tone="text-down" />
              <Row k="Depth timestamp" v={fmtTime(d.ts)} />
              {d.walls?.length > 0 && (
                <div>
                  <div className="panel-label mt-2 mb-1">Unusual displayed quantities (observed)</div>
                  {d.walls.map((w: any, i: number) => (
                    <div key={i} className="text-[10.5px] text-ink2 py-0.5">
                      <Chip tone={w.side === "bid" ? "up" : "down"}>{w.side}</Chip> <span className="num">{fmtBig(w.qty)}</span> @ <span className="num">{fmtPx(w.price)}</span> — {w.note}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Panel>
        <Panel title="Displayed vs executed — capability note" className="shrink-0">
          <div className="text-[10.5px] text-ink2 leading-relaxed">{d?.capabilityNote}</div>
        </Panel>
      </div>

      {/* order flow */}
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel title="Order-flow analysis" className="flex-1" right={<Chip tone={b?.fmpi?.orderFlowStatus === "CONFIRMING" ? "up" : "warn"}>{b?.fmpi?.orderFlowStatus ?? "UNAVAILABLE"}</Chip>}>
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-md border hairline bg-panel2 px-3 py-2.5">
              <BookOpen size={15} className="text-info shrink-0 mt-0.5" />
              <div className="text-[10.5px] text-ink2 leading-relaxed">
                Executed order flow (aggressive buying/selling, true volume delta, cumulative delta) requires <b>trade-level data with aggressor-side classification</b>. The current feed ({b?.quality?.mode === "LIVE_UPSTOX" ? "Upstox quote API" : "not connected"}) does not provide per-trade aggressor attribution, so the platform does not invent aggressive buy/sell volumes.
              </div>
            </div>
            {/* real, candle-derived participation metrics (clearly labelled proxies) */}
            {candleFlow ? (
              <div>
                <div className="panel-label mb-1.5">Candle-direction volume split (proxy — computed from live OHLCV)</div>
                <div className="flex h-5 rounded overflow-hidden border hairline mb-1.5">
                  <div className="bg-up/60 flex items-center justify-center text-[9px] font-bold text-black" style={{ width: `${candleFlow.upPct}%` }}>{candleFlow.upPct.toFixed(0)}%</div>
                  <div className="bg-down/60 flex items-center justify-center text-[9px] font-bold text-black" style={{ width: `${100 - candleFlow.upPct}%` }}>{(100 - candleFlow.upPct).toFixed(0)}%</div>
                </div>
                <Row k="Up-candle volume" v={fmtBig(candleFlow.upVol)} tone="text-up" />
                <Row k="Down-candle volume" v={fmtBig(candleFlow.downVol)} tone="text-down" />
                <Row k="Net volume skew (proxy)" v={`${candleFlow.skew > 0 ? "+" : ""}${(candleFlow.skew * 100).toFixed(1)}%`} tone={candleFlow.skew > 0 ? "text-up" : "text-down"} />
                <Row k="Relative volume" v={b?.last?.relVol ? `${b.last.relVol.toFixed(2)}×` : "—"} />
                <Row k="Session volume" v={fmtBig(b?.last?.volume)} />
                <div className="text-[9px] text-warn/80 mt-1 leading-snug">
                  This is a candle-direction split, NOT executed aggressor flow: volume is attributed by whether each candle closed up or down. It cannot distinguish buyer-initiated from seller-initiated trades.
                </div>
              </div>
            ) : (
              <FeedGate quality={b?.quality} what="Participation metrics" />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[
                ["Volume delta (true)", "UNAVAILABLE", "warn"],
                ["Cumulative delta", "UNAVAILABLE", "warn"],
                ["Price-level imbalance", "UNAVAILABLE", "warn"],
                ["Stacked imbalance", "UNAVAILABLE", "warn"],
              ].map(([k, v, tone]: any) => (
                <div key={k} className="rounded border hairline bg-panel2 px-2.5 py-2">
                  <div className="text-[8.5px] uppercase tracking-wider text-ink3">{k}</div>
                  <Chip tone={tone} className="mt-1">{v}</Chip>
                </div>
              ))}
            </div>
            <EvidenceList
              title="What the engine CAN say today"
              items={[
                "Momentum + participation evidence is derived from real OHLCV candle volume (executed volume aggregates).",
                `FMPI treats order-flow as an unavailable channel: its 8% weight is redistributed and disclosed, never assumed neutral.`,
                "Absorption/exhaustion classifications remain rule-based on price response + volume, and are labelled POTENTIAL until structure confirms.",
              ]}
              tone="info"
            />
          </div>
        </Panel>
      </div>

      {/* footprint */}
      <div className="col-span-12 xl:col-span-3 flex flex-col gap-2.5">
        <Panel title="Footprint — capability check" className="flex-1" right={<Chip tone={fp?.trueFootprintAvailable ? "up" : "warn"}>{fp?.trueFootprintAvailable ? "true" : "approx. only"}</Chip>}>
          <div className="space-y-2.5">
            <div className="flex items-start gap-2.5 text-[10.5px] text-ink2 leading-relaxed">
              <Layers3 size={14} className="text-violet shrink-0 mt-0.5" />
              <span>{fp?.requirement}</span>
            </div>
            {fp?.approximationAvailable && (
              <div>
                <div className="panel-label mb-1.5">Candle-based volume-at-price (labelled approximation)</div>
                <div className="space-y-[3px]">
                  {fp.volumeAtPrice.map((r: any, i: number) => {
                    const max = fp.volumeAtPrice[0]?.volume || 1;
                    return (
                      <div key={i} className="flex items-center gap-1.5">
                        <span className="num text-[9px] w-[60px] text-right text-ink3 shrink-0">{fmtPx(r.price, 1)}</span>
                        <div className="flex-1 h-[10px] rounded-sm bg-panel3 overflow-hidden">
                          <div className="h-full bg-violet/70 rounded-sm" style={{ width: `${(r.volume / max) * 100}%` }} />
                        </div>
                        <span className="num text-[8.5px] text-ink3 w-[40px]">{fmtBig(r.volume)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-2 text-[9.5px] text-warn/80 leading-snug rounded border border-warn/25 bg-warn/5 px-2 py-1.5">{fp.approximationNote}</div>
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
