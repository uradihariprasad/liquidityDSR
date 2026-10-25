"use client";

import { Panel, Chip, EmptyState, Row, EvidenceList, FeedGate } from "@/components/ui";
import Diagnostics from "@/components/Diagnostics";
import { fmtPx, fmtBig, fmtPct, fmtTime, changeColor } from "@/lib/client/api";
import type { PanelProps } from "./common";
import { Ban } from "lucide-react";

const STRIKE_TONE: Record<string, string> = {
  STRONG_SUPPORT: "up", SUPPORT_STRENGTHENING: "up", WEAK_SUPPORT: "mute", SUPPORT_WEAKENING: "warn", SUPPORT_BREAKDOWN_RISK: "down",
  STRONG_RESISTANCE: "down", RESISTANCE_STRENGTHENING: "down", WEAK_RESISTANCE: "mute", RESISTANCE_WEAKENING: "warn", RESISTANCE_BREAKOUT_RISK: "up",
};

const OI_TONE: Record<string, any> = { LONG_BUILDUP: "up", SHORT_COVERING: "up", SHORT_BUILDUP: "down", LONG_UNWINDING: "down" };

export default function DerivativesPanel({ bundle }: PanelProps) {
  const fut = bundle?.futures;
  const opt = bundle?.optionLevels;

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up overflow-auto">
      {/* futures */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5">
        <Panel
          title={`Futures & OI — ${bundle?.symbol ?? ""}`}
          className="flex-1"
          right={<Chip tone={fut?.available ? (fut.quality === "OK" ? "up" : "warn") : "warn"}>{fut?.available ? fut.quality : "unavailable"}</Chip>}
        >
          {!fut?.available ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
                <Ban size={15} className="text-warn shrink-0 mt-0.5" />
                <div>
                  <div className="text-[12px] font-semibold text-warn">Futures data unavailable</div>
                  <div className="text-[10.5px] text-ink2 mt-1 leading-relaxed">{fut?.reason}</div>
                  <div className="text-[9.5px] text-ink3 mt-1.5 num">
                    mapped contract: {fut?.futuresSymbol ?? fut?.futuresKey ?? "none discovered"}{fut?.expiry ? ` · expiry ${fut.expiry}` : ""}
                  </div>
                </div>
              </div>
              <FeedGate quality={bundle?.quality} what="Futures channel" />
              {bundle && <Diagnostics bundle={bundle} />}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="violet">{fut.futuresSymbol ?? fut.futuresKey}</Chip>
                <Chip tone="mute">expiry {fut.expiry}</Chip>
                {fut.daysToExpiry != null && <Chip tone={fut.daysToExpiry <= 3 ? "warn" : "mute"}>{fut.daysToExpiry}d to expiry</Chip>}
                {fut.lotSize ? <Chip tone="mute">lot {fut.lotSize}</Chip> : null}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">futures price</div>
                  <div className={`num text-[15px] font-bold ${changeColor(fut.changePct)}`}>{fmtPx(fut.price)}</div>
                  <div className={`num text-[9.5px] ${changeColor(fut.changePct)}`}>{fut.change != null ? `${fut.change > 0 ? "+" : ""}${fmtPx(fut.change)}` : "—"} {fut.changePct != null ? `(${fmtPct(fut.changePct)})` : ""}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">underlying</div>
                  <div className="num text-[15px] font-bold">{fmtPx(fut.underlyingPrice)}</div>
                  <div className="text-[8.5px] text-ink3">{bundle?.kind === "index" ? "index spot" : "cash market"}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">basis</div>
                  <div className={`num text-[15px] font-bold ${changeColor(fut.basis)}`}>{fut.basis != null ? fmtPx(fut.basis) : "—"}</div>
                  <div className="text-[8.5px] text-ink3">{fut.basisPct != null ? fmtPct(fut.basisPct) : "futures − underlying"}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">open interest</div>
                  <div className="num text-[13px] font-bold">{fut.oi != null ? fmtBig(fut.oi) : <span className="text-warn text-[11px]">Unavailable</span>}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">change in OI</div>
                  <div className={`num text-[13px] font-bold ${changeColor(fut.deltaOI)}`}>{fut.deltaOI != null ? `${fut.deltaOI > 0 ? "+" : ""}${fmtBig(fut.deltaOI)}` : <span className="text-warn text-[11px]">Unavailable</span>}</div>
                  <div className="text-[8.5px] text-ink3">{fut.deltaOIPct != null ? fmtPct(fut.deltaOIPct) : ""}</div>
                </div>
                <div className="rounded border hairline bg-panel2 px-2 py-1.5">
                  <div className="text-[8.5px] text-ink3 uppercase">futures volume</div>
                  <div className="num text-[13px] font-bold">{fut.volume != null ? fmtBig(fut.volume) : <span className="text-warn text-[11px]">Unavailable</span>}</div>
                </div>
              </div>

              {fut.priceOI && (
                <div className="rounded border hairline bg-panel2 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <Chip tone={OI_TONE[fut.priceOI.label] ?? "info"}>{fut.priceOI.label.replace(/_/g, " ")}</Chip>
                    <span className="text-[9.5px] text-ink3">provisional context</span>
                  </div>
                  <div className="text-[9.5px] text-warn/80 mt-1 leading-snug">{fut.priceOI.caveat}</div>
                </div>
              )}

              <Row k="OI source" v={fut.oiSource ?? "—"} />
              <Row k="Last update" v={fmtTime(fut.ts)} />
              {fut.missing?.length > 0 && (
                <div className="rounded border border-warn/25 bg-warn/5 px-2 py-1.5">
                  <div className="text-[9.5px] text-warn font-semibold mb-0.5">Fields unavailable from the API for this contract</div>
                  {fut.missing.map((m: string, i: number) => <div key={i} className="text-[9.5px] text-ink2">· {m}</div>)}
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* option chain */}
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel title="Option-chain strike intelligence" className="flex-1" right={<Chip tone={opt?.available ? "up" : "warn"}>{opt?.available ? `${opt.strikes?.length ?? 0} strikes` : "unavailable"}</Chip>}>
          {!opt?.available ? (
            <div className="space-y-2.5">
              <div className="flex items-start gap-3 rounded-md border border-warn/30 bg-warn/5 px-3 py-2.5">
                <Ban size={15} className="text-warn shrink-0 mt-0.5" />
                <div>
                  <div className="text-[12px] font-semibold text-warn">Option chain unavailable</div>
                  <div className="text-[10.5px] text-ink2 mt-1 leading-relaxed">{opt?.reason}</div>
                </div>
              </div>
              <div className="text-[10px] text-ink2 leading-relaxed rounded border hairline bg-panel2 px-3 py-2.5">
                Strikes within ±8% of spot are labelled <b>Strong / Strengthening / Weak / Weakening / Breakdown-Breakout Risk</b> from documented OI + ΔOI + volume rules. OI never proves writer vs buyer initiation — that caveat rides on every label.
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="violet">expiry {opt.expiry}</Chip>
                <Chip tone={opt.pcr > 1 ? "up" : "down"}>PCR {opt.pcr ?? "—"}</Chip>
                <Chip tone="mute">{opt.rowsReceived ?? 0} chain rows</Chip>
                <Chip tone="mute">spot {fmtPx(opt.spot)}</Chip>
              </div>
              <div className="text-[9px] text-ink3 leading-snug">{opt.pcrScope}</div>
              <div className="space-y-1">
                {opt.strikes.map((s: any) => (
                  <div key={s.strike} className="rounded border hairline bg-panel2 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="num text-[11px] font-bold w-[64px]">{fmtPx(s.strike, 0)}</span>
                      <Chip tone={(STRIKE_TONE[s.label] ?? "mute") as any}>{s.label.replace(/_/g, " ")}</Chip>
                      <span className="num text-[9px] text-ink3 ml-auto">P {fmtBig(s.putOI)} · C {fmtBig(s.callOI)}</span>
                    </div>
                    <div className="text-[9px] text-ink3 mt-0.5">ΔP {s.putDeltaOI > 0 ? "+" : ""}{fmtBig(s.putDeltaOI)} · ΔC {s.callDeltaOI > 0 ? "+" : ""}{fmtBig(s.callDeltaOI)} — {s.rule}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>
      </div>

      {/* rules */}
      <div className="col-span-12 xl:col-span-3">
        <Panel title="Rules & caveats" className="h-full">
          <EvidenceList
            title="Futures / OI methodology"
            items={[
              "Contract = nearest NON-EXPIRED future for the underlying, resolved from the instrument master (never 'first row returned').",
              "Basis = futures price − corresponding underlying price, using the same snapshot.",
              "ΔOI = live OI − previous-session OI taken from the SAME contract's daily candles (never a different expiry).",
              "Price/OI combinations are conventional, provisional context only.",
            ]}
            tone="info"
          />
          <EvidenceList
            title="Explicit limitations"
            items={[
              "ΔOI does not identify the position initiator; call-OI addition is not automatically bearish writing.",
              "Strikes are contextual levels, not guaranteed support/resistance.",
              "Greeks/IV appear only when the feed supplies them; unavailable fields show 'Unavailable', never 0.",
              "Intraday OI snapshots are exchange-published and may lag the price feed.",
            ]}
            tone="warn"
          />
        </Panel>
      </div>
    </div>
  );
}
