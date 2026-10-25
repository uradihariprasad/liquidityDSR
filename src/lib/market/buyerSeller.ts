/**
 * MODULE G — Unified buyer/seller intelligence.
 *
 * Combines depth (Module B), executed flow (Module C), zones (Module D),
 * absorption (Module E) and staged sweeps (Module F) into one evidence-based
 * verdict. It NEVER forces a directional conclusion when evidence conflicts
 * or required data is missing.
 *
 * Verdicts:
 *   BULLISH_EVIDENCE / BEARISH_EVIDENCE — multiple independent signals agree
 *   ABSORPTION_CANDIDATE                — absorption hypothesis has enough evidence
 *   LIQUIDITY_SWEEP_CANDIDATE           — a staged sweep is confirmed/reclaimed
 *   CONFLICTING_EVIDENCE                — signals disagree
 *   INSUFFICIENT_DATA                   — not enough valid data to conclude
 *
 * A displayed depth imbalance alone can NEVER produce a directional verdict.
 */

import type { Candle, Zone } from "./types";
import type { DepthSnapshot } from "./depth";
import type { FlowAggregate } from "./flow";
import type { AbsorptionCandidate } from "./absorption";
import type { StagedSweep } from "./sweepstages";
import { capabilityRegistry, type CapabilityRegistry } from "./capabilities";

export type IntelligenceVerdict =
  | "BULLISH_EVIDENCE"
  | "BEARISH_EVIDENCE"
  | "ABSORPTION_CANDIDATE"
  | "LIQUIDITY_SWEEP_CANDIDATE"
  | "CONFLICTING_EVIDENCE"
  | "INSUFFICIENT_DATA";

export interface IntelligenceSignal {
  key: string;
  label: string;
  /** the direction this signal leans, or null if non-directional */
  leans: "BULLISH" | "BEARISH" | null;
  strength: "STRONG" | "MODERATE" | "WEAK";
  available: boolean;
  unavailableReason?: string;
  detail: string;
  /** the data class this signal came from — kept distinct, never blended */
  dataClass: "DISPLAYED_DEPTH" | "EXECUTED_FLOW" | "PRICE_STRUCTURE" | "VOLUME_PROFILE";
}

export interface BuyerSellerIntelligence {
  verdict: IntelligenceVerdict;
  verdictReason: string;
  signals: IntelligenceSignal[];
  bullishCount: number;
  bearishCount: number;
  /** data channels actually available vs missing */
  channels: {
    depth: { available: boolean; state: string; reason: string };
    executedFlow: { available: boolean; state: string; reason: string };
    priceStructure: { available: boolean; state: string; reason: string };
  };
  depth: DepthSnapshot | null;
  flow: FlowAggregate;
  absorption: { buyer: AbsorptionCandidate; seller: AbsorptionCandidate };
  sweeps: StagedSweep[];
  activeSweep: StagedSweep | null;
  contract: {
    underlyingKey: string;
    underlyingLabel: string;
    underlyingPrice: number | null;
    /** the contract actually used for executable depth/flow */
    analysisContractKey: string | null;
    analysisContractLabel: string | null;
    analysisContractPrice: number | null;
    expiry: string | null;
    rolloverNote: string;
  };
  priceContext: {
    price: number;
    atr: number;
    structureTrend: string;
    movementState: string;
    vwap: number | null;
    relativeVolume: number | null;
  };
  freshness: {
    depthTs: number | null;
    depthAgeMs: number | null;
    depthStale: boolean;
    candleTs: number | null;
    flowSessionTo: number | null;
  };
  capabilities: CapabilityRegistry;
  generatedAt: number;
  disclaimers: string[];
}

export interface IntelligenceInput {
  symbol: string;
  underlyingLabel: string;
  underlyingKey: string;
  underlyingPrice: number | null;
  analysisContractKey: string | null;
  analysisContractLabel: string | null;
  analysisContractPrice: number | null;
  contractExpiry: string | null;
  rolloverNote: string;
  candles: Candle[];
  zones: Zone[];
  atr: number;
  depth: DepthSnapshot | null;
  flow: FlowAggregate;
  absorption: { buyer: AbsorptionCandidate; seller: AbsorptionCandidate };
  sweeps: StagedSweep[];
  structureTrend: string;
  movementState: string;
  vwap: number | null;
  relativeVolume: number | null;
}

