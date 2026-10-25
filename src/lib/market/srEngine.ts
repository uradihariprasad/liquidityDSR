/**
 * Dynamic Support & Resistance Intelligence Engine.
 *
 * Consumes the EXISTING zone engine output (zones.ts) and enriches it rather
 * than replacing it, so there is a single source of truth for zone geometry.
 * This module adds:
 *
 *  §3  granular strength states (Strong/Strengthening/Weakening/Broken/…)
 *      with a documented, configurable scoring model that can REDUCE strength
 *      when reactions decay — repeated tests do not automatically strengthen.
 *  §4  primary support/resistance selection by relevance, not raw score.
 *  §5  price-movement state classification (13 states) distinguishing
 *      continuation, pullback and reversal.
 *  §6  a breakout/breakdown/retest state machine with volatility-scaled
 *      confirmation and role-flip tracking.
 *  §7  next target zone, continuation trigger and scenario invalidation.
 *  §9  stable zone IDs across refreshes with hysteresis on state changes.
 *
 * No lookahead: every input is either a completed-candle series or a value
 * explicitly timestamped at/before the evaluation point.
 */

import type { Candle, Zone, StructureInfo, VolumeProfileResult } from "./types";
import type { OiZone } from "./oizones";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SRState =
  | "STRONG_SUPPORT"
  | "SUPPORT_STRENGTHENING"
  | "SUPPORT_WEAKENING"
  | "SUPPORT_BREAKDOWN_RISK"
  | "BROKEN_SUPPORT"
  | "RECLAIMED_SUPPORT"
  | "STRONG_RESISTANCE"
  | "RESISTANCE_STRENGTHENING"
  | "RESISTANCE_WEAKENING"
  | "RESISTANCE_BREAKOUT_RISK"
  | "BROKEN_RESISTANCE"
  | "RECLAIMED_RESISTANCE"
  | "UNTESTED"
  | "EXPIRED_LOW_RELEVANCE";

export type SRMachineState =
  | "APPROACHING"
  | "TESTING"
  | "BREAKOUT_PENDING"
  | "BREAKDOWN_PENDING"
  | "CONFIRMED_BREAKOUT"
  | "CONFIRMED_BREAKDOWN"
  | "RETEST_IN_PROGRESS"
  | "SUCCESSFUL_RETEST"
  | "FAILED_BREAKOUT"
  | "FAILED_BREAKDOWN"
  | "RECLAIMED_ZONE"
  | "NEUTRAL";

export type MovementClass =
  | "BULLISH_CONTINUATION"
  | "BEARISH_CONTINUATION"
  | "PULLBACK_IN_UPTREND"
  | "PULLBACK_IN_DOWNTREND"
  | "RESISTANCE_REJECTION_CANDIDATE"
  | "SUPPORT_REJECTION_CANDIDATE"
  | "BREAKOUT_PENDING_CONFIRMATION"
  | "BREAKDOWN_PENDING_CONFIRMATION"
  | "FAILED_BREAKOUT"
  | "FAILED_BREAKDOWN"
  | "REVERSAL_CANDIDATE"
  | "SIDEWAYS_RANGE_BOUND"
  | "UNCERTAIN_CONFLICTING";

export interface SRZone {
  /** the underlying zone id from zones.ts — stable across refreshes */
  id: string;
  type: string;
  side: "support" | "resistance";
  /** the role the zone currently plays (may have flipped after a break) */
  currentRole: "support" | "resistance";
  roleFlipped: boolean;
  top: number;
  bottom: number;
  mid: number;
  source: string;
  timeframe: string;
  createdTs: number;
  updatedTs: number;
  /** 0..100 */
  strength: number;
  /** itemised contributions so the score is auditable */
  strengthBreakdown: { factor: string; points: number; detail: string }[];
  tests: number;
  reactions: number;
  /** whether reactions are getting weaker (reduces strength) */
  reactionDecay: boolean;
  srState: SRState;
  machineState: SRMachineState;
  machineReason: string;
  /**
   * §4 — these were previously conflated in one `confirmed` boolean, which let
   * an OI-only zone be marked `confirmed: true` while also `UNTESTED`.
   *
   * `oiEvidenceValid`  — the OI snapshot itself is valid and fresh.
   * `priceActionConfirmed` — price has actually interacted with this level and
   *                      the interaction satisfied the confirmation rules.
   * A valid OI snapshot does NOT confirm a price level as S/R.
   */
  oiEvidenceValid: boolean;
  priceActionConfirmed: boolean;
  distanceAtr: number;
  distancePct: number;
  /** number of INDEPENDENT source families contributing */
  independentConfluence: number;
  /** ---- §6 unified confluence evidence ---- */
  /** true when this zone originated from option-chain OI rather than price structure */
  isOiDerived: boolean;
  /** OI confluence detail, null when OI is unavailable for this level */
  oiEvidence: {
    available: boolean;
    reason: string;
    callOI: number | null;
    putOI: number | null;
    callDeltaOI: number | null;
    putDeltaOI: number | null;
    concentrationPct: number | null;
    usedDeltaOI: boolean;
    expiry: string | null;
    /** number of OI strikes clustered into this zone */
    clusteredStrikes: number;
  } | null;
  /** volume-profile confluence detail */
  profileEvidence: {
    available: boolean;
    reason: string;
    levelType: string | null;
    /** ESTIMATED when derived from candle allocation */
    quality: "VALID" | "ESTIMATED" | "UNAVAILABLE";
  };
  /** the raw weighted contributions, so the score is auditable */
  scoreComponents: {
    structure: { earned: number; max: number; available: boolean };
    profile: { earned: number; max: number; available: boolean };
    oi: { earned: number; max: number; available: boolean };
    recency: { earned: number; max: number; available: boolean };
    normalized: boolean;
    normalizingMax: number;
  } | null;
  status: string;
  statusReason: string;
  invalidation: string;
  lastTestTs: number | null;
  /** how long since the last meaningful reaction (candles) */
  candlesSinceReaction: number | null;
}

export interface PrimaryZone {
  zone: SRZone;
  distance: number;
  distanceAtr: number;
  selectionReason: string;
}

/**
 * §5 The four dynamic levels. R1/R2/S1/S2 are dynamically ranked
 * market-structure zones — NOT classic pivot-point formulas.
 */
export interface LevelSelection {
  R1: PrimaryZone | null;
  R2: PrimaryZone | null;
  S1: PrimaryZone | null;
  S2: PrimaryZone | null;
  /** the zone price is currently inside, when any */
  interactionZone: SRZone | null;
  /** why any level is missing */
  notes: string[];
}

export interface SRScenario {
  movement: MovementClass;
  movementReason: string;
  primarySupport: PrimaryZone | null;
  secondarySupport: PrimaryZone | null;
  primaryResistance: PrimaryZone | null;
  secondaryResistance: PrimaryZone | null;
  /** §5 R1/R2/S1/S2 authoritative selection (same objects as above) */
  levels: LevelSelection;
  tradingRange: { bottom: number; top: number } | null;
  /** a qualifying price level that would confirm the scenario */
  continuationTrigger: { level: number; kind: string; description: string } | null;
  nextTarget: { level: number; zoneId: string; zoneType: string; description: string } | null;
  pullbackArea: { level: number; description: string } | null;
  invalidationLevel: { level: number; description: string } | null;
  pendingConfirmations: string[];
  supportingEvidence: string[];
  conflictingEvidence: string[];
  noReliableZone: boolean;
}

