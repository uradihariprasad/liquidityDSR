/**
 * OI-Based Strike Intelligence chart overlay (audit §7).
 *
 * Produces chart-drawable OI levels from VALIDATED option-chain data only.
 * Every level carries its own provenance and data-quality state, and is kept
 * strictly separate from structural liquidity zones.
 *
 * Rules (documented):
 *  - A strike is only emitted when its current OI is valid (not missing).
 *  - Change-in-OI-dependent labels (WEAKENING / STRENGTHENING) require a
 *    valid ΔOI. When `prev_oi` is absent the strike is still shown as a
 *    plain CANDIDATE but never labelled as strengthening or weakening.
 *  - OI concentration is measured RELATIVE to the instrument's own strike
 *    band (percentile), never against a hardcoded universal threshold.
 *  - Confluence with a structural zone is detected within a configurable
 *    tolerance and both sources are preserved separately.
 *  - High OI alone never marks a strike as confirmed support/resistance.
 */

import type { StrikeIntel } from "./derivatives";

export type OiZoneLabel =
  | "OI SUPPORT CANDIDATE"
  | "OI RESISTANCE CANDIDATE"
  | "OI SUPPORT WEAKENING"
  | "OI RESISTANCE WEAKENING";

export type OiQuality = "VALID" | "PARTIAL" | "UNAVAILABLE";

export interface OiZone {
  strike: number;
  label: OiZoneLabel;
  /** resistance (above spot) or support (below spot) */
  role: "support" | "resistance";
  callOI: number | null;
  putOI: number | null;
  callDeltaOI: number | null;
  putDeltaOI: number | null;
  /** OI concentration relative to this instrument's own strike band (0..1) */
  concentrationPct: number;
  /** true when ΔOI was available and used in the label */
  usedDeltaOI: boolean;
  quality: OiQuality;
  rule: string;
  source: string;
  expiry: string | null;
  ts: number;
  /** structural zone type this OI level overlaps with, if any */
  confluenceWith: string | null;
  confluenceLabel: "STRUCTURE + OI CONFLUENCE" | null;
}

export interface OiOverlayResult {
  available: boolean;
  reason: string;
  expiry: string | null;
  spot: number | null;
  zones: OiZone[];
  /** how many strikes were skipped because OI was missing/invalid */
  skippedInvalidOi: number;
  note: string;
}

export interface OiOverlayConfig {
  /** strikes further than this fraction of spot are ignored */
  maxDistanceFromSpot: number;
  /** minimum OI percentile (within this instrument's band) to qualify */
  minConcentrationPct: number;
  /** confluence tolerance vs structural zones, in ATR units */
  confluenceAtr: number;
}

export const DEFAULT_OI_OVERLAY_CONFIG: OiOverlayConfig = {
  maxDistanceFromSpot: 0.03,
  minConcentrationPct: 0.75,
  confluenceAtr: 0.35,
};

