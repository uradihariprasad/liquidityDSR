"use client";

import { Panel, Chip, EvidenceList, EmptyState, Row } from "@/components/ui";
import PriceChart from "@/components/PriceChart";
import { fmtPx, fmtBig, fmtTimeShort } from "@/lib/client/api";
import type { PanelProps } from "./common";

const ZONE_STATUS_TONE: Record<string, string> = {
  NEW: "mute", APPROACHING: "info", TESTING: "warn", HOLDING: "up", REJECTED: "up",
  BROKEN: "down", RECLAIMED: "violet", POTENTIALLY_SWEPT: "warn", INVALIDATED: "mute",
};

function ZoneRow({ z }: { z: any }) {
  return (
    <div className="border-b hairline/50 py-2 last:border-b-0">
      <div className="flex items-center gap-2 flex-wrap">
        <Chip tone={z.side === "resistance" ? "down" : "up"}>{z.type}</Chip>
        <span className="num text-[11.5px] font-semibold">{fmtPx(z.bottom)} – {fmtPx(z.top)}</span>
        <span className="flex-1" />
        <span className="num text-[10px] text-ink3">str {z.strength}</span>
        <Chip tone={(ZONE_STATUS_TONE[z.status] ?? "mute") as any}>{z.status.replace(/_/g, " ")}</Chip>
      </div>
      <div className="mt-1 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[9.5px] text-ink3">
        <span>tests <span className="num text-ink2">{z.tests}</span></span>
        <span>reactions <span className="num text-ink2">{z.reactions}</span></span>
        <span>liq. side <span className="num text-ink2">{z.liquiditySide ?? "—"}</span></span>
        <span>upd <span className="num text-ink2">{fmtTimeShort(z.updatedTs)}</span></span>
      </div>
      <div className="mt-1 text-[10px] text-ink3 leading-snug">{z.source}</div>
      <div className="mt-0.5 text-[10px] text-ink2/80 leading-snug">{z.statusReason}</div>
      <div className="mt-0.5 text-[9.5px] text-warn/70 leading-snug">invalidation: {z.invalidation}</div>
    </div>
  );
}