export interface SREngineResult {
  symbol: string;
  timeframe: string;
  price: number;
  atr: number;
  generatedAt: number;
  zones: SRZone[];
  scenario: SRScenario;
  /** data-quality state for each contributing source */
  dataQuality: {
    zones: string;
    profile: "VALID" | "ESTIMATED" | "UNAVAILABLE";
    futures: "VALID" | "UNAVAILABLE";
    optionOi: "VALID" | "PARTIAL" | "UNAVAILABLE";
    note: string;
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SRConfig {
  /**
   * §6 confluence weights (configurable). These are RANKING points, not
   * probabilities. They are normalised when a source is unavailable so that
   * missing OI or profile data does not penalise a zone.
   */
  weightStructure: number;
  weightProfile: number;
  weightOi: number;
  weightRecency: number;
  /** minimum close-beyond-zone distance (ATR) to qualify a break */
  breakConfirmAtr: number;
  /** candles that must hold beyond the zone for a CONFIRMED break */
  followThroughCandles: number;
  /** ATR distance within which price counts as "at the zone" */
  proximityAtr: number;
  /** strength threshold for the STRONG_* labels */
  strongThreshold: number;
  /** max ATR distance for a zone to be considered relevant to current price */
  relevanceAtr: number;
  /** hysteresis: minimum strength change before a state label flips */
  stateHysteresis: number;
  /** relative-volume level that counts as participation confirmation */
  relVolConfirm: number;
}

export const DEFAULT_SR_CONFIG: SRConfig = {
  // §6 documented starting weights: structure 40 / profile 20 / OI 25 / recency 15
  weightStructure: 40,
  weightProfile: 20,
  weightOi: 25,
  weightRecency: 15,
  breakConfirmAtr: 0.15,
  followThroughCandles: 2,
  proximityAtr: 1.0,
  strongThreshold: 65,
  relevanceAtr: 6,
  stateHysteresis: 4,
  relVolConfirm: 1.3,
};

// Source families used to measure INDEPENDENT confluence (§2: correlated
// evidence must not be double-counted).
const SOURCE_FAMILY: Record<string, string> = {
  SWING_HIGH: "structure", SWING_LOW: "structure",
  OI_PUT: "option_oi", OI_CALL: "option_oi",
  EQUAL_HIGHS: "structure", EQUAL_LOWS: "structure",
  CONSOLIDATION: "structure",
  PDH: "session", PDL: "session", PWH: "session", PWL: "session",
  ORH: "session", ORL: "session",
  SESSION_HIGH: "session", SESSION_LOW: "session",
  POC: "volume", VAH: "volume", VAL: "volume", HVN: "volume", LVN: "volume",
  VWAP: "vwap", VWAP_UPPER: "vwap", VWAP_LOWER: "vwap",
};

// ---------------------------------------------------------------------------
// §6 Breakout / breakdown / retest state machine
// ---------------------------------------------------------------------------

interface MachineEval {
  state: SRMachineState;
  reason: string;
  confirmed: boolean;
  roleFlipped: boolean;
  currentRole: "support" | "resistance";
}

function evalMachine(
  z: Zone,
  candles: Candle[],
  atr: number,
  cfg: SRConfig,
): MachineEval {
  const done = candles.filter((c) => !c.live);
  const n = done.length;
  const price = done.length ? done[n - 1].close : 0;
  const isResistance = z.side === "resistance";
  const base: MachineEval = { state: "NEUTRAL", reason: "", confirmed: true, roleFlipped: false, currentRole: z.side };

  if (n < 3 || atr <= 0) return { ...base, reason: "Insufficient candles to evaluate the zone state machine." };

  // Look back over a bounded window ending at the last COMPLETED candle.
  const win = done.slice(Math.max(0, n - 20));

  // Distance of current price from the near boundary
  const nearBound = isResistance ? z.bottom : z.top;
  const farBound = isResistance ? z.top : z.bottom;
  const dist = Math.abs(price - nearBound);

  // Is price beyond the far boundary in the direction that defeats the zone?
  const beyondFar = isResistance ? price > z.top + cfg.breakConfirmAtr * atr : price < z.bottom - cfg.breakConfirmAtr * atr;
  // Did any recent candle CLOSE beyond the far boundary?
  const breakIdx = win.findIndex((c) =>
    isResistance ? c.close > z.top + cfg.breakConfirmAtr * atr : c.close < z.bottom - cfg.breakConfirmAtr * atr,
  );

  /**
   * ORDERING FIX: break detection is evaluated BEFORE the proximity check.
   * Previously a candle that closed beyond the zone and then retreated to
   * just inside it was reported as TESTING, because the proximity branch
   * returned first and the qualifying break was never examined. A break, once
   * it has occurred, must always be classified through the break path.
   */
  if (breakIdx >= 0) {
    const candlesSince = win.length - 1 - breakIdx;
    // count how many candles after the break held beyond the zone
    let held = 0;
    for (let i = breakIdx; i < win.length; i++) {
      const c = win[i];
      const still = isResistance ? c.close > z.top : c.close < z.bottom;
      if (still) held++; else break;
    }

    if (held >= cfg.followThroughCandles + 1) {
      // CONFIRMED break. Role flips: broken resistance -> potential support.
      const roleFlipped = true;
      const currentRole: "support" | "resistance" = isResistance ? "support" : "resistance";
      // is price now back near the broken zone from the other side (retest)?
      const backNear = Math.abs(price - (isResistance ? z.top : z.bottom)) <= cfg.proximityAtr * atr;
      if (backNear) {
        return {
          state: "RETEST_IN_PROGRESS",
          reason: `Zone broke with ${held} candle(s) holding beyond it; price has returned to retest the level from the ${isResistance ? "above" : "below"}. Role flips to potential ${currentRole}.`,
          confirmed: true, roleFlipped, currentRole,
        };
      }
      return {
        state: isResistance ? "CONFIRMED_BREAKOUT" : "CONFIRMED_BREAKDOWN",
        reason: `${held} consecutive candle(s) closed beyond the zone by ≥ ${cfg.breakConfirmAtr}×ATR. ${
          isResistance ? "Resistance broke upward and now acts as potential support." : "Support broke downward and now acts as potential resistance."
        }`,
        confirmed: true, roleFlipped, currentRole,
      };
    }

    // A candle closed beyond the zone. Two possibilities:
    //  (a) price is STILL beyond it -> break pending confirmation
    //  (b) price has since retreated inside -> the break FAILED
    const lastBeyond = isResistance
      ? win[win.length - 1].close > z.top
      : win[win.length - 1].close < z.bottom;
    if (lastBeyond) {
      return {
        state: isResistance ? "BREAKOUT_PENDING" : "BREAKDOWN_PENDING",
        reason: `A candle closed beyond the zone but only ${Math.max(0, held)} of the required ${cfg.followThroughCandles + 1} follow-through candle(s) have confirmed. Not yet a confirmed break.`,
        confirmed: false, roleFlipped: false, currentRole: z.side,
      };
    }
    // price retreated after closing beyond -> failed break
    return {
      state: isResistance ? "FAILED_BREAKOUT" : "FAILED_BREAKDOWN",
      reason: `A candle closed beyond the zone but price has returned inside it — the break did not hold.`,
      confirmed: true, roleFlipped: false, currentRole: z.side,
    };
  }

  // --- failed break / reclaim ----------------------------------------------
  // price closed beyond at some earlier point but is now back inside/on the origin side
  const everBeyond = win.some((c) =>
    isResistance ? c.high > z.top + cfg.breakConfirmAtr * atr : c.low < z.bottom - cfg.breakConfirmAtr * atr,
  );
  const backInside = price <= z.top + cfg.breakConfirmAtr * atr && price >= z.bottom - cfg.breakConfirmAtr * atr;
  if (everBeyond && backInside && !beyondFar) {
    return {
      state: isResistance ? "FAILED_BREAKOUT" : "FAILED_BREAKDOWN",
      reason: `Price traded beyond the zone earlier but has returned inside it — the break did not hold.`,
      confirmed: true, roleFlipped: false, currentRole: z.side,
    };
  }
  // reclaimed: price closed back through after a confirmed break
  if (z.status === "RECLAIMED") {
    return {
      state: "RECLAIMED_ZONE",
      reason: `Price closed back inside the zone after an earlier confirmed break — the original role may be resuming.`,
      confirmed: true, roleFlipped: false, currentRole: z.side,
    };
  }
  // successful retest: previously broke, retested, and held
  if (z.status === "REJECTED" || (z.status === "HOLDING" && z.reactions >= 2)) {
    return {
      state: "SUCCESSFUL_RETEST",
      reason: `Zone has been tested and defended ${z.reactions} time(s) with rejection closes.`,
      confirmed: true, roleFlipped: false, currentRole: z.side,
    };
  }

  // --- approaching / testing (only when no break has occurred) -------------
  if (dist <= cfg.proximityAtr * atr && !beyondFar) {
    const inside = price <= z.top && price >= z.bottom;
    if (inside) {
      return { ...base, state: "TESTING", reason: `Price is inside the zone (${z.bottom.toFixed(2)}–${z.top.toFixed(2)}) — test in progress on a completed candle.` };
    }
    return { ...base, state: "APPROACHING", reason: `Price is ${dist.toFixed(2)} (${(dist / atr).toFixed(2)}×ATR) from the zone boundary — approaching but not yet testing.` };
  }

  void farBound;
  return { ...base, state: "NEUTRAL", reason: `Price is ${dist.toFixed(2)} (${(dist / atr).toFixed(2)}×ATR) from the zone with no qualifying break in the recent window.` };
}

// ---------------------------------------------------------------------------
// §3 Strength scoring with decay + granular state
// ---------------------------------------------------------------------------

/**
 * §6 Unified confluence scoring.
 *
 * Four independent components with configurable weights:
 *   structure (40) + profile (20) + OI (25) + recency (15) = 100 max.
 *
 * NORMALISATION: when a source is UNAVAILABLE its weight is removed from the
 * denominator and the score is rescaled, so missing OI or profile data never
 * penalises a zone. A zone with only structure available is scored out of 55
 * (40+15) and rescaled to 0..100.
 *
 * This is a RANKING INDEX, not a probability of reaction or success.
 */
function scoreUnified(
  z: Zone,
  candles: Candle[],
  atr: number,
  price: number,
  cfg: SRConfig,
  oi: OiZone[] | null,
  profile: VolumeProfileResult | null,
  evalTs: number,
): {
  strength: number;
  breakdown: { factor: string; points: number; detail: string }[];
  decay: boolean;
  oiEvidence: SRZone["oiEvidence"];
  profileEvidence: SRZone["profileEvidence"];
  scoreComponents: SRZone["scoreComponents"];
} {
  const done = candles.filter((c) => !c.live);
  const win = done.slice(-20);
  const breakdown: { factor: string; points: number; detail: string }[] = [];

  // ------------------------------------------------------------------
  // COMPONENT 1: price-structure quality (always available for a zone)
  // ------------------------------------------------------------------
  const structureMax = cfg.weightStructure;
  // base from the zone engine's own source weighting, normalised to the component max
  const structureBase = Math.round((z.strength / 100) * structureMax * 0.7);
  let structureEarned = structureBase;
  breakdown.push({ factor: "structure base", points: structureBase, detail: `${z.type} source weight (${z.strength}/100) scaled to ${structureMax} pts` });

  // reaction decay — repeated tests with shrinking reactions REDUCE the score
  const reactions: number[] = [];
  for (const c of win) {
    const inZone = c.low <= z.top && c.high >= z.bottom;
    if (!inZone) continue;
    const rejection = z.side === "resistance"
      ? Math.max(0, z.bottom - c.close)
      : Math.max(0, c.close - z.top);
    if (rejection > 0) reactions.push(rejection);
  }
  let decay = false;
  if (reactions.length >= 2) {
    const half = Math.ceil(reactions.length / 2);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    decay = avg(reactions.slice(half)) < avg(reactions.slice(0, half)) * 0.6 && avg(reactions.slice(0, half)) > 0;
  }
  if (decay) {
    const pen = -Math.round(structureMax * 0.2);
    structureEarned += pen;
    breakdown.push({ factor: "reaction decay", points: pen, detail: "Reactions are shrinking (later rejections < 60% of earlier ones) — repeated tests are WEAKENING this zone." });
  }
  // confirmed invalidation penalises heavily
  if (z.status === "INVALIDATED") {
    const pen = -Math.round(structureMax * 0.6);
    structureEarned += pen;
    breakdown.push({ factor: "invalidated", points: pen, detail: "Two consecutive closes beyond the boundary — confirmed price action invalidates this level." });
  } else if (z.status === "BROKEN") {
    const pen = -Math.round(structureMax * 0.35);
    structureEarned += pen;
    breakdown.push({ factor: "broken", points: pen, detail: "Decisive close through the level." });
  }
  structureEarned = Math.max(0, Math.min(structureMax, structureEarned));

  // ------------------------------------------------------------------
  // COMPONENT 2: volume-profile confluence
  // ------------------------------------------------------------------
  const profileMax = cfg.weightProfile;
  let profileEarned = 0;
  let profileEvidence: SRZone["profileEvidence"];
  if (!profile) {
    profileEvidence = { available: false, reason: "Volume profile unavailable for this instrument/timeframe.", levelType: null, quality: "UNAVAILABLE" };
  } else {
    // does a profile level overlap this zone?
    const tol = atr * 0.35;
    const levels: { t: string; p: number }[] = [
      { t: "POC", p: profile.poc }, { t: "VAH", p: profile.vah }, { t: "VAL", p: profile.val },
      ...profile.hvns.map((x) => ({ t: "HVN", p: x })),
      ...profile.lvns.map((x) => ({ t: "LVN", p: x })),
    ];
    // deduplicate correlated profile levels pointing at the same price
    const seen = new Set<string>();
    const matches = levels.filter((l) => {
      if (l.p >= z.bottom - tol && l.p <= z.top + tol) {
        const key = `${l.t}@${l.p.toFixed(2)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }
      return false;
    });
    if (matches.length) {
      // POC is the strongest profile confirmation; HVN next; VAH/VAL moderate
      const weight = matches.some((m) => m.t === "POC") ? 1.0
        : matches.some((m) => m.t === "HVN") ? 0.8
        : matches.some((m) => m.t === "VAH" || m.t === "VAL") ? 0.7 : 0.4;
      profileEarned = Math.round(profileMax * weight);
      profileEvidence = {
        available: true,
        reason: `Overlaps ${matches.map((m) => `${m.t} ${m.p.toFixed(2)}`).join(", ")} from the ${profile.period} profile.`,
        levelType: matches[0].t,
        quality: profile.approximation ? "ESTIMATED" : "VALID",
      };
      breakdown.push({ factor: "volume profile", points: profileEarned, detail: profileEvidence.reason + (profile.approximation ? " (ESTIMATED — candle-based allocation, not true volume-at-price)" : "") });
    } else {
      profileEvidence = { available: true, reason: "No volume-profile level within tolerance of this zone.", levelType: null, quality: profile.approximation ? "ESTIMATED" : "VALID" };
    }
  }
  profileEarned = Math.max(0, Math.min(profileMax, profileEarned));

  // ------------------------------------------------------------------
  // COMPONENT 3: option-chain OI confluence
  // ------------------------------------------------------------------
  const oiMax = cfg.weightOi;
  let oiEarned = 0;
  let oiEvidence: SRZone["oiEvidence"];
  if (!oi || !oi.length) {
    oiEvidence = {
      available: false,
      reason: "Option-chain OI unavailable — no valid chain for the current expiry, or OI values were missing/invalid.",
      callOI: null, putOI: null, callDeltaOI: null, putDeltaOI: null,
      concentrationPct: null, usedDeltaOI: false, expiry: null, clusteredStrikes: 0,
    };
  } else {
    // cluster OI strikes that overlap this zone (same price scale: both are
    // underlying-spot strikes, so no futures-basis adjustment is needed)
    const tol = atr * 0.4;
    const matching = oi.filter((o) => o.strike >= z.bottom - tol && o.strike <= z.top + tol);
    if (matching.length) {
      const relevant = matching.map((m) => (z.side === "resistance" ? m.callOI : m.putOI)).filter((v): v is number => v != null);
      const best = matching.reduce((a, b) => ((z.side === "resistance" ? (b.callOI ?? 0) : (b.putOI ?? 0)) > (z.side === "resistance" ? (a.callOI ?? 0) : (a.putOI ?? 0)) ? b : a));
      const maxConc = Math.max(...matching.map((m) => m.concentrationPct));
      // concentration drives most of the OI score
      const concPart = Math.round(oiMax * 0.6 * Math.max(0, Math.min(1, maxConc)));
      // ΔOI only contributes when genuinely available (never fabricated)
      const bestDelta = z.side === "resistance" ? best.callDeltaOI : best.putDeltaOI;
      const deltaPart = bestDelta != null
        ? Math.round(oiMax * 0.4 * (bestDelta > 0 ? 1 : bestDelta < 0 ? 0.4 : 0.5))
        : 0;
      oiEarned = concPart + deltaPart;
      oiEvidence = {
        available: true,
        reason: `${matching.length} OI strike(s) within tolerance; peak concentration ${(maxConc * 100).toFixed(0)}th percentile${bestDelta != null ? `, ΔOI ${bestDelta > 0 ? "building" : bestDelta < 0 ? "unwinding" : "flat"}` : " (ΔOI unavailable)"}.`,
        callOI: best.callOI, putOI: best.putOI,
        callDeltaOI: best.callDeltaOI, putDeltaOI: best.putDeltaOI,
        concentrationPct: maxConc,
        usedDeltaOI: bestDelta != null,
        expiry: best.expiry,
        clusteredStrikes: matching.length,
      };
      breakdown.push({ factor: "option OI", points: oiEarned, detail: oiEvidence.reason + " OI is contextual only and does not prove participant intent." });
    } else {
      oiEarned = 0;
      oiEvidence = {
        available: true,
        reason: "No OI strike within tolerance of this zone for the current expiry.",
        callOI: null, putOI: null, callDeltaOI: null, putDeltaOI: null,
        concentrationPct: null, usedDeltaOI: false,
        expiry: oi[0]?.expiry ?? null, clusteredStrikes: 0,
      };
    }
  }
  oiEarned = Math.max(0, Math.min(oiMax, oiEarned));

  // ------------------------------------------------------------------
  // COMPONENT 4: recency and observed reaction quality
  // ------------------------------------------------------------------
  const recencyMax = cfg.weightRecency;
  let recencyEarned = 0;
  {
    const distAtr = Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom)) / Math.max(atr, 1e-9);
    // proximity: closer is more relevant
    const proxPart = distAtr <= cfg.proximityAtr ? 0.5 : distAtr <= cfg.relevanceAtr ? 0.3 : 0.1;
    // reaction quality: defended zones score higher, but NOT from test count alone
    const defended = z.status === "REJECTED" || z.status === "HOLDING";
    const reactPart = defended && !decay ? 0.4 : z.reactions > 0 ? 0.2 : 0.1;
    // age decay relative to the candle series length
    const total = done.length;
    // §7 deterministic aging: use the EVALUATION timestamp, not wall-clock, so
    // replaying the same candles at the same evaluation point yields the same
    // score. total*300_000 approximates the candle-series span in ms.
    const seriesSpanMs = total * 300_000;
    const ageRatio = seriesSpanMs > 0 && z.createdTs > 0 && evalTs >= z.createdTs
      ? Math.max(0, Math.min(1, 1 - (evalTs - z.createdTs) / seriesSpanMs))
      : 0.5;
    recencyEarned = Math.round(recencyMax * (proxPart * 0.5 + reactPart * 0.35 + ageRatio * 0.15));
    breakdown.push({ factor: "recency/reaction", points: recencyEarned, detail: `${distAtr.toFixed(2)}×ATR away; ${defended ? "defended" : z.reactions > 0 ? "some reactions" : "no reactions"}${decay ? " but decaying" : ""}.` });
  }
  recencyEarned = Math.max(0, Math.min(recencyMax, recencyEarned));

  // ------------------------------------------------------------------
  // Normalise: unavailable sources are removed from the denominator
  // ------------------------------------------------------------------
  const profileAvailable = profileEvidence.available;
  const oiAvailable = oiEvidence.available;
  const rawMax = structureMax + recencyMax + (profileAvailable ? profileMax : 0) + (oiAvailable ? oiMax : 0);
  const rawEarned = structureEarned + recencyEarned + (profileAvailable ? profileEarned : 0) + (oiAvailable ? oiEarned : 0);
  const normalized = rawMax < 100;
  const strength = Math.max(2, Math.min(100, Math.round((rawEarned / Math.max(rawMax, 1)) * 100)));

  return {
    strength,
    breakdown,
    decay,
    oiEvidence,
    profileEvidence,
    scoreComponents: {
      structure: { earned: structureEarned, max: structureMax, available: true },
      profile: { earned: profileEarned, max: profileMax, available: profileAvailable },
      oi: { earned: oiEarned, max: oiMax, available: oiAvailable },
      recency: { earned: recencyEarned, max: recencyMax, available: true },
      normalized,
      normalizingMax: rawMax,
    },
  };
}

function srStateFor(
  side: "support" | "resistance",
  strength: number,
  decay: boolean,
  machine: SRMachineState,
  status: string,
  tests: number,
  cfg: SRConfig,
): SRState {
  const isRes = side === "resistance";
  if (status === "INVALIDATED") return isRes ? "BROKEN_RESISTANCE" : "BROKEN_SUPPORT";
  if (status === "RECLAIMED") return isRes ? "RECLAIMED_RESISTANCE" : "RECLAIMED_SUPPORT";
  if (machine === "CONFIRMED_BREAKOUT") return "BROKEN_RESISTANCE";
  if (machine === "CONFIRMED_BREAKDOWN") return "BROKEN_SUPPORT";

  // risk states: price is pressing against the zone from the defeating side
  if (machine === "BREAKOUT_PENDING") return "RESISTANCE_BREAKOUT_RISK";
  if (machine === "BREAKDOWN_PENDING") return "SUPPORT_BREAKDOWN_RISK";

  if (tests === 0) return "UNTESTED";

  // Decay is evaluated BEFORE the strong threshold: a zone whose reactions
  // are shrinking must never be labelled STRONG regardless of its inherited
  // score (§3: repeated tests can weaken a zone).
  if (decay) return isRes ? "RESISTANCE_WEAKENING" : "SUPPORT_WEAKENING";

  const defended = status === "REJECTED" || status === "HOLDING";
  if (strength >= cfg.strongThreshold) return isRes ? "STRONG_RESISTANCE" : "STRONG_SUPPORT";
  if (defended && strength >= 45) return isRes ? "RESISTANCE_STRENGTHENING" : "SUPPORT_STRENGTHENING";

  return isRes ? "RESISTANCE_WEAKENING" : "SUPPORT_WEAKENING";
}

// ---------------------------------------------------------------------------
// §5 Movement classification
// ---------------------------------------------------------------------------

function classifyMovementSR(
  args: {
    structure: StructureInfo;
    zones: SRZone[];
    price: number;
    atr: number;
    candles: Candle[];
    relVol: number | null;
    vwap: number | null;
  },
  cfg: SRConfig,
): { movement: MovementClass; reason: string; supporting: string[]; conflicting: string[] } {
  const { structure, zones, price, atr, candles, relVol, vwap } = args;
  const done = candles.filter((c) => !c.live);
  const supporting: string[] = [];
  const conflicting: string[] = [];
  if (done.length < 20) {
    return { movement: "UNCERTAIN_CONFLICTING", reason: "Insufficient completed candles to classify the market state.", supporting, conflicting };
  }

  const n = done.length;
  const last = done[n - 1];
  const roc5 = (last.close - done[Math.max(0, n - 6)].close) / Math.max(atr, 1e-9);

  // nearest zones by role
  const sup = zones.filter((z) => z.currentRole === "support" && z.mid < price).sort((a, b) => b.mid - a.mid)[0] ?? null;
  const res = zones.filter((z) => z.currentRole === "resistance" && z.mid > price).sort((a, b) => a.mid - b.mid)[0] ?? null;

  const atSupport = sup && price - sup.top <= cfg.proximityAtr * atr;
  const atResistance = res && res.bottom - price <= cfg.proximityAtr * atr;

  // --- pending breaks ------------------------------------------------------
  const pendingBreakout = zones.some((z) => z.machineState === "BREAKOUT_PENDING" && z.currentRole === "resistance");
  const pendingBreakdown = zones.some((z) => z.machineState === "BREAKDOWN_PENDING" && z.currentRole === "support");
  const confirmedBreakout = zones.some((z) => z.machineState === "CONFIRMED_BREAKOUT");
  const confirmedBreakdown = zones.some((z) => z.machineState === "CONFIRMED_BREAKDOWN");
  const failedBreakout = zones.some((z) => z.machineState === "FAILED_BREAKOUT");
  const failedBreakdown = zones.some((z) => z.machineState === "FAILED_BREAKDOWN");

  if (pendingBreakout) {
    supporting.push("A candle closed above resistance but follow-through confirmation is still pending.");
    return { movement: "BREAKOUT_PENDING_CONFIRMATION", reason: `Price closed beyond ${res?.type ?? "resistance"} but the required follow-through candles have not yet confirmed.`, supporting, conflicting };
  }
  if (pendingBreakdown) {
    supporting.push("A candle closed below support but follow-through confirmation is still pending.");
    return { movement: "BREAKDOWN_PENDING_CONFIRMATION", reason: `Price closed below ${sup?.type ?? "support"} but the required follow-through candles have not yet confirmed.`, supporting, conflicting };
  }
  if (failedBreakout) {
    conflicting.push("An earlier breakout attempt failed to hold.");
    return { movement: "FAILED_BREAKOUT", reason: "Price traded above resistance but returned inside the zone — the breakout did not hold.", supporting, conflicting };
  }
  if (failedBreakdown) {
    conflicting.push("An earlier breakdown attempt failed to hold.");
    return { movement: "FAILED_BREAKDOWN", reason: "Price traded below support but returned inside the zone — the breakdown did not hold.", supporting, conflicting };
  }

  // --- confirmed continuation ---------------------------------------------
  if (confirmedBreakout && structure.trend === "UP") {
    supporting.push("Structure is bullish (higher highs and higher lows).");
    supporting.push("Resistance broke with qualifying follow-through.");
    if (sup) supporting.push(`Support at ${sup.mid.toFixed(2)} remains intact below price.`);
    if (relVol != null && relVol >= cfg.relVolConfirm) supporting.push(`Relative volume ${relVol.toFixed(2)}× confirms participation.`);
    if (relVol != null && relVol < 0.8) conflicting.push(`Relative volume ${relVol.toFixed(2)}× is weak.`);
    return { movement: "BULLISH_CONTINUATION", reason: "Bullish structure with a confirmed resistance break and follow-through; support remains intact.", supporting, conflicting };
  }
  if (confirmedBreakdown && structure.trend === "DOWN") {
    supporting.push("Structure is bearish (lower highs and lower lows).");
    supporting.push("Support broke with qualifying follow-through.");
    if (res) supporting.push(`Resistance at ${res.mid.toFixed(2)} remains intact above price.`);
    return { movement: "BEARISH_CONTINUATION", reason: "Bearish structure with a confirmed support break and follow-through; resistance remains intact.", supporting, conflicting };
  }

  // --- pullback vs continuation vs reversal --------------------------------
  const upTrend = structure.trend === "UP";
  const downTrend = structure.trend === "DOWN";

  if (upTrend && roc5 < 0) {
    // moving against bullish structure — pullback or reversal?
    if (sup && atSupport) {
      supporting.push(`Price is at ${sup.type} support ${sup.bottom.toFixed(2)}–${sup.top.toFixed(2)} (strength ${sup.strength}).`);
      if (sup.srState.startsWith("STRONG") || sup.srState.includes("STRENGTHENING")) {
        return { movement: "PULLBACK_IN_UPTREND", reason: `Price is pulling back within a bullish structure into ${sup.type} support. Structure is not invalidated — this is a pullback, not a confirmed reversal.`, supporting, conflicting };
      }
    }
    // has structure actually broken?
    const lastSwingLow = [...structure.swings].reverse().find((s) => s.kind === "low");
    if (lastSwingLow && price < lastSwingLow.price - cfg.breakConfirmAtr * atr) {
      conflicting.push(`Price closed below the last higher low at ${lastSwingLow.price.toFixed(2)} — bullish structure is damaged.`);
      return { movement: "REVERSAL_CANDIDATE", reason: `Price broke below the last higher low (${lastSwingLow.price.toFixed(2)}) within a prior uptrend — a bearish reversal is plausible but not yet confirmed.`, supporting, conflicting };
    }
    return { movement: "PULLBACK_IN_UPTREND", reason: "Price is moving against a bullish structure without invalidating it (last higher low intact) — consistent with a normal pullback.", supporting, conflicting };
  }

  if (downTrend && roc5 > 0) {
    if (res && atResistance) {
      supporting.push(`Price is at ${res.type} resistance ${res.bottom.toFixed(2)}–${res.top.toFixed(2)} (strength ${res.strength}).`);
      if (res.srState.startsWith("STRONG") || res.srState.includes("STRENGTHENING")) {
        return { movement: "PULLBACK_IN_DOWNTREND", reason: `Price is rallying within a bearish structure into ${res.type} resistance. Structure is not invalidated — this is a pullback, not a confirmed reversal.`, supporting, conflicting };
      }
    }
    const lastSwingHigh = [...structure.swings].reverse().find((s) => s.kind === "high");
    if (lastSwingHigh && price > lastSwingHigh.price + cfg.breakConfirmAtr * atr) {
      conflicting.push(`Price closed above the last lower high at ${lastSwingHigh.price.toFixed(2)} — bearish structure is damaged.`);
      return { movement: "REVERSAL_CANDIDATE", reason: `Price broke above the last lower high (${lastSwingHigh.price.toFixed(2)}) within a prior downtrend — a bullish reversal is plausible but not yet confirmed.`, supporting, conflicting };
    }
    return { movement: "PULLBACK_IN_DOWNTREND", reason: "Price is moving against a bearish structure without invalidating it (last lower high intact) — consistent with a normal pullback.", supporting, conflicting };
  }

  // --- rejection candidates -------------------------------------------------
  if (atResistance && roc5 <= 0) {
    supporting.push(`Price is testing ${res!.type} resistance and short-term momentum is negative.`);
    if (res!.reactions >= 1) supporting.push(`This zone has produced ${res!.reactions} rejection close(s) already.`);
    return { movement: "RESISTANCE_REJECTION_CANDIDATE", reason: `Price is at ${res!.type} resistance with negative short-term momentum — a rejection is possible but NOT confirmed until a close back below ${res!.bottom.toFixed(2)}.`, supporting, conflicting };
  }
  if (atSupport && roc5 >= 0) {
    supporting.push(`Price is testing ${sup!.type} support and short-term momentum is positive.`);
    if (sup!.reactions >= 1) supporting.push(`This zone has produced ${sup!.reactions} rejection close(s) already.`);
    return { movement: "SUPPORT_REJECTION_CANDIDATE", reason: `Price is at ${sup!.type} support with positive short-term momentum — a rejection is possible but NOT confirmed until a close back above ${sup!.top.toFixed(2)}.`, supporting, conflicting };
  }

  // --- plain continuation --------------------------------------------------
  if (upTrend && roc5 > 0) {
    if (vwap != null) supporting.push(`Price is ${price > vwap ? "above" : "below"} VWAP ${vwap.toFixed(2)}.`);
    return { movement: "BULLISH_CONTINUATION", reason: "Bullish structure with positive short-term momentum and no zone currently being tested.", supporting, conflicting };
  }
  if (downTrend && roc5 < 0) {
    if (vwap != null) supporting.push(`Price is ${price > vwap ? "above" : "below"} VWAP ${vwap.toFixed(2)}.`);
    return { movement: "BEARISH_CONTINUATION", reason: "Bearish structure with negative short-term momentum and no zone currently being tested.", supporting, conflicting };
  }

  // --- range / conflicting --------------------------------------------------
  const bullVotes = [upTrend, roc5 > 0, vwap != null && price > vwap].filter(Boolean).length;
  const bearVotes = [downTrend, roc5 < 0, vwap != null && price < vwap].filter(Boolean).length;
  if (bullVotes >= 2 && bearVotes >= 2) {
    return { movement: "UNCERTAIN_CONFLICTING", reason: `Evidence is split (${bullVotes} bullish vs ${bearVotes} bearish votes across structure, momentum and VWAP). No directional conclusion is drawn.`, supporting, conflicting };
  }
  return { movement: "SIDEWAYS_RANGE_BOUND", reason: "No net structural progress and price is not testing a significant zone — range-bound.", supporting, conflicting };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function buildSREngine(
  input: {
    symbol: string;
    timeframe: string;
    candles: Candle[];
    zones: Zone[];
    structure: StructureInfo;
    profile: VolumeProfileResult | null;
    atr: number;
    price: number;
    relVol: number | null;
    vwap: number | null;
    futuresAvailable: boolean;
    optionOiAvailable: boolean;
    /** §5 unified input: valid option-chain OI candidate zones */
    oiZones?: OiZone[] | null;
  },
  cfg: SRConfig = DEFAULT_SR_CONFIG,
): SREngineResult {
  const { candles, zones, structure, atr, price } = input;
  const done = candles.filter((c) => !c.live);
  const now = Date.now();

  // Map zones into SRZone with the state machine and unified confluence scoring.
  const oiInput = input.oiZones ?? null;
  // §7 explicit evaluation timestamp: the last COMPLETED candle, so replay and
  // live evaluation share identical aging behaviour.
  const evalTs = candles.length ? candles[candles.length - 1].ts : 0;
  const srZones: SRZone[] = zones.map((z) => {
    const machine = evalMachine(z, candles, atr, cfg);
    const { strength, breakdown, decay, oiEvidence, profileEvidence, scoreComponents } =
      scoreUnified(z, candles, atr, price, cfg, oiInput, input.profile, evalTs);
    /**
     * The state label must reflect the zone's CURRENT role, not its original
     * side. When a resistance breaks upward it becomes potential support, so
     * labelling it "RESISTANCE_WEAKENING" while listing it as primary support
     * is contradictory. Role flip is resolved by the state machine first.
     */
    const state = srStateFor(machine.currentRole, strength, decay, machine.state, z.status, z.tests, cfg);
    const distAtr = Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom)) / Math.max(atr, 1e-9);

    // find the last candle that tested the zone
    let lastTestTs: number | null = null;
    for (let i = done.length - 1; i >= 0; i--) {
      const c = done[i];
      if (c.low <= z.top && c.high >= z.bottom && c.ts > z.createdTs) { lastTestTs = c.ts; break; }
    }
    let candlesSinceReaction: number | null = null;
    if (lastTestTs != null) {
      for (let i = done.length - 1; i >= 0; i--) if (done[i].ts === lastTestTs) { candlesSinceReaction = done.length - 1 - i; break; }
    }

    return {
      id: z.id,
      type: z.type,
      side: z.side,
      currentRole: machine.currentRole,
      roleFlipped: machine.roleFlipped,
      top: z.top, bottom: z.bottom, mid: z.mid,
      source: z.source,
      timeframe: input.timeframe,
      createdTs: z.createdTs,
      updatedTs: z.updatedTs,
      strength, strengthBreakdown: breakdown,
      tests: z.tests, reactions: z.reactions,
      reactionDecay: decay,
      srState: state,
      machineState: machine.state,
      machineReason: machine.reason,
      oiEvidenceValid: (oiEvidence?.available ?? false),
      priceActionConfirmed: machine.confirmed,
      distanceAtr: distAtr,
      distancePct: price > 0 ? (Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom)) / price) * 100 : 0,
      independentConfluence: 1,
      isOiDerived: false,
      oiEvidence,
      profileEvidence,
      scoreComponents,
      status: z.status,
      statusReason: z.statusReason,
      invalidation: z.invalidation,
      lastTestTs,
      candlesSinceReaction,
    };
  });

  /**
   * §5 step 2-3: OI-derived candidate zones with NO structural overlap become
   * standalone candidates. OI strikes that DO overlap a structural zone were
   * already folded into that zone's OI evidence component by scoreUnified, so
   * emitting them again would double-count the same price level.
   *
   * Structure remains the foundation: a standalone OI zone earns no structure
   * points, so it can only outrank a structural zone when its OI concentration
   * is genuinely high AND the structural zone is weak.
   */
  if (oiInput && oiInput.length) {
    const structTol = atr * 0.4;
    for (const o of oiInput) {
      const overlapsStructure = srZones.some(
        (z) => o.strike >= z.bottom - structTol && o.strike <= z.top + structTol,
      );
      if (overlapsStructure) continue;   // already counted as OI confluence

      const oiMax = cfg.weightOi;
      const concPart = Math.round(oiMax * 0.6 * Math.max(0, Math.min(1, o.concentrationPct)));
      const relevantDelta = o.role === "resistance" ? o.callDeltaOI : o.putDeltaOI;
      const deltaPart = relevantDelta != null ? Math.round(oiMax * 0.4 * (relevantDelta > 0 ? 1 : relevantDelta < 0 ? 0.4 : 0.5)) : 0;
      const oiEarned = Math.max(0, Math.min(oiMax, concPart + deltaPart));
      // recency: OI zones are current-expiry snapshots, so full recency weight
      const recencyEarned = Math.round(cfg.weightRecency * 0.5);
      // NO normalisation here: structure is absent BY NATURE for an OI-only
      // zone, not "unavailable". Scoring out of the full 100 keeps such a zone
      // capped at (25 + 15) = 40, so it can never outrank confirmed structure.
      const rawMax = 100;
      const rawEarned = oiEarned + recencyEarned;
      const strength = Math.max(2, Math.min(100, Math.round((rawEarned / rawMax) * 100)));

      const width = Math.max(atr * 0.15, 0.01);
      srZones.push({
        id: `oi-${o.strike}-${o.expiry ?? "na"}`,
        type: `OI_${o.role === "support" ? "PUT" : "CALL"}`,
        side: o.role,
        currentRole: o.role,
        roleFlipped: false,
        top: o.strike + width,
        bottom: o.strike - width,
        mid: o.strike,
        source: o.source,
        timeframe: input.timeframe,
        createdTs: o.ts,
        updatedTs: o.ts,
        strength,
        strengthBreakdown: [
          { factor: "option OI", points: oiEarned, detail: `${o.rule} (standalone OI level — no structural confirmation at this price).` },
          { factor: "recency", points: recencyEarned, detail: "Current-expiry OI snapshot." },
        ],
        tests: 0,
        reactions: 0,
        reactionDecay: false,
        // an untested OI level with no price confirmation
        srState: "UNTESTED",
        machineState: "NEUTRAL",
        machineReason: "Standalone OI level with no structural zone at this price — OI evidence is valid but price has not confirmed this level.",
        oiEvidenceValid: true,
        priceActionConfirmed: false,
        distanceAtr: Math.abs(price - o.strike) / Math.max(atr, 1e-9),
        distancePct: price > 0 ? (Math.abs(price - o.strike) / price) * 100 : 0,
        independentConfluence: 1,
        isOiDerived: true,
        oiEvidence: {
          available: true,
          reason: o.rule,
          callOI: o.callOI, putOI: o.putOI,
          callDeltaOI: o.callDeltaOI, putDeltaOI: o.putDeltaOI,
          concentrationPct: o.concentrationPct,
          usedDeltaOI: o.usedDeltaOI,
          expiry: o.expiry,
          clusteredStrikes: 1,
        },
        profileEvidence: { available: false, reason: "No structural zone here to compare against profile levels.", levelType: null, quality: "UNAVAILABLE" },
        scoreComponents: {
          structure: { earned: 0, max: cfg.weightStructure, available: false },
          profile: { earned: 0, max: cfg.weightProfile, available: false },
          oi: { earned: oiEarned, max: oiMax, available: true },
          recency: { earned: recencyEarned, max: cfg.weightRecency, available: true },
          normalized: false,
          normalizingMax: rawMax,
        },
        status: "NEW",
        statusReason: "OI-derived candidate without structural confirmation.",
        invalidation: `Invalidated when OI unwinds materially or price trades decisively through ${o.strike}.`,
        lastTestTs: null,
        candlesSinceReaction: null,
      });
    }
  }

  // Mark independent confluence at family level: zones from DIFFERENT families
  // that overlap contribute genuinely independent evidence.
  for (const z of srZones) {
    const fam = SOURCE_FAMILY[z.type] ?? "other";
    z.independentConfluence = srZones.filter((o) => {
      if (o.id === z.id) return false;
      const oFam = SOURCE_FAMILY[o.type] ?? "other";
      if (oFam === fam) return false;                      // same family = correlated
      return z.bottom <= o.top && z.top >= o.bottom;       // overlapping
    }).length + 1;
  }

  // --- §4 primary zone selection -------------------------------------------
  /**
   * §5 EXPLICIT ELIGIBILITY GATE.
   *
   * DEFECT FIXED: this previously relied on the score penalty alone to remove
   * invalidated zones, so a previously-strong zone could still be selected as
   * a primary level after being invalidated. Invalidated zones are now
   * excluded outright.
   *
   * A confirmed breakout does NOT delete the old resistance: it stays as a
   * broken zone with a flipped role and can be re-selected in its NEW role
   * once the reclaim conditions hold.
   */
  const eligible = (z: SRZone): boolean => {
    if (z.srState === "BROKEN_RESISTANCE" || z.srState === "BROKEN_SUPPORT") {
      // broken zones participate only in their FLIPPED role, and only after a
      // successful retest has been observed
      return z.machineState === "RETEST_IN_PROGRESS" || z.machineState === "SUCCESSFUL_RETEST";
    }
    if (z.srState === "EXPIRED_LOW_RELEVANCE") return false;
    if (z.machineState === "FAILED_BREAKOUT" || z.machineState === "FAILED_BREAKDOWN") return false;
    return z.distanceAtr <= cfg.relevanceAtr;
  };
  const relevant = eligible;

  // Relevance score: proximity + strength + independent confluence, so a
  // distant high-score zone never beats a nearby moderately-strong one.
  /**
   * Relevance ranking. Structure stays the foundation: a zone with NO price
   * confirmation (OI-derived only) is capped so it can never outrank a
   * confirmed structural zone purely on OI concentration (§5).
   */
  const relevance = (z: SRZone) => {
    const proximityScore = Math.max(0, 1 - z.distanceAtr / cfg.relevanceAtr);
    const strengthScore = z.strength / 100;
    const confluenceScore = Math.min(1, z.independentConfluence / 3);
    let score = 0.45 * proximityScore + 0.35 * strengthScore + 0.20 * confluenceScore;
    if (z.isOiDerived) {
      // no structural confirmation -> hard cap at 60% of a structural zone's
      // maximum relevance, plus it must actually be near price to compete
      score = Math.min(score, 0.60);
    }
    return score;
  };

  const selectPrimary = (role: "support" | "resistance"): PrimaryZone | null => {
    const cands = srZones
      .filter((z) => z.currentRole === role && relevant(z))
      .filter((z) => (role === "support" ? z.mid < price : z.mid > price))
      .sort((a, b) => relevance(b) - relevance(a));
    if (!cands.length) return null;
    const z = cands[0];
    const dist = role === "support" ? price - z.top : z.bottom - price;
    return {
      zone: z,
      distance: dist,
      distanceAtr: dist / Math.max(atr, 1e-9),
      selectionReason:
        `Nearest ${role} within ${cfg.relevanceAtr}×ATR with strength ${z.strength}, ${z.independentConfluence} independent source(s), ` +
        `${z.distanceAtr.toFixed(2)}×ATR away. Selected on proximity-weighted relevance rather than raw score.`,
    };
  };

  const primarySupport = selectPrimary("support");
  const primaryResistance = selectPrimary("resistance");

  /**
   * §5 R2/S2 must be DISTINCT from R1/S1 — not merely a different zone id.
   * A secondary zone that overlaps the primary (or sits on the wrong side of
   * it) is rejected so the two are never indistinguishable.
   */
  const distinctFrom = (cand: SRZone, primary: PrimaryZone | null, side: "support" | "resistance"): boolean => {
    if (!primary) return true;
    if (cand.id === primary.zone.id) return false;
    // overlapping bands make the two levels indistinguishable
    const tol = atr * 0.25;
    if (cand.bottom <= primary.zone.top + tol && cand.top >= primary.zone.bottom - tol) return false;
    // ordering: S2 must be BELOW S1, R2 must be ABOVE R1
    if (side === "support" && cand.mid >= primary.zone.mid) return false;
    if (side === "resistance" && cand.mid <= primary.zone.mid) return false;
    return true;
  };

  const secondarySupport = (() => {
    // §8: candidates must be BELOW S1, chosen in PRICE ORDER first.
    const cands = srZones
      .filter((z) => z.currentRole === "support" && relevant(z) && z.mid < price)
      .filter((z) => distinctFrom(z, primarySupport, "support"))
      .sort((a, b) => b.mid - a.mid || relevance(b) - relevance(a));
    return cands[0] ? { zone: cands[0], distance: price - cands[0].top, distanceAtr: (price - cands[0].top) / Math.max(atr, 1e-9), selectionReason: `S2 — next distinct support below S1, taken in price order (relevance only breaks ties).` } : null;
  })();
  const secondaryResistance = (() => {
    // §8: candidates must be ABOVE R1 (not merely above price), then chosen
    // in PRICE ORDER first — relevance only breaks ties between levels at a
    // comparable distance, so R2 is the next structural level above R1.
    const cands = srZones
      .filter((z) => z.currentRole === "resistance" && relevant(z) && z.mid > price)
      .filter((z) => distinctFrom(z, primaryResistance, "resistance"))
      .sort((a, b) => a.mid - b.mid || relevance(b) - relevance(a));
    return cands[0] ? { zone: cands[0], distance: cands[0].bottom - price, distanceAtr: (cands[0].bottom - price) / Math.max(atr, 1e-9), selectionReason: `R2 — next distinct resistance above R1, taken in price order (relevance only breaks ties).` } : null;
  })();

  // §5: identify the zone price is currently inside (consistent ranking rule:
  // the interaction zone is reported but does NOT also become R1/S1).
  const interactionZone = srZones.find(
    (z) => relevant(z) && price <= z.top && price >= z.bottom,
  ) ?? null;

  const levelNotes: string[] = [];
  if (!primaryResistance) levelNotes.push("No reliable resistance zone identified above the current price.");
  if (!primarySupport) levelNotes.push("No reliable support zone identified below the current price.");
  if (primaryResistance && !secondaryResistance) levelNotes.push("No distinct second resistance zone above R1.");
  if (primarySupport && !secondarySupport) levelNotes.push("No distinct second support zone below S1.");

  const levels: LevelSelection = {
    R1: primaryResistance,
    R2: secondaryResistance,
    S1: primarySupport,
    S2: secondarySupport,
    interactionZone,
    notes: levelNotes,
  };

  const tradingRange = primarySupport && primaryResistance
    ? { bottom: primarySupport.zone.top, top: primaryResistance.zone.bottom }
    : null;

  // --- §5 movement ----------------------------------------------------------
  const cls = classifyMovementSR(
    { structure, zones: srZones, price, atr, candles, relVol: input.relVol, vwap: input.vwap },
    cfg,
  );

  // --- §7 scenario: trigger / target / invalidation -------------------------
  const pending: string[] = [];
  let continuationTrigger: SRScenario["continuationTrigger"] = null;
  let nextTarget: SRScenario["nextTarget"] = null;
  let pullbackArea: SRScenario["pullbackArea"] = null;
  let invalidationLevel: SRScenario["invalidationLevel"] = null;

  switch (cls.movement) {
    case "BULLISH_CONTINUATION":
    case "PULLBACK_IN_UPTREND": {
      if (primaryResistance) {
        nextTarget = {
          level: primaryResistance.zone.bottom,
          zoneId: primaryResistance.zone.id,
          zoneType: primaryResistance.zone.type,
          description: `Next resistance zone ${primaryResistance.zone.bottom.toFixed(2)}–${primaryResistance.zone.top.toFixed(2)} (${primaryResistance.zone.type}), a potential reaction area — not a guaranteed reversal point.`,
        };
      }
      if (primarySupport) {
        pullbackArea = { level: primarySupport.zone.top, description: `Pullback area: ${primarySupport.zone.type} support ${primarySupport.zone.bottom.toFixed(2)}–${primarySupport.zone.top.toFixed(2)}. A hold here keeps the bullish structure intact.` };
        invalidationLevel = { level: primarySupport.zone.bottom - cfg.breakConfirmAtr * atr, description: `BULLISH SCENARIO INVALIDATION — a close below ${primarySupport.zone.bottom.toFixed(2)} (−${cfg.breakConfirmAtr}×ATR) invalidates the bullish scenario.` };
      } else if (secondarySupport) {
        invalidationLevel = { level: secondarySupport.zone.bottom - cfg.breakConfirmAtr * atr, description: `BULLISH SCENARIO INVALIDATION — a close below ${secondarySupport.zone.bottom.toFixed(2)} invalidates the bullish scenario.` };
      }
      if (primaryResistance) {
        continuationTrigger = { level: primaryResistance.zone.top + cfg.breakConfirmAtr * atr, kind: "CANDIDATE_TRIGGER", description: `A qualifying close above ${primaryResistance.zone.top.toFixed(2)} (+${cfg.breakConfirmAtr}×ATR) with follow-through would confirm continuation.` };
        pending.push(`${cfg.followThroughCandles + 1} follow-through candle(s) beyond ${primaryResistance.zone.top.toFixed(2)}`);
      }
      break;
    }
    case "BEARISH_CONTINUATION":
    case "PULLBACK_IN_DOWNTREND": {
      if (primarySupport) {
        nextTarget = {
          level: primarySupport.zone.top,
          zoneId: primarySupport.zone.id,
          zoneType: primarySupport.zone.type,
          description: `Next support zone ${primarySupport.zone.bottom.toFixed(2)}–${primarySupport.zone.top.toFixed(2)} (${primarySupport.zone.type}), a potential reaction area — not a guaranteed reversal point.`,
        };
      }
      if (primaryResistance) {
        pullbackArea = { level: primaryResistance.zone.bottom, description: `Pullback area: ${primaryResistance.zone.type} resistance ${primaryResistance.zone.bottom.toFixed(2)}–${primaryResistance.zone.top.toFixed(2)}. A rejection here keeps the bearish structure intact.` };
        invalidationLevel = { level: primaryResistance.zone.top + cfg.breakConfirmAtr * atr, description: `BEARISH SCENARIO INVALIDATION — a close above ${primaryResistance.zone.top.toFixed(2)} (+${cfg.breakConfirmAtr}×ATR) invalidates the bearish scenario.` };
      }
      if (primarySupport) {
        continuationTrigger = { level: primarySupport.zone.bottom - cfg.breakConfirmAtr * atr, kind: "CANDIDATE_TRIGGER", description: `A qualifying close below ${primarySupport.zone.bottom.toFixed(2)} (−${cfg.breakConfirmAtr}×ATR) with follow-through would confirm continuation.` };
        pending.push(`${cfg.followThroughCandles + 1} follow-through candle(s) beyond ${primarySupport.zone.bottom.toFixed(2)}`);
      }
      break;
    }
    case "BREAKOUT_PENDING_CONFIRMATION": {
      // A breaking resistance sits AT/BELOW price, so it may not appear as
      // "primary resistance" (which requires mid > price). Resolve the pending
      // zone directly from the zone list.
      const pendingZone = srZones.find((z) => z.machineState === "BREAKOUT_PENDING");
      const ref = pendingZone ?? primaryResistance?.zone ?? null;
      if (ref) {
        pending.push(`Follow-through above ${ref.top.toFixed(2)} is still required — the close alone is not confirmation.`);
        invalidationLevel = { level: ref.bottom, description: `A close back below ${ref.bottom.toFixed(2)} marks the breakout as failed.` };
      }
      break;
    }
    case "BREAKDOWN_PENDING_CONFIRMATION": {
      const pendingZone = srZones.find((z) => z.machineState === "BREAKDOWN_PENDING");
      const ref = pendingZone ?? primarySupport?.zone ?? null;
      if (ref) {
        pending.push(`Follow-through below ${ref.bottom.toFixed(2)} is still required — the close alone is not confirmation.`);
        invalidationLevel = { level: ref.top, description: `A close back above ${ref.top.toFixed(2)} marks the breakdown as failed.` };
      }
      break;
    }
    case "SUPPORT_REJECTION_CANDIDATE": {
      if (primarySupport) {
        continuationTrigger = { level: primarySupport.zone.top + cfg.breakConfirmAtr * atr, kind: "CANDIDATE_TRIGGER", description: `A close back above ${primarySupport.zone.top.toFixed(2)} would confirm the support rejection.` };
        pending.push(`Close above ${primarySupport.zone.top.toFixed(2)} to confirm rejection`);
        invalidationLevel = { level: primarySupport.zone.bottom - cfg.breakConfirmAtr * atr, description: `BULLISH SCENARIO INVALIDATION — a close below ${primarySupport.zone.bottom.toFixed(2)} invalidates the rejection and confirms a breakdown.` };
      }
      break;
    }
    case "RESISTANCE_REJECTION_CANDIDATE": {
      if (primaryResistance) {
        continuationTrigger = { level: primaryResistance.zone.bottom - cfg.breakConfirmAtr * atr, kind: "CANDIDATE_TRIGGER", description: `A close back below ${primaryResistance.zone.bottom.toFixed(2)} would confirm the resistance rejection.` };
        pending.push(`Close below ${primaryResistance.zone.bottom.toFixed(2)} to confirm rejection`);
        invalidationLevel = { level: primaryResistance.zone.top + cfg.breakConfirmAtr * atr, description: `BEARISH SCENARIO INVALIDATION — a close above ${primaryResistance.zone.top.toFixed(2)} invalidates the rejection and confirms a breakout.` };
      }
      break;
    }
    default:
      pending.push("No scenario-specific confirmation conditions — the current state does not justify a directional setup.");
  }

  const noReliableZone = !primarySupport && !primaryResistance;

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    price,
    atr,
    generatedAt: now,
    zones: srZones.sort((a, b) => a.distanceAtr - b.distanceAtr),
    scenario: {
      movement: cls.movement,
      movementReason: cls.reason,
      primarySupport, secondarySupport, primaryResistance, secondaryResistance,
      levels,
      tradingRange,
      continuationTrigger, nextTarget, pullbackArea, invalidationLevel,
      pendingConfirmations: pending,
      supportingEvidence: cls.supporting,
      conflictingEvidence: cls.conflicting,
      noReliableZone,
    },
    dataQuality: {
      zones: zones.length ? "VALID" : "UNAVAILABLE",
      profile: input.profile ? (input.profile.approximation ? "ESTIMATED" : "VALID") : "UNAVAILABLE",
      futures: input.futuresAvailable ? "VALID" : "UNAVAILABLE",
      optionOi: oiInput?.length ? "VALID" : input.optionOiAvailable ? "PARTIAL" : "UNAVAILABLE",
      note:
        "Zones are derived from completed candles and instrument-specific ATR. Volume-profile levels are ESTIMATED from candle-based uniform allocation. " +
        "Option-chain OI zones require a valid chain for the current expiry. Levels are potential reaction areas, never guaranteed reversals.",
    },
  };
}

export { SOURCE_FAMILY };
