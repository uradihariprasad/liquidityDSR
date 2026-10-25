"use client";

import { useMemo, useState } from "react";
import { Panel, Chip, Row, EvidenceList, FeedGate, EmptyState } from "@/components/ui";
import { ScenarioCard } from "@/components/panels/WorkspacePanel";
import Diagnostics from "@/components/Diagnostics";
import { usePoll, fmtPx, fmtPct, fmtTime, timeAgo } from "@/lib/client/api";
import { useScanListener } from "@/lib/client/scanTrigger";
import type { PanelProps } from "./common";
import { ShieldAlert, Target, Loader2, Radar } from "lucide-react";

const SCAN_MS = 30_000;

function PositionSizer({ bundle }: { bundle: any }) {
  const risk = bundle?.riskConfig ?? { riskPerTradePct: 0.5 };
  const [capital, setCapital] = useState(500000);
  const s = bundle?.scenario;
  const lotSize = bundle?.lotSize ?? 1;
  if (!s?.entryZone || !s?.stop) return null;
  const entry = s.direction === "LONG" ? s.entryZone[0] : s.entryZone[1];
  const perShare = Math.abs(entry - s.stop);
  const riskAmount = capital * (risk.riskPerTradePct / 100);
  const lots = perShare > 0 ? Math.floor(riskAmount / (perShare * lotSize)) : 0;
  return (
    <div className="rounded-md border hairline bg-panel2 px-2.5 py-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="panel-label">Position sizing (illustrative)</span>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-ink3">capital ₹</span>
          <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value) || 0)}
            className="w-[92px] bg-panel3 border hairline2 rounded px-1.5 py-0.5 text-[10.5px] num outline-none" />
        </div>
      </div>
      <Row k="Risk per trade" v={`${risk.riskPerTradePct}% = ₹${Math.round(riskAmount).toLocaleString("en-IN")}`} />
      <Row k="Per-share risk" v={fmtPx(perShare)} />
      <Row k="Lot size" v={lotSize} />
      <Row k="Max lots (floor)" v={lots} tone={lots > 0 ? "text-up" : "text-warn"} />
      <div className="text-[9px] text-ink3 leading-snug">floor(risk / (|entry−stop| × lot)). Fees &amp; slippage excluded. Execution is disabled.</div>
    </div>
  );
}

function TradeCard({ c, onPick }: { c: any; onPick: (s: string) => void }) {
  const long = c.direction === "LONG";
  return (
    <button onClick={() => onPick(c.symbol)} className="w-full text-left rounded-md border hairline bg-panel2 hover:border-info/45 px-2.5 py-2 transition-colors">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="num text-[10px] text-ink3 w-[18px]">#{c.rank}</span>
        <span className="text-[12px] font-bold">{c.symbol}</span>
        <Chip tone={c.kind === "index" ? "violet" : c.foEligible ? "info" : "mute"}>{c.instrumentType}</Chip>
        <Chip tone={long ? "up" : "down"}>{c.direction}</Chip>
        <Chip tone="mute">{c.setup.replace(/_/g, " ")}</Chip>
        <span className="flex-1" />
        <Chip tone="cyan">score {c.rankScore}</Chip>
        <Chip tone="info">RR {c.rr}</Chip>
        <Chip tone="mute">FMPI {c.fmpi.toFixed(0)}</Chip>
      </div>
      <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div><div className="text-[8px] text-ink3 uppercase">price</div><div className="num text-[11px] font-semibold">{fmtPx(c.price)}</div></div>
        <div><div className="text-[8px] text-ink3 uppercase">entry</div><div className="num text-[11px] font-semibold text-info">{c.entryZone ? `${fmtPx(c.entryZone[0])}–${fmtPx(c.entryZone[1])}` : "—"}</div></div>
        <div><div className="text-[8px] text-ink3 uppercase">stop</div><div className="num text-[11px] font-semibold text-down">{fmtPx(c.stop)}</div></div>
        <div><div className="text-[8px] text-ink3 uppercase">targets</div><div className="num text-[11px] font-semibold text-up">{fmtPx(c.t1)} / {fmtPx(c.t2)}</div></div>
      </div>
      <div className="mt-1 text-[9.5px] text-ink3">state <span className="text-ink2">{c.movementState.replace(/_/g, " ")}</span> · {c.liquidityContext}</div>
      <div className="mt-1 text-[9.5px] text-cyan/80">ranked because: {c.rankReason}</div>
      {c.supporting?.slice(0, 2).map((s: string, i: number) => (
        <div key={i} className="text-[9.5px] text-ink2 leading-snug flex gap-1.5 mt-0.5"><span className="text-up">▸</span>{s}</div>
      ))}
      {c.contradicting?.slice(0, 1).map((s: string, i: number) => (
        <div key={i} className="text-[9.5px] text-warn/80 leading-snug flex gap-1.5 mt-0.5"><span>▾</span>{s}</div>
      ))}
      <div className="mt-1 flex items-center gap-2 text-[8.5px] text-ink3">
        <span>data {fmtTime(c.dataTs)}</span><span>quality {c.dataQuality}</span><span>status {c.status.replace(/_/g, " ")}</span>
      </div>
    </button>
  );
}