function ProfileChart({ profile, currentPrice }: { profile: any; currentPrice: number }) {
  if (!profile) return <EmptyState title="Volume profile unavailable" detail="Needs ≥20 completed candles and a valid ATR." />;
  const max = Math.max(...profile.bins.map((b: any) => b.volume), 1);
  const binStep = profile.bins.length > 1 ? Math.abs(profile.bins[1].price - profile.bins[0].price) : 1;
  return (
    <div className="space-y-[2px]">
      <div className="flex items-center justify-between text-[9.5px] text-ink3 pb-1">
        <span>method: {profile.method} {profile.approximation ? "(approximation — volume allocated uniformly across each candle's range)" : ""}</span>
        <span>VA {Math.round((profile.valueAreaPct ?? 0.7) * 100)}%</span>
      </div>
      {profile.bins.slice().reverse().map((bin: any, i: number) => {
        const isPOC = Math.abs(bin.price - profile.poc) < binStep / 2;
        const inVA = bin.price <= profile.vah && bin.price >= profile.val;
        const nearPrice = Math.abs(bin.price - currentPrice) < binStep / 2;
        return (
          <div key={i} className="flex items-center gap-1.5 group">
            <span className={`num text-[8.5px] w-[64px] text-right shrink-0 ${nearPrice ? "text-info font-bold" : "text-ink3"}`}>{fmtPx(bin.price, 1)}</span>
            <div className="flex-1 h-[9px] rounded-sm overflow-hidden bg-panel3/50">
              <div
                className={`h-full rounded-sm ${isPOC ? "bg-violet" : inVA ? "bg-info/70" : "bg-line2"}`}
                style={{ width: `${(bin.volume / max) * 100}%` }}
                title={`vol ${fmtBig(bin.volume)}`}
              />
            </div>
            <span className="num text-[8px] text-ink3 w-[44px] shrink-0">{fmtBig(bin.volume)}</span>
          </div>
        );
      })}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5 pt-2">
        {[["POC", profile.poc, "text-violet"], ["VAH", profile.vah, "text-info"], ["VAL", profile.val, "text-info"], ["HVN", profile.hvns?.[0], "text-warn"], ["LVN", profile.lvns?.[0], "text-cyan"]].map(([k, v, c]: any) => (
          <div key={k} className="rounded border hairline bg-panel2 px-1.5 py-1 text-center">
            <div className="text-[8px] text-ink3">{k}</div>
            <div className={`num text-[11px] font-semibold ${c}`}>{fmtPx(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SWEEP_TONE: Record<string, any> = { CONFIRMED: "warn", DETECTED: "info", FAILED: "down", EXPIRED: "mute" };

function SweepCard({ s }: { s: any }) {
  return (
    <div className="rounded-md border hairline bg-panel2 px-2.5 py-2">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip tone={SWEEP_TONE[s.state]}>{s.state}</Chip>
        <Chip tone={s.direction === "BULLISH" ? "up" : "down"}>{s.direction}</Chip>
        <span className="text-[10.5px] font-semibold">{s.side === "HIGH" ? "buy-side" : "sell-side"} @ <span className="num">{fmtPx(s.level)}</span></span>
        <span className="text-[9.5px] text-ink3 ml-auto num">{fmtTimeShort(s.ts)}</span>
      </div>
      <div className="mt-1 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[9.5px] text-ink3">
        <span>penetration <span className="num text-ink2">{s.penetrationAtr.toFixed(2)}×ATR</span></span>
        <span>rejection wick <span className="num text-ink2">{(s.wickRatio * 100).toFixed(0)}%</span></span>
        <span>relVol <span className="num text-ink2">{s.relVol != null ? `${s.relVol.toFixed(2)}×` : "n/a"}</span></span>
      </div>
      <div className="mt-1 text-[10px] text-ink2 leading-snug">{s.note}</div>
      <div className="mt-1 text-[9.5px] text-warn/80 leading-snug">{s.invalidation}</div>
    </div>
  );
}

export default function LiquidityPanel({ bundle }: PanelProps) {
  const b = bundle;
  const zones = b?.zones ?? [];
  const active = zones.filter((z: any) => z.status !== "INVALIDATED");
  const price = b?.last?.price ?? 0;
  const above = active.filter((z: any) => z.mid > price).sort((x: any, y: any) => x.mid - y.mid);
  const below = active.filter((z: any) => z.mid <= price).sort((x: any, y: any) => y.mid - x.mid);

  return (
    <div className="h-full grid grid-cols-12 gap-2.5 fade-up">
      <div className="col-span-12 xl:col-span-5 flex flex-col gap-2.5 min-h-0">
        <Panel title={`Liquidity zones — ${active.length} active · ${zones.length - active.length} invalidated`} className="flex-1 min-h-[320px]">
          <div className="mb-2 text-[10px] text-ink3 leading-snug rounded border hairline bg-panel2 px-2 py-1.5">
            Zones are derived from <span className="text-ink2">historical price structure</span> (swings, equal highs/lows, PDH/PDL, opening range, volume profile approximation) — they are potential reaction areas, not proof of resting orders. A POTENTIALLY SWEPT state marks a breach-and-reclaim pattern, never confirmed stop-loss execution.
          </div>
          <div className="grid grid-cols-2 gap-x-4">
            <div>
              <div className="panel-label mb-1 sticky top-0 bg-panel py-1">buy-side liquidity / resistance (above)</div>
              {above.map((z: any) => <ZoneRow key={z.id} z={z} />)}
            </div>
            <div>
              <div className="panel-label mb-1 sticky top-0 bg-panel py-1">sell-side liquidity / support (below)</div>
              {below.map((z: any) => <ZoneRow key={z.id} z={z} />)}
            </div>
          </div>
        </Panel>
      </div>

      <div className="col-span-12 xl:col-span-4 flex flex-col gap-2.5 min-h-0">
        <Panel
          title={`Volume profile · ${b?.profile?.period === "MULTI_SESSION" ? `${b?.profile?.sessionCount ?? 0} sessions` : "single session"} · ${b?.profile?.timeframe ?? "—"}`}
          className="flex-1 min-h-[320px]"
          right={
            <Chip tone={b?.profile?.consistency?.valLeVah && b?.profile?.consistency?.pocInRange ? "up" : "down"}
              title="VAL ≤ VAH · POC inside profile range · bins valid"
            >
              {b?.profile ? "consistent" : "n/a"}
            </Chip>
          }
        >
          <ProfileChart profile={b?.profile} currentPrice={price} />
          {b?.profile && (
            <div className="mt-2 rounded-md border hairline bg-panel2 px-2.5 py-2">
              <Chip tone="info">{b.profile.position.replace(/_/g, " ")}</Chip>
              <div className="text-[10.5px] text-ink2 mt-1.5 leading-snug">{b.profile.positionDetail}</div>
              <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[9px] text-ink3">
                <span>period <span className="text-ink2">{b.profile.period}</span></span>
                <span>sessions <span className="num text-ink2">{b.profile.sessionCount}</span></span>
                <span>from <span className="num text-ink2">{fmtTimeShort(b.profile.fromTs)}</span></span>
                <span>to <span className="num text-ink2">{fmtTimeShort(b.profile.toTs)}</span></span>
                <span>candles <span className="num text-ink2">{b.profile.candlesUsed}</span> (completed)</span>
                <span>bins <span className="num text-ink2">{b.profile.binCount}</span> @ <span className="num text-ink2">{b.profile.binSize?.toFixed(2)}</span></span>
                <span>tick <span className="num text-ink2">{b.profile.tickSize ?? "—"}</span></span>
                <span>calc <span className="num text-ink2">{fmtTimeShort(b.profile.calculatedAt)}</span></span>
              </div>
              <div className="mt-1 text-[9px] text-warn/80 leading-snug">
                Uniform-allocation APPROXIMATION from OHLCV candles — candle volume is spread evenly across each
                candle&apos;s range, so this is not exact traded volume at each price.
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="col-span-12 xl:col-span-3 flex flex-col gap-2.5">
        <Panel title="Zone map on chart" className="flex-1" pad={false}>
          <div className="p-2 h-full">
            {b?.candles?.length ? <PriceChart bundle={b} height={330} showEma={false} showVwap={false} showZones showEvents={false} showScenario={false} /> : <EmptyState title="No chart data" />}
          </div>
        </Panel>
        <Panel
          title="Liquidity sweep engine"
          className="shrink-0 max-h-[290px]"
          right={<Chip tone={b?.activeSweep ? (b.activeSweep.state === "CONFIRMED" ? "warn" : "info") : "mute"}>{b?.activeSweep ? `active: ${b.activeSweep.state}` : "no active sweep"}</Chip>}
        >
          <div className="text-[9.5px] text-ink3 leading-snug mb-2">
            Criteria: breach of the 10-candle extreme by 0.08–1.20×ATR · rejection close back through the level · ≥50% rejection wick · participation recorded when available · CONFIRMED only after follow-through within 6 candles.
          </div>
          <div className="space-y-1.5">
            {(b?.sweeps ?? []).slice().reverse().slice(0, 6).map((s: any) => <SweepCard key={s.id} s={s} />)}
            {!(b?.sweeps ?? []).length && (
              <EmptyState title="No sweep candidates" detail="No candle has met the full breach-and-reclaim criteria in the visible window — single wicks are deliberately not counted as sweeps." />
            )}
          </div>
        </Panel>

        <Panel title="Liquidity layers — what this map does and does not show" className="shrink-0">
          <div className="space-y-1.5">
            {[
              {
                name: "Layer A · Price-structure liquidity",
                avail: true,
                detail: `Derived from this instrument's own candles: swings, equal highs/lows, PDH/PDL, PWH/PWL, opening range, consolidation edges and volume-profile levels. ${active.length} active zones shown.`,
                caveat: "Price-structure inference — NOT proof of resting orders.",
              },
              {
                name: "Layer B · Displayed order-book liquidity",
                avail: b?.depth?.available === true,
                detail: b?.depth?.available
                  ? `Live bid/ask levels for ${b.kind === "index" ? `the mapped futures contract (${(b as any).instrumentKeys?.futures ?? "futures"})` : b.symbol}: ${b.depth.levels.length} level(s), OBI ${b.depth.obi?.toFixed(3) ?? "—"}, updated ${fmtTimeShort(b.depth.ts ?? undefined)}.`
                  : "Not available for this instrument right now (see Order Flow & Depth for the exact reason).",
                caveat: "Displayed (resting) liquidity only — a disappearing order is not proof of execution.",
              },
              {
                name: "Layer C · Executed buyer/seller volume",
                avail: false,
                detail: "Requires trade-level data with aggressor-side classification, which the Upstox quote/depth API does not expose. Not computed, not estimated.",
                caveat: "Unavailable by data capability — never inferred from displayed depth.",
              },
            ].map((l) => (
              <div key={l.name} className="flex items-start gap-2 rounded border hairline bg-panel2 px-2 py-1.5">
                <Chip tone={l.avail ? "up" : "mute"} className="shrink-0 mt-0.5">{l.avail ? "active" : "n/a"}</Chip>
                <div className="min-w-0">
                  <div className="text-[10.5px] font-semibold">{l.name}</div>
                  <div className="text-[9.5px] text-ink2 leading-snug mt-0.5">{l.detail}</div>
                  <div className="text-[9px] text-warn/80 leading-snug mt-0.5">{l.caveat}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Day reference levels" className="shrink-0">
          <Row k="Previous day high" v={fmtPx(b?.day?.prevHigh)} tone="text-up" />
          <Row k="Previous day low" v={fmtPx(b?.day?.prevLow)} tone="text-down" />
          <Row k="Previous week high" v={fmtPx(b?.day?.prevWeekHigh)} tone="text-up" />
          <Row k="Previous week low" v={fmtPx(b?.day?.prevWeekLow)} tone="text-down" />
          <Row k="Opening range (15m)" v={b?.day?.orHigh ? `${fmtPx(b?.day?.orLow)} – ${fmtPx(b?.day?.orHigh)}` : "—"} />
          <Row k="POC / VAH / VAL" v={b?.profile ? `${fmtPx(b?.profile?.poc)} / ${fmtPx(b?.profile?.vah)} / ${fmtPx(b?.profile?.val)}` : "—"} />
        </Panel>
      </div>
    </div>
  );
}
