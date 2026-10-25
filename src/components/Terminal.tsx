"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutDashboard, Activity, Droplets, BookOpen, Gauge, Radar, GitBranch, Newspaper,
  Target, BellRing, History, Settings2, Search, TrendingUp, TrendingDown, Loader2, Scale, Layers,
} from "lucide-react";
import { usePoll, fmtPx, fmtPct, changeColor, stateTone, timeAgo } from "@/lib/client/api";
import { Chip } from "@/components/ui";
import UpstoxAuth from "@/components/UpstoxAuth";
import { triggerManualScan } from "@/lib/client/scanTrigger";
import dynamic from "next/dynamic";

const OverviewPanel = dynamic(() => import("@/components/panels/OverviewPanel"));
const WorkspacePanel = dynamic(() => import("@/components/panels/WorkspacePanel"));
const LiquidityPanel = dynamic(() => import("@/components/panels/LiquidityPanel"));
const DepthPanel = dynamic(() => import("@/components/panels/DepthPanel"));
const IntelligencePanel = dynamic(() => import("@/components/panels/IntelligencePanel"));
const SRPanel = dynamic(() => import("@/components/panels/SRPanel"));
const FmpiPanel = dynamic(() => import("@/components/panels/FmpiPanel"));
const ScannerPanel = dynamic(() => import("@/components/panels/ScannerPanel"));
const DerivativesPanel = dynamic(() => import("@/components/panels/DerivativesPanel"));
const NewsPanel = dynamic(() => import("@/components/panels/NewsPanel"));
const TradesPanel = dynamic(() => import("@/components/panels/TradesPanel"));
const AlertsPanel = dynamic(() => import("@/components/panels/AlertsPanel"));
const BacktestPanel = dynamic(() => import("@/components/panels/BacktestPanel"));
const SettingsPanel = dynamic(() => import("@/components/panels/SettingsPanel"));

export const TIMEFRAME_LIST = [1, 2, 3, 5, 15, 30];

const NAV = [
  { id: "overview", label: "Market Overview", icon: LayoutDashboard },
  { id: "workspace", label: "Movement Intelligence", icon: Activity },
  { id: "liquidity", label: "Liquidity Map", icon: Droplets },
  { id: "depth", label: "Order Flow & Depth", icon: BookOpen },
  { id: "intelligence", label: "Buyer/Seller Intel", icon: Scale },
  { id: "sr", label: "Smart S&R", icon: Layers },
  { id: "fmpi", label: "FMPI Momentum", icon: Gauge },
  { id: "scanner", label: "F&O Scanner", icon: Radar },
  { id: "derivatives", label: "Futures & Options", icon: GitBranch },
  { id: "news", label: "News Intelligence", icon: Newspaper },
  { id: "trades", label: "Trade Finder", icon: Target },
  { id: "alerts", label: "Alerts", icon: BellRing },
  { id: "replay", label: "Replay & Backtest", icon: History },
  { id: "settings", label: "Watchlists & Config", icon: Settings2 },
] as const;

export type NavId = (typeof NAV)[number]["id"];

/**
 * Shared API health chip: shows rate-limit status, retry countdown and the
 * last successful fetch. One shared API failure is reported here rather than
 * being mislabelled onto every instrument.
 */