const DISCLAIMERS = [
  "Displayed depth is resting liquidity from a top-5-level snapshot — it is not a full order book and not a diff stream.",
  "Executed aggressive buy/sell volume, net delta and cumulative delta are UNSUPPORTED on this feed and are never approximated.",
  "A reduced or disappeared displayed quantity is not reported as executed; it may have been cancelled, modified or moved.",
  "A large displayed order is a liquidity candidate, not proof of an institutional order or inevitable support/resistance.",
  "Absorption is a hypothesis about passive liquidity absorbing aggressive flow — not proof of a hidden or iceberg order.",
  "A depth imbalance alone never produces a directional verdict or trade recommendation.",
];

export function buildBuyerSellerIntelligence(input: IntelligenceInput): BuyerSellerIntelligence {
  const done = input.candles.filter((c) => !c.live);
  const price = done.length ? done[done.length - 1].close : input.underlyingPrice ?? 0;
  const candleTs = done.length ? done[done.length - 1].ts : null;
  const signals: IntelligenceSignal[] = [];

  // ---- Channel: displayed depth -------------------------------------------
  const d = input.depth;
  const depthAvailable = !!d && d.validity === "VALID";
  if (depthAvailable && d!.obi != null) {
    // Depth imbalance is recorded as a signal but is EXPLICITLY weak and can
    // never alone drive the verdict.
    const leans = d!.obi! > 0.15 ? "BULLISH" : d!.obi! < -0.15 ? "BEARISH" : null;
    signals.push({
      key: "obi",
      label: "Order-book imbalance (displayed)",
      leans,
      strength: "WEAK",
      available: true,
      detail: `OBI ${(d!.obi! * 100).toFixed(1)}% over ${d!.obiLevelsUsed} level(s); bid ${d!.totalBidQty} vs ask ${d!.totalAskQty}. Weak by design — displayed liquidity only.`,
      dataClass: "DISPLAYED_DEPTH",
    });
    if (d!.spread != null) {
      signals.push({
        key: "spread",
        label: "Bid-ask spread",
        leans: null,
        strength: "WEAK",
        available: true,
        detail: `Spread ${d!.spread} (${d!.spreadBps?.toFixed(1)} bps). Narrow spreads indicate good displayed liquidity; wide spreads reduce execution quality.`,
        dataClass: "DISPLAYED_DEPTH",
      });
    }
    if (d!.concentrations.length) {
      signals.push({
        key: "concentration",
        label: "Displayed liquidity concentration",
        leans: null,
        strength: "WEAK",
        available: true,
        detail: `${d!.concentrations.length} displayed level(s) exceed ${2.5}× the mean level size — liquidity candidates, not institutional proof.`,
        dataClass: "DISPLAYED_DEPTH",
      });
    }
  } else {
    signals.push({
      key: "obi",
      label: "Order-book imbalance (displayed)",
      leans: null,
      strength: "WEAK",
      available: false,
      unavailableReason: d ? `Depth ${d.validity}${d.invalidReason ? `: ${d.invalidReason}` : ""}` : "No depth snapshot available.",
      detail: "Displayed depth unavailable for this instrument/contract.",
      dataClass: "DISPLAYED_DEPTH",
    });
  }

  // ---- Channel: executed flow --------------------------------------------
  if (input.flow.supported && input.flow.delta != null) {
    signals.push({
      key: "flowDelta",
      label: "Executed volume delta",
      leans: input.flow.delta > 0 ? "BULLISH" : input.flow.delta < 0 ? "BEARISH" : null,
      strength: "STRONG",
      available: true,
      detail: `Aggressive buy ${input.flow.aggressiveBuyVolume} vs sell ${input.flow.aggressiveSellVolume}; delta ${input.flow.delta}; cumulative ${input.flow.cumulativeDelta}.`,
      dataClass: "EXECUTED_FLOW",
    });
  } else {
    signals.push({
      key: "flowDelta",
      label: "Executed volume delta",
      leans: null,
      strength: "STRONG",
      available: false,
      unavailableReason: input.flow.reason || "UNSUPPORTED",
      detail: "Requires trade-level aggressor data, which this feed does not supply. Not approximated.",
      dataClass: "EXECUTED_FLOW",
    });
  }

  // ---- Channel: price structure ------------------------------------------
  const nearResistance = input.zones.find((z) => z.side === "resistance" && z.status !== "INVALIDATED" && price >= z.bottom - input.atr && price <= z.top + input.atr);
  const nearSupport = input.zones.find((z) => z.side === "support" && z.status !== "INVALIDATED" && price >= z.bottom - input.atr && price <= z.top + input.atr);
  if (input.zones.length) {
    signals.push({
      key: "structure",
      label: "Price structure",
      leans: input.structureTrend === "UP" ? "BULLISH" : input.structureTrend === "DOWN" ? "BEARISH" : null,
      strength: "MODERATE",
      available: true,
      detail: `Swing structure is ${input.structureTrend}. ${nearResistance ? `Price is near ${nearResistance.type} resistance.` : ""}${nearSupport ? ` Price is near ${nearSupport.type} support.` : ""}`.trim(),
      dataClass: "PRICE_STRUCTURE",
    });
  }
  if (input.vwap != null) {
    signals.push({
      key: "vwap",
      label: "VWAP alignment",
      leans: price > input.vwap ? "BULLISH" : "BEARISH",
      strength: "WEAK",
      available: true,
      detail: `Price ${price.toFixed(2)} is ${price > input.vwap ? "above" : "below"} session VWAP ${input.vwap.toFixed(2)}.`,
      dataClass: "PRICE_STRUCTURE",
    });
  }
  if (input.movementState && input.movementState !== "INSUFFICIENT_DATA") {
    signals.push({
      key: "movement",
      label: "Market movement state",
      leans: input.movementState.includes("BULLISH") || input.movementState.includes("UPSIDE") ? "BULLISH"
        : input.movementState.includes("BEARISH") || input.movementState.includes("DOWNSIDE") ? "BEARISH" : null,
      strength: "MODERATE",
      available: true,
      detail: `Movement classifier reports ${input.movementState.replace(/_/g, " ").toLowerCase()}.`,
      dataClass: "PRICE_STRUCTURE",
    });
  }

  // ---- Absorption ---------------------------------------------------------
  if (input.absorption.buyer.detected) {
    signals.push({ key: "absorptionBuyer", label: "Potential buyer absorption", leans: "BULLISH", strength: "MODERATE", available: true, detail: input.absorption.buyer.note, dataClass: "PRICE_STRUCTURE" });
  }
  if (input.absorption.seller.detected) {
    signals.push({ key: "absorptionSeller", label: "Potential seller absorption", leans: "BEARISH", strength: "MODERATE", available: true, detail: input.absorption.seller.note, dataClass: "PRICE_STRUCTURE" });
  }

  // ---- Sweeps -------------------------------------------------------------
  const activeSweep = input.sweeps.find((s) => s.fresh && (s.stage === "FOLLOW_THROUGH_CONFIRMED" || s.stage === "RECLAIM_CONFIRMED")) ?? null;
  if (activeSweep) {
    signals.push({
      key: "sweep",
      label: "Liquidity sweep",
      leans: activeSweep.direction === "BULLISH" ? "BULLISH" : "BEARISH",
      strength: activeSweep.stage === "FOLLOW_THROUGH_CONFIRMED" ? "MODERATE" : "WEAK",
      available: true,
      detail: `${activeSweep.side} sweep at ${activeSweep.level.toFixed(2)} — ${activeSweep.stageReason}`,
      dataClass: "PRICE_STRUCTURE",
    });
  }

  const bullishCount = signals.filter((s) => s.available && s.leans === "BULLISH").length;
  const bearishCount = signals.filter((s) => s.available && s.leans === "BEARISH").length;
  const availableCount = signals.filter((s) => s.available).length;

  // ---- Verdict ------------------------------------------------------------
  let verdict: IntelligenceVerdict;
  let verdictReason: string;

  const absorptionDetected = input.absorption.buyer.detected || input.absorption.seller.detected;

  if (availableCount === 0 || (availableCount === 1 && !signals.find((s) => s.available)?.leans)) {
    verdict = "INSUFFICIENT_DATA";
    verdictReason = "No usable data channels available for this instrument.";
  } else if (activeSweep) {
    verdict = "LIQUIDITY_SWEEP_CANDIDATE";
    verdictReason = `A ${activeSweep.side.toLowerCase()}-side liquidity sweep is ${activeSweep.stage === "FOLLOW_THROUGH_CONFIRMED" ? "confirmed with follow-through" : "reclaimed but unconfirmed"} at ${activeSweep.level.toFixed(2)}. ${activeSweep.stageReason}`;
  } else if (absorptionDetected) {
    const side = input.absorption.buyer.detected ? "buyer" : "seller";
    verdict = "ABSORPTION_CANDIDATE";
    verdictReason = `Potential ${side} absorption detected near a liquidity zone. This is a hypothesis requiring multiple evidence items, not proof of a hidden order.`;
  } else if (bullishCount >= 2 && bearishCount === 0) {
    verdict = "BULLISH_EVIDENCE";
    verdictReason = `${bullishCount} independent signals lean bullish with none bearish.`;
  } else if (bearishCount >= 2 && bullishCount === 0) {
    verdict = "BEARISH_EVIDENCE";
    verdictReason = `${bearishCount} independent signals lean bearish with none bullish.`;
  } else if (bullishCount > 0 && bearishCount > 0) {
    verdict = "CONFLICTING_EVIDENCE";
    verdictReason = `Evidence conflicts: ${bullishCount} bullish vs ${bearishCount} bearish signals. No directional conclusion is drawn.`;
  } else {
    verdict = "INSUFFICIENT_DATA";
    verdictReason = `Only ${availableCount} signal(s) available and none are directional. Executed-flow confirmation is unavailable on this feed, which caps the achievable evidence.`;
  }

  return {
    verdict,
    verdictReason,
    signals,
    bullishCount,
    bearishCount,
    channels: {
      depth: {
        available: depthAvailable,
        state: d ? (d.validity === "VALID" ? (d.stale ? "STALE" : "OK") : d.validity) : "UNAVAILABLE",
        reason: d?.invalidReason ?? (d ? "" : "No depth payload."),
      },
      executedFlow: {
        available: !!input.flow.supported,
        state: input.flow.supported ? "OK" : "UNSUPPORTED",
        reason: input.flow.reason,
      },
      priceStructure: {
        available: done.length > 0,
        state: done.length > 0 ? "OK" : "UNAVAILABLE",
        reason: done.length > 0 ? "" : "No completed candles.",
      },
    },
    depth: d,
    flow: input.flow,
    absorption: input.absorption,
    sweeps: input.sweeps,
    activeSweep,
    contract: {
      underlyingKey: input.underlyingKey,
      underlyingLabel: input.underlyingLabel,
      underlyingPrice: input.underlyingPrice,
      analysisContractKey: input.analysisContractKey,
      analysisContractLabel: input.analysisContractLabel,
      analysisContractPrice: input.analysisContractPrice,
      expiry: input.contractExpiry,
      rolloverNote: input.rolloverNote,
    },
    priceContext: {
      price,
      atr: input.atr,
      structureTrend: input.structureTrend,
      movementState: input.movementState,
      vwap: input.vwap,
      relativeVolume: input.relativeVolume,
    },
    freshness: {
      depthTs: d?.eventTs ?? null,
      depthAgeMs: d?.ageMs ?? null,
      depthStale: !!d?.stale,
      candleTs,
      flowSessionTo: input.flow.sessionToTs,
    },
    capabilities: capabilityRegistry(),
    generatedAt: Date.now(),
    disclaimers: DISCLAIMERS,
  };
}

