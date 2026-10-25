/**
 * MODULE E — Buyer/seller absorption detector.
 *
 * Absorption is a HYPOTHESIS about passive liquidity absorbing aggressive
 * flow. It requires multiple independent pieces of evidence.
 *
 * CRITICAL DATA DEPENDENCY (from capabilities.ts):
 * The verified-elevation clause requires trade-level aggressive volume, which
 * the current Upstox REST feed does NOT supply. Therefore the "verified flow
 * elevated" evidence item is reported as MISSING, and the detector can never
 * reach a confirmed grade on this feed. It reports the structural/price
 * evidence that IS available and explicitly lists the missing input, rather
 * than inventing a flow proxy.
 *
 * We never claim an iceberg or hidden order was detected — order-book
 * replenishment and cancellations cannot be observed reliably on a top-5
 * snapshot feed.
 */

import type { Candle, Zone } from "./types";
import type { FlowAggregate } from "./flow";

export type AbsorptionSide = "BUYER" | "SELLER";

export interface AbsorptionEvidence {
  key: string;
  label: string;
  present: boolean;
  detail: string;
  /** true when this evidence cannot be evaluated on the current feed */
  unavailable?: boolean;
}

export type EvidenceGrade = "NONE" | "WEAK" | "MODERATE" | "STRONG";

export interface AbsorptionCandidate {
  side: AbsorptionSide;
  detected: boolean;
  grade: EvidenceGrade;
  evidence: AbsorptionEvidence[];
  presentCount: number;
  requiredCount: number;
  zoneType: string | null;
  zoneRange: [number, number] | null;
  confirmationLevel: number | null;
  invalidationLevel: number | null;
  ts: number;
  dataFreshness: "LIVE_CANDLES" | "STALE" | "UNAVAILABLE";
  note: string;
}

export interface AbsorptionConfig {
  /** how many independent evidence items are required for a candidate */
  minEvidence: number;
  /** max upward progress (in ATR) for seller absorption near resistance */
  maxProgressAtr: number;
  /** failed holds required above/below the zone */
  minFailedHolds: number;
  /** window in candles over which to look for failed holds */
  holdWindow: number;
}

export const DEFAULT_ABSORPTION_CONFIG: AbsorptionConfig = {
  minEvidence: 3,
  maxProgressAtr: 0.6,
  minFailedHolds: 2,
  holdWindow: 12,
};

/**
 * Detect potential absorption near an existing zone.
 *
 * Seller absorption (resistance): aggressive buying into a zone that fails to
 * make upward progress. Buyer absorption (support): aggressive selling into a
 * zone that fails to make downward progress.
 */
