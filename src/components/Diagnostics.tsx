"use client";

import { useState } from "react";
import { Chip } from "@/components/ui";
import { fmtTime, timeAgo } from "@/lib/client/api";
import { Stethoscope, ChevronDown } from "lucide-react";

const TONE: Record<string, any> = { OK: "up", EMPTY: "warn", ERROR: "down", SKIPPED: "mute", PENDING: "mute" };

const STAGE_LABELS: Record<string, string> = {
  discovery: "Instrument discovery",
  resolve: "Symbol resolution",
  quote: "Quote request",
  candles: "Intraday candles",
  dailyHistory: "Daily history",
  depth: "Market depth",
  optionChain: "Option chain",
  indicators: "Indicators / FMPI",
};

/**
 * Expandable per-instrument diagnostic panel (spec §14).
 * Shows every pipeline stage, freshness per channel, the failure category
 * and an actionable next step. Never renders tokens or auth headers.
 */
export default function Diagnostics({ bundle, defaultOpen = false }: { bundle: any; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const d = bundle?.diagnostics;
  if (!d) return null;
  const failing = d.failureCategory && d.failureCategory !== "NONE";

  return (
    <div className={`rounded-md border ${failing ? "border-warn/35 bg-warn/5" : "hairline bg-panel2"}`}>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left">
        <Stethoscope size={12} className={failing ? "text-warn" : "text-ink3"} />
        <span className="text-[10.5px] font-semibold">Instrument diagnostics</span>
        {failing && <Chip tone="warn">{d.failureCategory.replace(/_/g, " ")}</Chip>}
        {!failing && <Chip tone="up">pipeline ok</Chip>}
        <span className="num text-[9px] text-ink3 ml-auto truncate max-w-[220px]">{d.instrumentKey ?? d.symbolEntered}</span>
        <ChevronDown size={11} className={`text-ink3 shrink-0 ${open ? "rotate-180" : ""} transition-transform`} />
      </button>

      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t hairline pt-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px]">
            <div className="flex justify-between"><span className="text-ink3">entered</span><span className="num">{d.symbolEntered}</span></div>
            <div className="flex justify-between"><span className="text-ink3">resolved</span><span className="num">{d.resolvedSymbol ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="text-ink3">key</span><span className="num truncate">{d.instrumentKey ?? "—"}</span></div>
            <div className="flex justify-between gap-2"><span className="text-ink3">futures</span><span className="num truncate">{d.futuresKey ?? "none"}</span></div>
            <div className="flex justify-between"><span className="text-ink3">exchange</span><span className="num">{d.exchange ?? "—"} / {d.segment ?? "—"}</span></div>
            <div className="flex justify-between"><span className="text-ink3">F&O eligible</span><span className={`num ${d.foEligible ? "text-up" : "text-ink3"}`}>{d.foEligible == null ? "—" : d.foEligible ? "yes" : "no (cash only)"}</span></div>
          </div>

          <div>
            <div className="panel-label mb-1">pipeline stages</div>
            <div className="space-y-0.5">
              {Object.entries(d.stages).map(([k, v]: [string, any]) => (
                <div key={k} className="flex items-start gap-2 text-[10px]">
                  <Chip tone={TONE[v.status] ?? "mute"} className="shrink-0 w-[58px] justify-center">{v.status}</Chip>
                  <span className="text-ink2 w-[112px] shrink-0">{STAGE_LABELS[k] ?? k}</span>
                  <span className="text-ink3 flex-1 leading-snug">{v.detail}{v.latencyMs != null ? ` · ${v.latencyMs}ms` : ""}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="panel-label mb-1">data freshness (per channel)</div>
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
              {[
                ["quote", d.freshness.lastQuoteTs],
                ["tick", d.freshness.lastTickTs],
                ["candle", d.freshness.lastCandleTs],
                ["depth", d.freshness.lastDepthTs],
                ["chain", d.freshness.lastOptionChainTs],
              ].map(([k, ts]: any) => (
                <div key={k} className="rounded border hairline bg-panel3 px-1.5 py-1 text-center">
                  <div className="text-[8px] text-ink3 uppercase tracking-wider">{k}</div>
                  <div className={`num text-[9.5px] ${ts ? "text-ink2" : "text-ink3"}`}>{ts ? fmtTime(ts) : "—"}</div>
                  <div className="text-[8px] text-ink3">{ts ? timeAgo(ts) : "no data"}</div>
                </div>
              ))}
            </div>
          </div>

          {failing && (
            <div className="rounded border border-warn/30 bg-warn/5 px-2 py-1.5">
              <div className="text-[10px] text-warn font-semibold">{d.failureCategory.replace(/_/g, " ")}</div>
              {d.failureDetail && <div className="text-[10px] text-ink2 mt-0.5 leading-snug">{d.failureDetail}</div>}
              {d.nextStep && <div className="text-[10px] text-ink3 mt-1 leading-snug"><b className="text-ink2">Next step:</b> {d.nextStep}</div>}
            </div>
          )}
          {d.suggestions?.length > 0 && (
            <div className="text-[10px] text-ink3">Closest symbols in the master: <span className="num text-info">{d.suggestions.join(", ")}</span></div>
          )}
        </div>
      )}
    </div>
  );
}