export function buildOiOverlay(
  input: {
    strikes: StrikeIntel[];
    spot: number;
    atr: number;
    expiry: string | null;
    ts: number;
    /** structural zones to test for confluence */
    structuralZones: { type: string; bottom: number; top: number }[];
  },
  cfg: OiOverlayConfig = DEFAULT_OI_OVERLAY_CONFIG,
): OiOverlayResult {
  const empty = (reason: string): OiOverlayResult => ({
    available: false, reason, expiry: input.expiry, spot: input.spot,
    zones: [], skippedInvalidOi: 0,
    note: "Option-chain OI confirmation is unavailable. Structural liquidity zones remain visible and unaffected.",
  });

  if (!input.strikes?.length) return empty("No option-chain strikes returned for the selected underlying/expiry.");
  if (!Number.isFinite(input.spot) || input.spot <= 0) return empty("Underlying spot price unavailable — strikes cannot be mapped to the price scale.");

  // Collect valid OI values to establish THIS INSTRUMENT's own distribution.
  const oiValues: number[] = [];
  let skipped = 0;
  for (const s of input.strikes) {
    const relevant = s.strike <= input.spot ? s.putOI : s.callOI;
    if (relevant == null) { skipped++; continue; }
    oiValues.push(relevant);
  }
  if (!oiValues.length) {
    return { ...empty("No strike within range has a valid OI value."), skippedInvalidOi: skipped };
  }
  oiValues.sort((a, b) => a - b);

  const pct = (v: number) => oiValues.filter((x) => x <= v).length / Math.max(1, oiValues.length);

  const zones: OiZone[] = [];
  for (const s of input.strikes) {
    const distance = Math.abs(s.strike - input.spot) / input.spot;
    if (distance > cfg.maxDistanceFromSpot) continue;

    const below = s.strike <= input.spot;
    const relevantOi = below ? s.putOI : s.callOI;
    if (relevantOi == null) continue;                 // missing OI -> not emitted

    const concentration = pct(relevantOi);
    if (concentration < cfg.minConcentrationPct) continue;   // not concentrated enough for this instrument

    const delta = below ? s.putDeltaOI : s.callDeltaOI;
    const usedDelta = delta != null;

    let label: OiZoneLabel;
    let rule: string;
    if (usedDelta && delta! < 0) {
      label = below ? "OI SUPPORT WEAKENING" : "OI RESISTANCE WEAKENING";
      rule = `${below ? "Put" : "Call"} OI ${relevantOi} at the ${(concentration * 100).toFixed(0)}th percentile of this instrument's strike band, with a valid ΔOI of ${delta} (shedding).`;
    } else {
      label = below ? "OI SUPPORT CANDIDATE" : "OI RESISTANCE CANDIDATE";
      rule = `${below ? "Put" : "Call"} OI ${relevantOi} at the ${(concentration * 100).toFixed(0)}th percentile of this instrument's strike band${usedDelta ? `, ΔOI ${delta}` : " (ΔOI unavailable — prev_oi absent, so no change direction is claimed)"}.`;
    }

    // confluence with a structural zone
    let confluenceWith: string | null = null;
    for (const z of input.structuralZones) {
      const tol = cfg.confluenceAtr * Math.max(input.atr, 1e-9);
      if (s.strike >= z.bottom - tol && s.strike <= z.top + tol) { confluenceWith = z.type; break; }
    }

    zones.push({
      strike: s.strike,
      label,
      role: below ? "support" : "resistance",
      callOI: s.callOI,
      putOI: s.putOI,
      callDeltaOI: s.callDeltaOI,
      putDeltaOI: s.putDeltaOI,
      concentrationPct: concentration,
      usedDeltaOI: usedDelta,
      quality: usedDelta ? "VALID" : "PARTIAL",
      rule,
      source: `option-chain ${below ? "put" : "call"} OI @ strike ${s.strike}`,
      expiry: input.expiry,
      ts: input.ts,
      confluenceWith,
      confluenceLabel: confluenceWith ? "STRUCTURE + OI CONFLUENCE" : null,
    });
  }

  if (!zones.length) {
    return {
      available: false,
      reason: `No strike within ${(cfg.maxDistanceFromSpot * 100).toFixed(0)}% of spot reached the ${(cfg.minConcentrationPct * 100).toFixed(0)}th OI percentile for this instrument.`,
      expiry: input.expiry, spot: input.spot, zones: [], skippedInvalidOi: skipped,
      note: "OI confirmation found no qualifying strikes. Structural zones remain visible.",
    };
  }

  return {
    available: true,
    reason: "",
    expiry: input.expiry,
    spot: input.spot,
    zones: zones.sort((a, b) => a.strike - b.strike),
    skippedInvalidOi: skipped,
    note:
      "OI levels are CANDIDATES derived from option-chain OI concentration relative to this instrument's own strike band. " +
      "High OI alone does not confirm support or resistance, and ΔOI does not identify who initiated a trade. " +
      "Structural zones and OI levels are separate data sources; confluence is reported without merging their evidence.",
  };
}