function ApiStatusChip({ rateLimit, lastFetch }: { rateLimit?: any; lastFetch?: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!rateLimit) return null;

  const remaining = Math.max(0, Math.ceil((rateLimit.cooldownRemainingMs ?? 0) / 1000));
  // Name the quota that is actually limited, so unrelated channels are not
  // misreported as failed.
  const limitedClasses = Object.entries(rateLimit.classes ?? {})
    .filter(([, v]: any) => v?.limited)
    .map(([k]) => k);
  const limitedLabel = limitedClasses.length ? limitedClasses.join(", ") : "quotes";

  if (rateLimit.limited && remaining > 0) {
    return (
      <Chip tone="warn" title={`Upstox ${limitedLabel} quota rate-limited — retrying in ${remaining}s. Requests to this quota back off; other channels keep working and cached data is labelled stale.`}>
        <Loader2 size={10} className="animate-spin" /> API {limitedLabel} · retry {remaining}s
      </Chip>
    );
  }
  if (rateLimit.consecutive429 > 0 || rateLimit.status === "RATE_LIMITED") {
    return <Chip tone="warn" title="Recovered from a rate limit">API recovering</Chip>;
  }
  const dedup = rateLimit.deduplicated ?? 0;
  const hits = rateLimit.cacheHits ?? 0;
  return (
    <Chip
      tone="up"
      title={[
        lastFetch ? `Last successful Upstox fetch: ${new Date(lastFetch).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })} IST` : "No successful Upstox fetch yet",
        `requests: ${rateLimit.totalRequests ?? 0}`,
        `cache hits: ${hits}`,
        `deduplicated: ${dedup}`,
        `429s: ${rateLimit.total429 ?? 0}`,
        `in flight: ${rateLimit.inFlight ?? 0} · queued: ${rateLimit.pendingQueueSize ?? 0}`,
      ].join("\n")}
    >
      API ok{lastFetch ? ` · ${timeAgo(lastFetch)}` : ""}{dedup > 0 ? ` · ${dedup} dedup` : ""}
    </Chip>
  );
}

/**
 * Global manual scan button (top-right).
 * Triggers an immediate server-side scan WITHOUT interrupting the automatic
 * 30-second polling cycle that each panel runs independently.
 */