export function detectAbsorption(
  input: {
    candles: Candle[];
    zones: Zone[];
    atr: number;
    flow: FlowAggregate;
    price: number;
  },
  cfg: AbsorptionConfig = DEFAULT_ABSORPTION_CONFIG,
): { buyer: AbsorptionCandidate; seller: AbsorptionCandidate } {
  const { candles, zones, atr, flow, price } = input;
  const done = candles.filter((c) => !c.live);
  const ts = done.length ? done[done.length - 1].ts : Date.now();
  const window = done.slice(-cfg.holdWindow);

  const evaluate = (side: AbsorptionSide): AbsorptionCandidate => {
    const isBuyer = side === "BUYER";
    // buyer absorption happens at SUPPORT (selling absorbed)
    const zone = zones
      .filter((z) => z.status !== "INVALIDATED" && z.side === (isBuyer ? "support" : "resistance"))
      .filter((z) => price >= z.bottom - atr && price <= z.top + atr)
      .sort((a, b) => Math.abs(price - a.mid) - Math.abs(price - b.mid))[0];

    const evidence: AbsorptionEvidence[] = [];
    const base = {
      side, detected: false, grade: "NONE" as EvidenceGrade, evidence,
      presentCount: 0, requiredCount: cfg.minEvidence,
      zoneType: zone?.type ?? null,
      zoneRange: zone ? ([zone.bottom, zone.top] as [number, number]) : null,
      confirmationLevel: null as number | null,
      invalidationLevel: null as number | null,
      ts,
      dataFreshness: (done.length ? "LIVE_CANDLES" : "UNAVAILABLE") as AbsorptionCandidate["dataFreshness"],
      note: "",
    };
    if (!zone) {
      evidence.push({ key: "zone", label: "Liquidity zone in proximity", present: false, detail: `No ${isBuyer ? "support" : "resistance"} zone within 1×ATR of price.` });
      return { ...base, note: "No nearby zone — absorption hypothesis not evaluable." };
    }

    // --- evidence 1: elevated aggressive flow into the zone -----------------
    // Requires trade-level aggressor data. On the current feed this is
    // UNSUPPORTED, so it is reported as missing rather than proxied.
    const flowElevated = flow.supported && flow.delta != null
      ? (isBuyer ? flow.delta < 0 : flow.delta > 0) && Math.abs(flow.delta) > 0
      : false;
    evidence.push({
      key: "aggressiveFlow",
      label: isBuyer ? "Elevated aggressive selling into support" : "Elevated aggressive buying into resistance",
      present: flowElevated,
      unavailable: !flow.supported,
      detail: flow.supported
        ? `Verified flow delta ${flow.delta?.toFixed(0)} over the session.`
        : "MISSING — requires trade-level aggressor data, which the current Upstox REST feed does not supply. Not approximated.",
    });

    // --- evidence 2: limited price progress -------------------------------
    const progress = isBuyer
      ? Math.min(...window.map((c) => c.low)) - zone.bottom   // how far below support
      : zone.top - Math.max(...window.map((c) => c.high));    // how far above resistance
    // "limited progress" = price did NOT push decisively through the zone
    const limitedProgress = progress < atr * cfg.maxProgressAtr;
    evidence.push({
      key: "limitedProgress",
      label: "Limited price progress beyond the zone",
      present: limitedProgress,
      detail: `Net progress beyond the zone over the last ${cfg.holdWindow} candles is ${(progress / atr).toFixed(2)}×ATR (threshold ${cfg.maxProgressAtr}×ATR).`,
    });

    // --- evidence 3: repeated failure to hold beyond the zone -------------
    let failedHolds = 0;
    for (const c of window) {
      if (isBuyer) {
        // candle traded below support but closed back above it
        if (c.low < zone.bottom && c.close > zone.bottom) failedHolds++;
      } else {
        // candle traded above resistance but closed back below it
        if (c.high > zone.top && c.close < zone.top) failedHolds++;
      }
    }
    const repeatedFailure = failedHolds >= cfg.minFailedHolds;
    evidence.push({
      key: "repeatedFailure",
      label: isBuyer ? "Repeated failure to hold below support" : "Repeated failure to hold above resistance",
      present: repeatedFailure,
      detail: `${failedHolds} candle(s) breached the zone and closed back inside (threshold ${cfg.minFailedHolds}).`,
    });

    // --- evidence 4: rejection wick dominance -----------------------------
    const wicks = window.map((c) => {
      const range = Math.max(c.high - c.low, 1e-9);
      return isBuyer ? (Math.min(c.open, c.close) - c.low) / range : (c.high - Math.max(c.open, c.close)) / range;
    });
    const avgWick = wicks.reduce((a, b) => a + b, 0) / Math.max(1, wicks.length);
    const wickDominant = avgWick >= 0.5;
    evidence.push({
      key: "rejectionWick",
      label: isBuyer ? "Lower-wick dominance at support" : "Upper-wick dominance at resistance",
      present: wickDominant,
      detail: `Average ${isBuyer ? "lower" : "upper"} wick is ${(avgWick * 100).toFixed(0)}% of candle range over the window.`,
    });

    // --- evidence 5: volume elevation (candle volume, NOT aggressor flow) --
    // This is total traded volume from candles — a distinct, weaker signal
    // from aggressor-side flow, and labelled as such.
    const vols = window.map((c) => c.volume);
    const volMean = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const priorVols = done.slice(Math.max(0, done.length - cfg.holdWindow * 2), done.length - cfg.holdWindow).map((c) => c.volume);
    const priorMean = priorVols.length ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length : volMean;
    const volumeElevated = priorMean > 0 && volMean > priorMean * 1.2;
    evidence.push({
      key: "volumeElevation",
      label: "Total traded volume elevated (candle volume, not aggressor flow)",
      present: volumeElevated,
      detail: `Window volume ${volMean.toFixed(0)} vs prior-window ${priorMean.toFixed(0)}.`,
    });

    const presentCount = evidence.filter((e) => e.present).length;
    const detected = presentCount >= cfg.minEvidence;
    const grade: EvidenceGrade =
      presentCount >= 5 ? "STRONG" : presentCount >= 4 ? "MODERATE" : presentCount >= cfg.minEvidence ? "WEAK" : "NONE";

    const zoneR: [number, number] | null = zone ? [zone.bottom, zone.top] : null;
    return {
      ...base,
      zoneRange: zoneR,
      detected,
      grade,
      evidence,
      presentCount,
      requiredCount: cfg.minEvidence,
      confirmationLevel: isBuyer ? zone.top + atr * 0.25 : zone.bottom - atr * 0.25,
      invalidationLevel: isBuyer ? zone.bottom - atr * 0.5 : zone.top + atr * 0.5,
      note: detected
        ? `Potential ${side.toLowerCase()} absorption near ${zone.type}: ${presentCount} of 5 evidence items present. This is a HYPOTHESIS about passive liquidity absorbing aggressive flow — not proof of a hidden or iceberg order.`
        : `Insufficient evidence for ${side.toLowerCase()} absorption (${presentCount}/${cfg.minEvidence}). ${
            evidence.find((e) => e.unavailable && !e.present) ? "One required input (aggressor-side flow) is unavailable on this feed, so the maximum achievable grade is capped. " : ""
          }No directional conclusion is drawn.`,
    };
  };

  return { buyer: evaluate("BUYER"), seller: evaluate("SELLER") };
}