export default function TradesPanel({ symbol, bundle, setSymbol }: PanelProps) {
  const { data, loading, refresh } = usePoll("/api/opportunities?limit=10", SCAN_MS);
  // refresh the display when a manual scan completes; the 30s interval is unaffected
  useScanListener(() => { refresh(); });
  const [scanning, setScanning] = useState(false);
  const [dir, setDir] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [kind, setKind] = useState<"ALL" | "INDEX" | "FO" | "CASH">("ALL");
  const [minRR, setMinRR] = useState(0);
  const [minFMPI, setMinFMPI] = useState(0);

  const [scanError, setScanError] = useState<string | null>(null);

  /**
   * Manual rescan with a hard client timeout + cancellation, so the panel can
   * never sit on "Scanning universe..." indefinitely (root cause B23).
   */
  const scanNow = async () => {
    setScanning(true);
    setScanError(null);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 45_000);
    try {
      const res = await fetch("/api/opportunities?limit=10", { method: "POST", signal: ac.signal });
      if (!res.ok) throw new Error(`scan failed (HTTP ${res.status})`);
    } catch (err) {
      setScanError(
        (err as any)?.name === "AbortError"
          ? "Scan timed out after 45s — the server keeps partial results; press Scan now to continue."
          : err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
      await refresh();
      setScanning(false);
    }
  };

  /**
   * Filter semantics (spec §1, §2). Direction and instrument type are
   * INDEPENDENT axes — neither narrows the other.
   *
   * ROOT CAUSE B28 (fixed): `CASH` was `!c.foEligible`, which swept indices
   * into "cash", and `F&O` excluded indices outright — so an index future
   * could never appear under F&O. Classification is now explicit and
   * mutually exclusive:
   *   INDEX = index instruments (incl. their mapped futures)
   *   FO    = F&O-eligible stocks AND index instruments that have futures
   *   CASH  = non-index instruments with no F&O eligibility
   */
  const classify = (c: any): "INDEX" | "FO" | "CASH" =>
    c.kind === "index" ? "INDEX" : c.foEligible ? "FO" : "CASH";

  const matchesKind = (c: any) => {
    if (kind === "ALL") return true;
    const k = classify(c);
    if (kind === "INDEX") return k === "INDEX";
    // F&O includes eligible stocks AND supported index futures
    if (kind === "FO") return k === "FO" || (k === "INDEX" && !!c.foEligible);
    return k === "CASH";
  };
  const matchesDir = (c: any) => dir === "ALL" || c.direction === dir;
  const matchesQuality = (c: any) => (c.rr ?? 0) >= minRR && c.fmpi >= minFMPI;

  const all: any[] = useMemo(() => data?.candidates ?? [], [data]);
  const rows = useMemo(
    () => all.filter((c) => matchesDir(c) && matchesKind(c) && matchesQuality(c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, dir, kind, minRR, minFMPI],
  );

  /** How many candidates each filter axis is hiding — shown in the UI. */
  const hidden = useMemo(() => {
    const byDir = all.filter((c) => !matchesDir(c) && matchesKind(c) && matchesQuality(c)).length;
    const byKind = all.filter((c) => matchesDir(c) && !matchesKind(c) && matchesQuality(c)).length;
    const byQuality = all.filter((c) => matchesDir(c) && matchesKind(c) && !matchesQuality(c)).length;
    return { byDir, byKind, byQuality, total: all.length - rows.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, rows.length, dir, kind, minRR, minFMPI]);

  const filtersActive = dir !== "ALL" || kind !== "ALL" || minRR > 0 || minFMPI > 0;

  const s = bundle?.scenario;
  const hasData = (bundle?.candles?.length ?? 0) > 0;

  const Btn = ({ on, set, val, label }: any) => (
    <button onClick={() => set(val)} className={`h-6 px-2 rounded border text-[9.5px] font-semibold ${on === val ? "border-info/45 text-info bg-info/10" : "hairline2 text-ink3 hover:text-ink"}`}>{label}</button>
  );

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      {/* ranked opportunities */}
      <div className="col-span-12 xl:col-span-7 flex flex-col gap-2.5 min-h-0">
        <Panel
          title="Trade Finder — top ranked opportunities across the eligible universe"
          className="flex-1"
          right={
            <button onClick={scanNow} disabled={scanning} className="flex items-center gap-1.5 h-6 px-2.5 rounded border border-info/40 text-info text-[10px] font-semibold hover:bg-info/10 disabled:opacity-50">
              {scanning ? <Loader2 size={10} className="animate-spin" /> : <Radar size={10} />}{scanning ? "scanning…" : "Scan now"}
            </button>
          }
        >
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            <Btn on={dir} set={setDir} val="ALL" label="all" /><Btn on={dir} set={setDir} val="LONG" label="bullish" /><Btn on={dir} set={setDir} val="SHORT" label="bearish" />
            <span className="w-px h-4 bg-line mx-0.5" />
            <Btn on={kind} set={setKind} val="ALL" label="any" /><Btn on={kind} set={setKind} val="INDEX" label="index" /><Btn on={kind} set={setKind} val="FO" label="F&O" /><Btn on={kind} set={setKind} val="CASH" label="cash" />
            <span className="w-px h-4 bg-line mx-0.5" />
            <label className="flex items-center gap-1 text-[9.5px] text-ink3">min RR
              <input type="number" step={0.5} value={minRR} onChange={(e) => setMinRR(Number(e.target.value) || 0)} className="w-[48px] bg-panel3 border hairline2 rounded px-1 py-0.5 num text-[10px] outline-none" /></label>
            <label className="flex items-center gap-1 text-[9.5px] text-ink3">min FMPI
              <input type="number" step={5} value={minFMPI} onChange={(e) => setMinFMPI(Number(e.target.value) || 0)} className="w-[48px] bg-panel3 border hairline2 rounded px-1 py-0.5 num text-[10px] outline-none" /></label>
            {data && <span className="text-[9px] text-ink3 ml-auto">scan {timeAgo(data.ts)} · auto 30s</span>}
          </div>

          {data?.available === false && <FeedGate quality={bundle?.quality} what="Trade Finder scan" extra={data.reason} />}
          {loading && !data && <EmptyState title="Scanning universe…" detail="Quoting the eligible universe, then analysing instruments within the per-cycle budget. This completes even if some instruments remain pending." />}
          {data?.scheduler?.blockedReason && (
            <div className="mb-2 rounded border border-warn/40 bg-warn/10 px-2.5 py-2 text-[10.5px] text-warn leading-snug">
              {data.scheduler.blockedReason}
            </div>
          )}

          {data?.available && (
            <>
              {filtersActive && (
                <div className="flex flex-wrap items-center gap-1.5 mb-2 text-[9.5px]">
                  <span className="text-ink3">active filters:</span>
                  {dir !== "ALL" && <Chip tone="info">direction {dir}</Chip>}
                  {kind !== "ALL" && <Chip tone="info">type {kind}</Chip>}
                  {minRR > 0 && <Chip tone="info">RR ≥ {minRR}</Chip>}
                  {minFMPI > 0 && <Chip tone="info">FMPI ≥ {minFMPI}</Chip>}
                  <button
                    onClick={() => { setDir("ALL"); setKind("ALL"); setMinRR(0); setMinFMPI(0); }}
                    className="px-1.5 py-0.5 rounded border hairline2 text-ink3 hover:text-ink"
                  >clear all</button>
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 mb-2 text-[9.5px]">
                {data.funnel && (
                  <>
                    <Chip tone="mute" title="Instruments with a last-known quote (fresh or cached)">{data.funnel.quoted} quoted</Chip>
                    <Chip tone={data.scheduler?.quotesStale ? "warn" : "mute"} title="Quotes refreshed on the latest call">
                      {data.scheduler?.freshQuotes ?? 0} fresh{data.scheduler?.quotesStale ? " · cache STALE" : ""}
                    </Chip>
                    <Chip tone="up" title="Instruments with fresh full analysis">{data.funnel.freshlyAnalysed} analysed</Chip>
                    <Chip tone="mute" title="Entered ranking (had a usable FMPI)">{data.funnel.enteredRanking} ranked</Chip>
                  </>
                )}
                <Chip tone="mute">{data.evaluated} evaluated</Chip>
                <Chip tone={data.qualified ? "up" : "warn"}>{data.qualified} qualified</Chip>
                {data.scheduler && (
                  <>
                    <Chip tone="info" title={data.scheduler.note}>universe {data.scheduler.universe}</Chip>
                    <Chip tone="up" title="Instruments with fresh validated full analysis">{data.scheduler.fullyAnalysed} analysed</Chip>
                    {data.scheduler.pendingAnalysis > 0 && (
                      <Chip tone="warn" title="Awaiting a later scan cycle — never ranked">{data.scheduler.pendingAnalysis} pending</Chip>
                    )}
                    {data.scheduler.quoteOnly > 0 && (
                      <Chip tone="mute" title="Quote-only; not ranked as a signal">{data.scheduler.quoteOnly} quote-only</Chip>
                    )}
                    <Chip tone="mute" title={`Progressive coverage: ${data.scheduler.analysisBudgetPerCycle}/cycle, freshness ${data.scheduler.freshnessSec}s`}>
                      {data.scheduler.progressPct}% covered
                    </Chip>
                  </>
                )}
                {data.complete === false && (
                  <Chip tone="warn" title={`Evaluation budget reached — ${data.pendingEvaluation ?? 0} instruments carry into the next scan`}>
                    partial · {data.pendingEvaluation ?? 0} pending
                  </Chip>
                )}
                {data.complete === true && <Chip tone="up">scan complete</Chip>}
                <Chip tone="cyan" className="hidden 2xl:inline-flex">{data.formula}</Chip>
              </div>
              {scanError && (
                <div className="mb-2 rounded border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[10px] text-warn flex items-center gap-2">
                  <span className="flex-1">{scanError}</span>
                  <button onClick={scanNow} className="px-2 py-0.5 rounded border border-warn/50 font-semibold hover:bg-warn/15">retry</button>
                </div>
              )}
              {data.scheduler && (
                <div className="text-[9px] text-ink3 leading-snug mb-2">{data.scheduler.note}</div>
              )}
              <div className="space-y-2">
                {rows.map((c) => <TradeCard key={c.symbol + c.rank} c={c} onPick={setSymbol} />)}
              </div>
              {!rows.length && (
                <EmptyState
                  title={
                    data.qualified > 0 ? "FILTERED_OUT — candidates exist but are hidden by your filters"
                    : data.status === "RATE_LIMITED" ? "RATE_LIMITED — Upstox quote quota cooling down"
                    : data.status === "PARTIAL_DATA" ? "PARTIAL_DATA — scan still building coverage"
                    : data.status === "NOT_CONNECTED" ? "NOT_CONNECTED — Upstox token required"
                    : data.status === "SCAN_FAILED" ? "SCAN_FAILED"
                    : "NO_QUALIFYING_SETUP"
                  }
                  detail={
                    data.qualified > 0
                      ? `${data.qualified} candidate(s) found. Hidden by: ${[
                          hidden.byDir ? `direction (${hidden.byDir})` : null,
                          hidden.byKind ? `instrument type (${hidden.byKind})` : null,
                          hidden.byQuality ? `RR/FMPI minimums (${hidden.byQuality})` : null,
                        ].filter(Boolean).join(", ") || "active filters"}. Use “clear all” above to see them.`
                      : data.status === "RATE_LIMITED"
                        ? (data.scheduler?.blockedReason ?? "Requests are backing off; cached data is retained and marked stale.")
                      : data.status === "NOT_CONNECTED"
                        ? (data.scheduler?.blockedReason ?? "Connect an Upstox access token to begin scanning the eligible universe.")
                      : data.status === "PARTIAL_DATA"
                        ? `Coverage is still growing: ${data.funnel?.freshlyAnalysed ?? 0} of ${data.funnel?.universe ?? 0} instruments analysed, ${data.scheduler?.pendingAnalysis ?? 0} pending. Scanning continues automatically.`
                      : `All ${data.evaluated} evaluated instruments failed the mandatory gates (confirmation, RR, data quality). The list is never padded with dummy trades.`
                  }
                />
              )}
              {!!data.funnel?.excluded?.length && (
                <details className="mt-2">
                  <summary className="text-[9.5px] text-ink3 cursor-pointer">
                    exclusion funnel — {data.funnel.excluded.reduce((n: number, x: any) => n + x.count, 0)} instruments dropped before ranking
                  </summary>
                  <div className="mt-1 space-y-0.5">
                    {data.funnel.excluded.map((x: any) => (
                      <div key={x.stage} className="flex justify-between gap-2 text-[9px]">
                        <span className="text-ink3">{x.stage} — {x.reason}</span>
                        <span className="num text-ink2 shrink-0">{x.count}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              {!!data.rejected?.length && (
                <details className="mt-2">
                  <summary className="text-[9.5px] text-ink3 cursor-pointer">why {data.rejected.length} evaluated instruments produced no setup</summary>
                  <div className="mt-1 space-y-0.5">
                    {data.rejected.slice(0, 14).map((r: any, i: number) => (
                      <div key={i} className="text-[9px] text-ink3"><b className="text-ink2">{r.symbol}</b> — {r.reason}</div>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}
        </Panel>
      </div>

      {/* selected instrument detail */}
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel title={`Selected — ${symbol} · ${bundle?.tf ?? ""}`} className="flex-1">
          {!bundle && <EmptyState title="Loading…" />}
          {bundle && !hasData && (
            <div className="space-y-2.5">
              <FeedGate quality={bundle.quality} what="Trade scenario" extra="Scenarios require completed live candles — the engine will not build a setup from stale or absent data." />
              {s?.noTradeReasons?.length > 0 && <EvidenceList title="Blocking conditions" items={s.noTradeReasons} tone="warn" />}
              <Diagnostics bundle={bundle} />
            </div>
          )}
          {bundle && hasData && s && (
            <>
              <ScenarioCard scenario={s} />
              <div className="mt-3"><PositionSizer bundle={bundle} /></div>
            </>
          )}
        </Panel>
        <Panel title="Mandatory no-trade gates (Part 24)" className="shrink-0">
          <div className="space-y-1 text-[10px] text-ink2 leading-relaxed">
            {["Required data stale or missing", "Structure and momentum materially conflict", "Setup lacks documented confirmation",
              `Reward:risk below minimum (${bundle?.riskConfig?.minRR ?? 1.5})`, "Invalidation unclear or tighter than 0.2×ATR",
              "Spread/volatility outside suitability limits", "Instrument mapping uncertain", "Market closed without historical framing"].map((c, i) => {
              const active = s?.noTradeReasons?.some((r: string) => r.toLowerCase().includes(c.split(" ")[0].toLowerCase()));
              return (
                <div key={i} className={`flex items-center gap-2 rounded border px-2 py-1.5 ${active ? "border-warn/40 bg-warn/5 text-warn" : "hairline bg-panel2 text-ink3"}`}>
                  <ShieldAlert size={11} className="shrink-0" /><span>{c}</span>
                  <span className="ml-auto text-[9px] font-bold">{active ? "TRIGGERED" : "clear"}</span>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
    </div>
  );
}