function ScanButton({ connected }: { connected: boolean }) {
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const run = async () => {
    setScanning(true);
    setResult(null);
    try {
      const r = await triggerManualScan();
      setResult({
        ok: r.ok,
        msg: r.ok ? `${r.scanned} scanned · ${r.analysed} analysed` : (r.error ?? "failed"),
      });
    } finally {
      setScanning(false);
      // clear the feedback after a few seconds
      setTimeout(() => setResult(null), 4000);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {result && (
        <span className={`text-[9px] num ${result.ok ? "text-up" : "text-down"} max-w-[150px] truncate`}>
          {result.msg}
        </span>
      )}
      <button
        onClick={run}
        disabled={scanning || !connected}
        title={
          connected
            ? "Scan now — fetches live market data immediately. The automatic 30-second scan continues unaffected."
            : "Connect Upstox to enable scanning"
        }
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-md border text-[10.5px] font-bold transition-colors touch-manipulation ${
          connected
            ? "border-info/50 bg-info/10 text-info hover:bg-info/20"
            : "border-line2 bg-panel2 text-ink3 cursor-not-allowed"
        }`}
      >
        {scanning ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />}
        <span className="hidden sm:inline">{scanning ? "Scanning…" : "SCAN"}</span>
        <span className="sm:hidden">{scanning ? "…" : "SCAN"}</span>
      </button>
    </div>
  );
}

function IndexTick({ label, snap }: { label: string; snap: any }) {
  if (!snap) return <div className="flex items-center gap-1.5 text-[11px]"><span className="text-ink3">{label}</span><span className="text-ink3">—</span></div>;
  return (
    <div className="flex items-center gap-1.5" title={`${label} — ${snap.state}`}>
      <span className="text-[10px] font-semibold tracking-wider text-ink3">{label}</span>
      <span className="num text-[12.5px] font-semibold">{fmtPx(snap.price, 0)}</span>
      <span className={`num text-[10.5px] flex items-center gap-0.5 ${changeColor(snap.changePct)}`}>
        {snap.changePct > 0 ? <TrendingUp size={10} /> : snap.changePct < 0 ? <TrendingDown size={10} /> : null}
        {fmtPct(snap.changePct)}
      </span>
    </div>
  );
}

function InstrumentSearch({ onPick, current }: { onPick: (s: string) => void; current: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const { data } = usePoll(open || q ? `/api/instruments?q=${encodeURIComponent(q)}` : null, 0, [q]);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  return (
    <div ref={boxRef} className="relative w-full sm:w-auto basis-full sm:basis-auto order-first sm:order-none">
      <div className="flex items-center gap-1.5 rounded-md border hairline2 bg-panel2 px-2 h-9 sm:h-8 w-full sm:w-[220px] xl:w-[240px]">
        <Search size={13} className="text-ink3 shrink-0" />
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={`Search instruments — ${current}`}
          className="bg-transparent outline-none text-[12px] sm:text-[11.5px] w-full placeholder:text-ink3 min-w-0"
        />
      </div>
      {open && (
        <div className="fixed sm:absolute z-50 left-2 right-2 sm:left-0 sm:right-auto mt-1 sm:w-[320px] rounded-md border hairline2 bg-panel2 shadow-2xl max-h-[55dvh] sm:max-h-[320px] overflow-auto overscroll-contain">
          {(data?.items ?? []).map((i: any) => (
            <button
              key={i.symbol}
              onClick={() => { onPick(i.symbol); setOpen(false); setQ(""); }}
              className="w-full min-h-11 sm:min-h-0 flex items-center justify-between gap-2 px-3 sm:px-2.5 py-2 sm:py-1.5 hover:bg-panel3 text-left touch-manipulation"
            >
              <span className="text-[11.5px] font-semibold">{i.symbol}</span>
              <span className="text-[10px] text-ink3 truncate">{i.name}</span>
              <Chip tone={i.kind === "index" ? "violet" : "info"} className="shrink-0">{i.kind}</Chip>
            </button>
          ))}
          {data && (data.items ?? []).length === 0 && <div className="px-3 py-2 text-[11px] text-ink3">No matches in the universe.</div>}
        </div>
      )}
    </div>
  );
}

export default function Terminal() {
  const [tab, setTab] = useState<NavId>("workspace");
  const [symbol, setSymbol] = useState("NIFTY");
  const [tf, setTf] = useState(5);
  const [auth, setAuth] = useState<any>(null);

  const overview = usePoll("/api/overview", 7000);
  const bundle = usePoll(`/api/analysis?symbol=${symbol}&tf=${tf}`, 5000, [symbol, tf]);

  const status = overview.data?.status;
  // "connected" only counts when the token is present AND not rejected
  const connected = auth ? !!auth.connected && !auth.expired : (status?.auth?.masked != null && !status?.auth?.expired);
  const authLoaded = auth != null;
  const mv = overview.data?.marketMovement;

  const pickSymbol = useCallback((s: string) => {
    setSymbol(s.toUpperCase());
    setTab((t) => (t === "overview" || t === "news" ? t : t));
  }, []);

  const panelProps = { symbol, tf, setSymbol: pickSymbol, setTf, bundle: bundle.data, bundleLoading: bundle.loading, bundleError: bundle.error };

  return (
    <div className="terminal-shell h-[100dvh] w-full flex flex-col bg-bg grid-texture overflow-hidden">
      {/* responsive global header: compact first row on mobile, full tape on desktop */}
      <header className="min-h-11 shrink-0 border-b hairline bg-panel/90 backdrop-blur flex flex-wrap xl:flex-nowrap items-center gap-x-3 gap-y-2 px-2 sm:px-3 py-1.5 xl:py-0">
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-7 w-7 rounded-md bg-gradient-to-br from-info/60 to-violet/60 border border-info/40 flex items-center justify-center">
            <Activity size={14} className="text-white" />
          </div>
          <div className="leading-none">
            <div className="text-[12px] font-bold tracking-wide">PULSEGRID</div>
            <div className="hidden sm:block text-[8.5px] text-ink3 tracking-[0.18em]">MARKET INTELLIGENCE</div>
          </div>
        </div>
        <UpstoxAuth onState={setAuth} />
        <div className="hidden xl:block h-5 w-px bg-line" />
        <div className="hidden lg:flex items-center gap-4">
          <IndexTick label="NIFTY" snap={overview.data?.indices?.nifty} />
          <IndexTick label="SENSEX" snap={overview.data?.indices?.sensex} />
          <IndexTick label="BANKNIFTY" snap={overview.data?.indices?.banknifty} />
        </div>
        <div className="hidden 2xl:block h-5 w-px bg-line" />
        <div className="hidden 2xl:flex items-center gap-1.5">
          <span className="text-[9.5px] uppercase tracking-wider text-ink3">market</span>
          <Chip tone={stateTone(mv?.state)}>{(mv?.state ?? "—").replace(/_/g, " ")}</Chip>
        </div>
        <div className="flex-1 min-w-0" />
        <div className="flex items-center gap-1.5 ml-auto shrink-0">
          <ScanButton connected={connected} />
          <Chip tone={status?.session === "OPEN" ? "up" : status?.session === "CLOSED" ? "mute" : "warn"}>{status?.session ?? "…"}</Chip>
          <Chip tone={connected ? "up" : "warn"} title="Engine mode — live data only">{connected ? "LIVE" : "OFFLINE"}</Chip>
          <div className="hidden sm:block num text-[10px] text-ink3" suppressHydrationWarning>
            {overview.lastFetch ? new Date(overview.lastFetch).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" }) : "--:--:--"} IST
          </div>
        </div>
      </header>

      {authLoaded && auth?.expired && (
        <div className="shrink-0 bg-down/10 border-b border-down/30 px-2 sm:px-3 py-1.5 text-[9.5px] sm:text-[10px] text-down flex flex-wrap items-center gap-x-2 gap-y-0.5 leading-snug">
          <span className="font-bold tracking-wider">UPSTOX TOKEN EXPIRED</span>
          <span className="text-down/80">Live data is paused. Enter a new access token using the “Token expired” button at the top-left to resume.</span>
        </div>
      )}
      {authLoaded && !connected && !auth?.expired && (
        <div className="shrink-0 bg-warn/10 border-b border-warn/25 px-2 sm:px-3 py-1.5 text-[9.5px] sm:text-[10px] text-warn flex flex-wrap items-center gap-x-2 gap-y-0.5 leading-snug">
          <span className="font-bold tracking-wider">LIVE-DATA-ONLY · NO TOKEN</span>
          <span className="text-warn/70">Connect Upstox above to activate live charts, scans and analytics.</span>
        </div>
      )}

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 min-w-0">
        {/* desktop rail / mobile horizontal swipeable navigation */}
        <nav className="mobile-nav w-full lg:w-[168px] h-[54px] lg:h-auto shrink-0 border-b lg:border-b-0 lg:border-r hairline bg-panel/90 lg:bg-panel/60 flex flex-row lg:flex-col px-1 py-1 lg:py-2 overflow-x-auto lg:overflow-y-auto overscroll-contain">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`shrink-0 min-w-[78px] lg:min-w-0 lg:w-auto mx-0.5 lg:mx-1.5 mb-0 lg:mb-0.5 flex flex-col lg:flex-row items-center justify-center lg:justify-start gap-0.5 lg:gap-2.5 rounded-md px-2 lg:px-2.5 py-1.5 lg:py-[7px] text-center lg:text-left transition-colors touch-manipulation ${tab === id ? "bg-info/10 text-info border border-info/25" : "text-ink2 hover:bg-panel2 hover:text-ink border border-transparent"}`}
            >
              <Icon size={14} className="shrink-0" />
              <span className="text-[8.5px] lg:text-[11px] font-medium leading-tight whitespace-nowrap">{label.replace(" Intelligence", "")}</span>
            </button>
          ))}
          <div className="hidden lg:block flex-1" />
          <div className="hidden lg:block px-3 py-2 text-[8.5px] leading-relaxed text-ink3">
            Decision support only — not investment advice. No signal guarantees profit.
          </div>
        </nav>

        {/* main column */}
        <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {/* responsive instrument toolbar */}
          <div className="instrument-toolbar shrink-0 border-b hairline bg-panel/60 flex flex-wrap items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2">
            <InstrumentSearch onPick={pickSymbol} current={symbol} />
            <div className="leading-none min-w-0">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="text-[13px] sm:text-[14px] font-bold tracking-wide">{symbol}</span>
                <Chip tone={bundle.data?.kind === "index" ? "violet" : "info"}>{bundle.data?.kind ?? "…"}</Chip>
                <Chip tone="mute" className="hidden sm:inline-flex">{bundle.data?.sector ?? "…"}</Chip>
              </div>
              <div className="hidden sm:block text-[9px] text-ink3 mt-1 tracking-wide truncate max-w-[180px] xl:max-w-[220px]">{bundle.data?.label ?? ""}</div>
            </div>
            <div className="hidden sm:block h-6 w-px bg-line" />
            <div className="flex items-baseline gap-1.5">
              <span className={`num text-[16px] sm:text-[18px] font-bold ${changeColor(bundle.data?.last?.changePct)}`}>{fmtPx(bundle.data?.last?.price)}</span>
              <span className={`num text-[10px] sm:text-[11px] ${changeColor(bundle.data?.last?.changePct)}`}>{fmtPct(bundle.data?.last?.changePct)}</span>
            </div>
            <div className="hidden lg:block flex-1" />
            <div className="order-last sm:order-none w-full sm:w-auto flex items-center rounded-md border hairline2 overflow-x-auto">
              {TIMEFRAME_LIST.map((m) => (
                <button
                  key={m}
                  onClick={() => setTf(m)}
                  className={`flex-1 sm:flex-none h-8 sm:h-7 min-w-[42px] px-2 sm:px-2.5 text-[10.5px] font-semibold border-r hairline last:border-r-0 touch-manipulation ${tf === m ? "bg-info/15 text-info" : "text-ink3 hover:text-ink bg-panel2"}`}
                >
                  {m}m
                </button>
              ))}
            </div>
            <Chip tone={bundle.data?.fmpi?.classification === "STRONG" || bundle.data?.fmpi?.classification === "VERY_STRONG" ? "up" : "mute"} title="FMPI classification" className="hidden md:inline-flex">
              FMPI {bundle.data?.fmpi?.score?.toFixed(1) ?? "—"}
            </Chip>
            <Chip tone={stateTone(bundle.data?.movement?.state)} className="hidden xl:inline-flex">{(bundle.data?.movement?.state ?? "…").replace(/_/g, " ")}</Chip>
          </div>

          {/* panel viewport scrolls naturally on mobile, remains terminal-like on desktop */}
          <div className="terminal-content flex-1 min-h-0 overflow-y-auto lg:overflow-hidden overflow-x-hidden p-1.5 sm:p-2.5 pb-[calc(0.375rem+env(safe-area-inset-bottom))]">
            {tab === "overview" && <OverviewPanel overview={overview.data} onPick={pickSymbol} />}
            {tab === "workspace" && <WorkspacePanel {...panelProps} />}
            {tab === "liquidity" && <LiquidityPanel {...panelProps} />}
            {tab === "depth" && <DepthPanel {...panelProps} />}
            {tab === "intelligence" && <IntelligencePanel {...panelProps} />}
            {tab === "sr" && <SRPanel bundle={bundle.data} />}
            {tab === "fmpi" && <FmpiPanel {...panelProps} />}
            {tab === "scanner" && <ScannerPanel onPick={pickSymbol} />}
            {tab === "derivatives" && <DerivativesPanel {...panelProps} />}
            {tab === "news" && <NewsPanel symbol={symbol} onPick={pickSymbol} />}
            {tab === "trades" && <TradesPanel {...panelProps} />}
            {tab === "alerts" && <AlertsPanel {...panelProps} />}
            {tab === "replay" && <BacktestPanel {...panelProps} />}
            {tab === "settings" && <SettingsPanel {...panelProps} onPick={pickSymbol} />}
          </div>
        </main>
      </div>
    </div>
  );
}
