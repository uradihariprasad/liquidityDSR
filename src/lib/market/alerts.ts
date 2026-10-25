/**
 * Alert engine. Rules are evaluated against computed analysis bundles.
 * Deduplication: a rule fires at most once per (dedupeKey) within its
 * cooldown — the same unchanged condition never re-alerts.
 */

import type { AnalysisBundle } from "./types";

export interface AlertEventData {
  ts: number;
  symbol: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  message: string;
  price: number | null;
  detail: Record<string, unknown>;
  dedupeKey: string;
  cooldownSec: number;
}

const fired = new Map<string, number>(); // dedupeKey -> last fired epoch ms

export function alertDedupeRemainingMs(key: string, cooldownSec: number, now: number): number {
  const last = fired.get(key);
  if (!last) return 0;
  return Math.max(0, cooldownSec * 1000 - (now - last));
}

export function evaluateAlertRules(b: AnalysisBundle, opts?: { fmpiHigh?: number; fmpiLow?: number; now?: number }): AlertEventData[] {
  const now = opts?.now ?? Date.now();
  const fmpiHigh = opts?.fmpiHigh ?? 70;
  const fmpiLow = opts?.fmpiLow ?? 30;
  const out: AlertEventData[] = [];
  const price = b.last.price;

  // FMPI threshold crossing (hysteresis via bucketed key)
  if (b.fmpi.score >= fmpiHigh) {
    out.push({ ts: now, symbol: b.symbol, kind: "FMPI_HIGH", severity: b.fmpi.direction === "NEUTRAL" ? "info" : "warning", message: `FMPI ${b.fmpi.score.toFixed(1)} crossed above ${fmpiHigh} (${b.fmpi.direction}, ${b.fmpi.state})`, price, detail: { fmpi: b.fmpi.score, direction: b.fmpi.direction }, dedupeKey: `${b.symbol}:FMPI_HIGH:${b.tf}`, cooldownSec: 1800 });
  }
  if (b.fmpi.score > 0 && b.fmpi.score <= fmpiLow) {
    out.push({ ts: now, symbol: b.symbol, kind: "FMPI_LOW", severity: "info", message: `FMPI ${b.fmpi.score.toFixed(1)} fell below ${fmpiLow} — momentum quality poor`, price, detail: { fmpi: b.fmpi.score }, dedupeKey: `${b.symbol}:FMPI_LOW:${b.tf}`, cooldownSec: 1800 });
  }
  if (b.fmpi.state === "STRENGTHENING") {
    out.push({ ts: now, symbol: b.symbol, kind: "MOMENTUM_STRENGTHENING", severity: "info", message: `Momentum strengthening — FMPI ${b.fmpi.score.toFixed(1)} ${b.fmpi.direction}`, price, detail: {}, dedupeKey: `${b.symbol}:MOM_STR:${b.tf}`, cooldownSec: 3600 });
  }
  if (b.fmpi.state === "WEAKENING") {
    out.push({ ts: now, symbol: b.symbol, kind: "MOMENTUM_WEAKENING", severity: "info", message: `Momentum weakening — FMPI ${b.fmpi.score.toFixed(1)}`, price, detail: {}, dedupeKey: `${b.symbol}:MOM_WKN:${b.tf}`, cooldownSec: 3600 });
  }

  // movement state events
  const state = b.movement.state;
  const stateAlert: Record<string, { sev: AlertEventData["severity"]; msg: string } | undefined> = {
    CONFIRMED_UPSIDE_BREAKOUT: { sev: "warning", msg: "Confirmed upside breakout" },
    CONFIRMED_DOWNSIDE_BREAKDOWN: { sev: "warning", msg: "Confirmed downside breakdown" },
    FAILED_BREAKOUT: { sev: "warning", msg: "Failed breakout detected" },
    FAILED_BREAKDOWN: { sev: "warning", msg: "Failed breakdown detected" },
    POTENTIAL_LIQUIDITY_SWEEP: { sev: "warning", msg: "Potential liquidity sweep (breach-and-reclaim; unconfirmed)" },
    POTENTIAL_BULLISH_REVERSAL: { sev: "info", msg: "Potential bullish reversal developing" },
    POTENTIAL_BEARISH_REVERSAL: { sev: "info", msg: "Potential bearish reversal developing" },
    CONFIRMED_STRUCTURAL_SHIFT: { sev: "warning", msg: "Confirmed structural shift (CHOCH + follow-through)" },
    CONFLICTING_SIGNALS: { sev: "info", msg: "Conflicting signals — evidence split" },
  };
  const sa = stateAlert[state];
  if (sa) {
    out.push({ ts: now, symbol: b.symbol, kind: `STATE_${state}`, severity: sa.sev, message: `${sa.msg} on ${b.symbol} @ ${price.toFixed(2)}`, price, detail: { state, bias: b.movement.bias }, dedupeKey: `${b.symbol}:STATE:${state}:${b.tf}`, cooldownSec: 3600 });
  }

  // zone events
  for (const z of b.zones) {
    if (z.status === "TESTING") out.push({ ts: now, symbol: b.symbol, kind: "ZONE_TESTING", severity: "info", message: `${z.type} zone ${z.bottom.toFixed(1)}–${z.top.toFixed(1)} under test (strength ${z.strength})`, price, detail: { zone: z.id, type: z.type }, dedupeKey: `${b.symbol}:ZT:${z.id}`, cooldownSec: 1800 });
    if (z.status === "REJECTED") out.push({ ts: now, symbol: b.symbol, kind: "ZONE_REJECTED", severity: "info", message: `${z.type} zone ${z.bottom.toFixed(1)}–${z.top.toFixed(1)} rejected (${z.reactions} reactions)`, price, detail: { zone: z.id }, dedupeKey: `${b.symbol}:ZR:${z.id}`, cooldownSec: 3600 });
    if (z.status === "POTENTIALLY_SWEPT") out.push({ ts: now, symbol: b.symbol, kind: "ZONE_SWEPT", severity: "warning", message: `${z.type} zone ${z.bottom.toFixed(1)}–${z.top.toFixed(1)} shows breach-and-reclaim (potential sweep)`, price, detail: { zone: z.id }, dedupeKey: `${b.symbol}:ZS:${z.id}`, cooldownSec: 3600 });
    if (z.status === "BROKEN") out.push({ ts: now, symbol: b.symbol, kind: "ZONE_BROKEN", severity: "warning", message: `${z.type} zone ${z.bottom.toFixed(1)}–${z.top.toFixed(1)} broken by a decisive close`, price, detail: { zone: z.id }, dedupeKey: `${b.symbol}:ZB:${z.id}`, cooldownSec: 3600 });
    if (z.status === "RECLAIMED") out.push({ ts: now, symbol: b.symbol, kind: "ZONE_RECLAIMED", severity: "info", message: `${z.type} zone ${z.bottom.toFixed(1)}–${z.top.toFixed(1)} reclaimed after a break — possible failed break`, price, detail: { zone: z.id }, dedupeKey: `${b.symbol}:ZRC:${z.id}`, cooldownSec: 3600 });
  }

  // scenario events
  if (b.scenario.status === "ENTRY_CONDITION_MET") {
    out.push({ ts: now, symbol: b.symbol, kind: "SCENARIO_CONFIRMED", severity: "warning", message: `${b.scenario.setup} scenario confirmed (${b.scenario.direction}, RR ${b.scenario.rr}, entry ${b.scenario.entryZone?.[0].toFixed(1) ?? "—"})`, price, detail: { setup: b.scenario.setup }, dedupeKey: `${b.symbol}:SCEN:${b.scenario.setup}:${b.tf}`, cooldownSec: 3600 });
  }

  // feed health
  if (b.quality.status === "STALE" || b.quality.status === "UNAVAILABLE") {
    out.push({ ts: now, symbol: b.symbol, kind: "FEED_HEALTH", severity: "critical", message: `Data-feed problem on ${b.symbol}: ${b.quality.status}`, price: null, detail: { warnings: b.quality.warnings }, dedupeKey: `${b.symbol}:FEED`, cooldownSec: 600 });
  }

  // apply cooldowns (pure w.r.t. map state)
  return out.filter((e) => alertDedupeRemainingMs(e.dedupeKey, e.cooldownSec, now) === 0);
}

export function markFired(events: AlertEventData[], now = Date.now()): void {
  for (const e of events) fired.set(e.dedupeKey, now);
  if (fired.size > 5000) {
    const keys = [...fired.keys()].slice(0, 2000);
    for (const k of keys) fired.delete(k);
  }
}
