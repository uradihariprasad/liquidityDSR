"use client";

import { useEffect, useState } from "react";
import { Panel, Chip, EmptyState } from "@/components/ui";
import { usePoll, postJSON, putJSON } from "@/lib/client/api";
import type { PanelProps } from "./common";
import { Plus, X, Save } from "lucide-react";

function Num({ label, value, onChange, step = 1, min = 0, max = 100 }: any) {
  return (
    <label className="flex items-center justify-between gap-2 py-1">
      <span className="text-[10.5px] text-ink2">{label}</span>
      <input
        type="number" step={step} min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-[84px] bg-panel3 border hairline2 rounded px-1.5 py-1 text-[11px] num outline-none focus:border-info/50"
      />
    </label>
  );
}

export default function SettingsPanel(props: PanelProps & { onPick: (s: string) => void }) {
  const wl = usePoll("/api/watchlists", 30000);
  const cfgApi = usePoll("/api/settings", 0);
  const [cfg, setCfg] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [newList, setNewList] = useState("");

  // Seed local editable state from the fetched config once. Derived-state
  // synchronisation is done during render (not in an effect) to avoid the
  // cascading-render hazard flagged by react-hooks/set-state-in-effect.
  const [seededFrom, setSeededFrom] = useState<any>(null);
  if (cfgApi.data?.config && seededFrom !== cfgApi.data) {
    setSeededFrom(cfgApi.data);
    setCfg(cfgApi.data.config);
  }

  const save = async () => {
    await putJSON("/api/settings", { config: cfg });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    cfgApi.refresh();
  };

  const addItem = async () => {
    const sym = newSymbol.trim().toUpperCase();
    const wlId = wl.data?.watchlists?.[0]?.id;
    if (!sym || !wlId) return;
    await postJSON("/api/watchlists/items", { watchlistId: wlId, symbol: sym });
    setNewSymbol("");
    wl.refresh();
  };

  const removeItem = async (id: number) => {
    await fetch(`/api/watchlists/items?id=${id}`, { method: "DELETE" });
    wl.refresh();
  };

  const createList = async () => {
    if (!newList.trim()) return;
    await postJSON("/api/watchlists", { name: newList.trim() });
    setNewList("");
    wl.refresh();
  };

  const watchlist = wl.data?.watchlists?.[0];

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up overflow-auto">
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel title={`Watchlist — ${watchlist?.name ?? "…"} (persisted)`} className="flex-1">
          <div className="flex gap-1.5 mb-2">
            <input value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)} placeholder="SYMBOL (e.g. MARUTI)" className="flex-1 bg-panel3 border hairline2 rounded px-2 py-1 text-[11px] outline-none focus:border-info/50 placeholder:text-ink3" />
            <button onClick={addItem} className="h-7 px-2.5 rounded border border-info/40 text-info text-[10px] font-semibold hover:bg-info/10 flex items-center gap-1"><Plus size={11} /> add</button>
          </div>
          <div className="space-y-1">
            {(watchlist?.items ?? []).map((it: any) => (
              <div key={it.id} className="flex items-center gap-2 rounded border hairline bg-panel2 px-2 py-1.5">
                <button onClick={() => props.onPick(it.symbol)} className="text-[11px] font-bold hover:text-info transition-colors">{it.symbol}</button>
                <Chip tone={it.kind === "index" ? "violet" : "info"}>{it.kind}</Chip>
                <span className="text-[9px] text-ink3 truncate flex-1">{it.instrumentKey}</span>
                <button onClick={() => removeItem(it.id)} className="text-ink3 hover:text-down"><X size={12} /></button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 mt-3">
            <input value={newList} onChange={(e) => setNewList(e.target.value)} placeholder="New watchlist name" className="flex-1 bg-panel3 border hairline2 rounded px-2 py-1 text-[11px] outline-none placeholder:text-ink3" />
            <button onClick={createList} className="h-7 px-2.5 rounded border hairline2 text-ink2 text-[10px] font-semibold hover:bg-panel3">create</button>
          </div>
          {wl.data?.note && <div className="text-[10px] text-warn mt-2">{wl.data.note}</div>}
        </Panel>
      </div>

      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel
          title="Scanner & alert thresholds (applied live)"
          className="flex-1"
          right={
            <button onClick={save} className="flex items-center gap-1 h-6 px-2.5 rounded border border-up/40 text-up text-[10px] font-semibold hover:bg-up/10">
              <Save size={10} /> {saved ? "saved ✓" : "save"}
            </button>
          }
        >
          {cfg ? (
            <div className="grid grid-cols-2 gap-x-6">
              <div>
                <div className="panel-label my-1">Scanner filters</div>
                <Num label="Result count (max 20)" value={cfg.scanner.count} min={3} max={20} onChange={(v: number) => setCfg({ ...cfg, scanner: { ...cfg.scanner, count: v } })} />
                <Num label="Min FMPI" value={cfg.scanner.minFMPI} max={90} onChange={(v: number) => setCfg({ ...cfg, scanner: { ...cfg.scanner, minFMPI: v } })} />
                <Num label="Min relative volume" value={cfg.scanner.minRelVol} step={0.1} max={5} onChange={(v: number) => setCfg({ ...cfg, scanner: { ...cfg.scanner, minRelVol: v } })} />
                <Num label="Min change %" value={cfg.scanner.minChangePct} step={0.05} max={5} onChange={(v: number) => setCfg({ ...cfg, scanner: { ...cfg.scanner, minChangePct: v } })} />
              </div>
              <div>
                <div className="panel-label my-1">Alert thresholds</div>
                <Num label="FMPI high alert" value={cfg.alerts.fmpiHigh} onChange={(v: number) => setCfg({ ...cfg, alerts: { ...cfg.alerts, fmpiHigh: v } })} />
                <Num label="FMPI low alert" value={cfg.alerts.fmpiLow} onChange={(v: number) => setCfg({ ...cfg, alerts: { ...cfg.alerts, fmpiLow: v } })} />
                <Num label="Default cooldown (s)" value={cfg.alerts.cooldownSec} step={60} max={7200} onChange={(v: number) => setCfg({ ...cfg, alerts: { ...cfg.alerts, cooldownSec: v } })} />
              </div>
            </div>
          ) : <EmptyState title="Loading config…" />}
          <div className="text-[9.5px] text-ink3 mt-2 leading-snug">Changes apply to subsequent scanner/rank/alerts evaluations immediately and are persisted to Postgres (settings.runtime).</div>
        </Panel>
        <Panel title="Risk configuration (documented defaults)" className="shrink-0">
          <div className="grid grid-cols-2 gap-x-6 text-[10.5px]">
            <div className="flex justify-between py-1"><span className="text-ink2">min reward:risk</span><span className="num">1.5</span></div>
            <div className="flex justify-between py-1"><span className="text-ink2">min FMPI for scenarios</span><span className="num">55</span></div>
            <div className="flex justify-between py-1"><span className="text-ink2">max active scenarios</span><span className="num">4</span></div>
            <div className="flex justify-between py-1"><span className="text-ink2">risk per trade</span><span className="num">0.5%</span></div>
            <div className="flex justify-between py-1"><span className="text-ink2">daily loss limit</span><span className="num">2%</span></div>
            <div className="flex justify-between py-1"><span className="text-ink2">ATR stop buffer</span><span className="num">0.35×</span></div>
          </div>
          <div className="text-[9.5px] text-ink3 mt-1.5 leading-snug">Analysis-only platform: no order execution exists, so no real-order confirmation path is required. Risk values inform scenario filters and the sizing illustration.</div>
        </Panel>
      </div>

      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5">
        <Panel title="Documentation index (README)" className="flex-1">
          <div className="space-y-1.5 text-[10.5px]">
            {[
              ["§1 Architecture", "Next.js fullstack: engine modules in src/lib/market, API in src/app/api, PostgreSQL via Drizzle."],
              ["§4 Data engine", "Live-only Upstox adapter (quotes, intraday v3 candles, option chain, instrument master). No demo/simulated feed exists."],
              ["§6 Movement states", "Ordered rule evaluation: sweeps → confirmed breaks → structural shifts → trends → ranges → conflicts."],
              ["§7 Liquidity zones", "Sources, merge rule (0.45×ATR), strength formula, nine-state machine including POTENTIALLY_SWEPT."],
              ["§8 Volume profile", "Uniform-allocation approximation, POC/VA/​HVN/LVN, position classification."],
              ["§9 FMPI", "Weights 0.22/0.16/0.16/0.08/0.10/0.10/0.08/0.08, redistribution for unavailable channels, penalties, dq multiplier."],
              ["§10 Order flow", "OBI formula, displayed-vs-executed doctrine, footprint capability gate."],
              ["§11 Derivatives", "Price/OI conventional mapping (provisional), strike label rules, PCR scope."],
              ["§12 Scanner & trades", "Rank formula; scenario gates incl. Part-24 mandatory no-trade conditions."],
              ["§13 Backtest", "Rule set, fill model, costs, 60/40 in/out-of-sample, anti-lookahead construction."],
              ["§14 Tests & limitations", "Vitest suite for pure engines; live-only channels marked unverified without credentials."],
            ].map(([k, v]) => (
              <div key={k as string} className="rounded border hairline bg-panel2 px-2.5 py-2">
                <div className="font-bold text-[10.5px]">{k}</div>
                <div className="text-[10px] text-ink2 mt-0.5 leading-snug">{v}</div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
