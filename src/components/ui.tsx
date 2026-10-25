"use client";

import type { ReactNode } from "react";
import { fmtPx } from "@/lib/client/api";

export function Panel({ title, right, children, className = "", pad = true }: { title?: string; right?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-lg border hairline bg-panel flex flex-col min-h-0 ${className}`}>
      {title && (
        <header className="flex flex-wrap sm:flex-nowrap items-center justify-between gap-1.5 sm:gap-2 px-2.5 sm:px-3 min-h-9 py-1.5 border-b hairline shrink-0">
          <span className="panel-label min-w-0 leading-snug">{title}</span>
          <div className="flex items-center gap-1.5 sm:gap-2 max-w-full overflow-x-auto shrink-0">{right}</div>
        </header>
      )}
      <div className={`${pad ? "p-3" : ""} flex-1 min-h-0 overflow-auto`}>{children}</div>
    </section>
  );
}

const TONES: Record<string, string> = {
  up: "text-up border-updim bg-up/10",
  down: "text-down border-downdim bg-down/10",
  warn: "text-warn border-warn/30 bg-warn/10",
  info: "text-info border-info/30 bg-info/10",
  mute: "text-ink2 border-line2 bg-panel2",
  violet: "text-violet border-violet/30 bg-violet/10",
  cyan: "text-cyan border-cyan/30 bg-cyan/10",
};

export function Chip({ tone = "mute", children, title, className = "" }: { tone?: keyof typeof TONES; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-[3px] text-[10px] font-semibold leading-none whitespace-nowrap ${TONES[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function Stat({ label, value, sub, tone, className = "" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[9.5px] uppercase tracking-[0.13em] text-ink3 font-semibold">{label}</div>
      <div className={`num text-[15px] font-semibold mt-0.5 truncate ${tone ?? "text-ink"}`}>{value}</div>
      {sub != null && <div className="text-[10px] text-ink3 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

export function QualityBanner({ quality }: { quality: any }) {
  if (!quality) return null;
  const live = quality.mode === "LIVE_UPSTOX";
  const ok = live && quality.status === "OK";
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-2.5 py-1.5 text-[10px] ${ok ? "border-updim bg-up/5 text-up" : "border-warn/30 bg-warn/5 text-warn"}`}>
      <span className="font-bold tracking-wider">{ok ? "LIVE UPSTOX FEED — REAL DATA" : live ? `LIVE FEED ${quality.status}` : "DISCONNECTED — NO DATA FETCHED"}</span>
      <span className="text-ink2">session: {quality.marketSession}</span>
      {quality.lastCandleTs && <span className="text-ink2">last candle {new Date(quality.lastCandleTs).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" })} IST</span>}
      {quality.warnings?.slice(0, 1).map((w: string, i: number) => <span key={i} className="text-ink3 truncate max-w-[520px]">{w}</span>)}
    </div>
  );
}

export function EvidenceList({ title, items, tone }: { title: string; items: string[]; tone: "up" | "down" | "warn" | "info" | "mute" }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="panel-label mb-1.5">{title}</div>
      <ul className="space-y-1">
        {items.map((s, i) => (
          <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-ink2">
            <span className={`mt-1.5 h-1 w-1 rounded-full shrink-0 ${tone === "up" ? "bg-up" : tone === "down" ? "bg-down" : tone === "warn" ? "bg-warn" : tone === "info" ? "bg-info" : "bg-ink3"}`} />
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Gauge({ score, direction, size = 132 }: { score: number; direction: string; size?: number }) {
  const r = size / 2 - 10;
  const cx = size / 2;
  const cy = size / 2 + 8;
  const angle = (score / 100) * 180;
  const polar = (a: number) => [cx + r * Math.cos(Math.PI - (a * Math.PI) / 180), cy - r * Math.sin(Math.PI - (a * Math.PI) / 180)];
  const [x1, y1] = polar(0);
  const [x2, y2] = polar(angle);
  const large = angle > 90 ? 1 : 0;
  const color = direction === "BULLISH" ? "#17c784" : direction === "BEARISH" ? "#ea3943" : "#f0b90b";
  return (
    <svg width={size} height={size / 2 + 26} className="block">
      <path d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#1a212c" strokeWidth="9" strokeLinecap="round" />
      {score > 0.5 && <path d={`M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round" />}
      <text x={cx} y={cy - 8} textAnchor="middle" fill="#d7dee7" fontSize="26" fontWeight="700" fontFamily="var(--font-mono)">{score.toFixed(1)}</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill="#55606f" fontSize="9" letterSpacing="2">FMPI</text>
    </svg>
  );
}

export function Spark({ data, width = 96, height = 26, tone = "#5aa2ff" }: { data: number[]; width?: number; height?: number; tone?: string }) {
  if (!data?.length) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / span) * (height - 3) - 1.5}`).join(" ");
  return (
    <svg width={width} height={height} className="block">
      <polyline points={pts} fill="none" stroke={tone} strokeWidth="1.4" />
    </svg>
  );
}

export function Bar({ values, labels, height = 120, tone = "#5aa2ff" }: { values: number[]; labels: string[]; height?: number; tone?: string }) {
  const max = Math.max(...values.map((v) => Math.abs(v)), 1e-9);
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {values.map((v, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0">
          <div className="w-full rounded-sm" style={{ height: `${Math.max(2, (Math.abs(v) / max) * (height - 18))}px`, background: tone, opacity: 0.85 }} title={`${labels[i]}: ${fmtPx(v, 0)}`} />
          <div className="text-[8px] text-ink3 truncate w-full text-center">{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Shown whenever a panel has no live data. It never leaves the panel blank:
 * it states the exact reason and what the user must do.
 */
export function FeedGate({ quality, what, extra }: { quality: any; what: string; extra?: string }) {
  const disconnected = !quality || quality.mode === "DISCONNECTED";
  return (
    <div className={`rounded-md border px-3 py-2.5 ${disconnected ? "border-warn/35 bg-warn/5" : "border-info/30 bg-info/5"}`}>
      <div className={`text-[12px] font-semibold ${disconnected ? "text-warn" : "text-info"}`}>
        {disconnected ? `${what} needs a live Upstox connection` : `${what} — waiting for live data`}
      </div>
      <div className="text-[10.5px] text-ink2 mt-1 leading-relaxed">
        {disconnected
          ? "This terminal is live-data-only — there is no demo feed. Use the “Connect Upstox” box at the top-left to paste your access token; the universe, charts and this panel activate immediately after validation."
          : (quality?.warnings?.[0] ?? "The feed returned no rows for this instrument yet.")}
      </div>
      {extra && <div className="text-[10px] text-ink3 mt-1.5 leading-relaxed">{extra}</div>}
      {quality?.marketSession && (
        <div className="text-[9.5px] text-ink3 mt-1.5">
          market session: <span className="num">{quality.marketSession}</span>
          {quality.marketSession === "CLOSED" && " — intraday channels (depth, option chain, intraday candles) populate during 09:15–15:30 IST."}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-8 px-4">
      <div className="text-[12px] font-semibold text-ink2">{title}</div>
      {detail && <div className="text-[10.5px] text-ink3 mt-1 max-w-sm leading-relaxed">{detail}</div>}
    </div>
  );
}

export function Row({ k, v, tone }: { k: string; v: ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-[3px]">
      <span className="text-[10.5px] text-ink3">{k}</span>
      <span className={`num text-[11px] font-medium ${tone ?? "text-ink"}`}>{v}</span>
    </div>
  );
}
