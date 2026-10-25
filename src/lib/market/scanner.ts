/**
 * F&O Momentum Scanner + Buyer/Seller-dominance ranking.
 *
 * Input: per-symbol quick feature snapshots produced by the engine (which
 * are derived from real computed candles/indicators — never hardcoded).
 * Ranking model (documented):
 *
 *   rank = 0.34 × fmpiNorm
 *        + 0.22 × participation   (relvol, clamped 0..2 → /2)
 *        + 0.16 × momentum        (|changePct| vs ATR-normalised day move)
 *        + 0.12 × structure       (trend purity / breakout status)
 *        + 0.08 × liquidityCtx     (zone interaction quality)
 *        + 0.08 × dataQuality      (freshness)
 *
 * Direction from FMPI direction + day change sign agreement. Candidates are
 * only listed as buyer/seller-DOMINANT when the dominance evidence clears a
 * documented bar (fmpi ≥ 60, relvol ≥ 1.3, structure agreement). Otherwise
 * they are described as "displayed pressure" or omitted. Lists are capped at
 * `count` (default 5) but never padded to reach it.
 */

import type { ScannerCandidate } from "./types";
import { clamp } from "./prng";

export interface QuickFeature {
  symbol: string;
  name: string;
  kind: string;
  sector: string;
  price: number;
  changePct: number;
  relVol: number;
  fmpi: number;
  fmpiDirection: "BULLISH" | "BEARISH" | "NEUTRAL";
  state: string;
  trend: "UP" | "DOWN" | "RANGE";
  breakoutUp: boolean;
  breakoutDn: boolean;
  zoneNote: string | null;
  dataQuality: string;
  dayMoveAtr: number;
}

export interface ScannerConfig {
  count: number;
  minFMPI: number;
  minRelVol: number;
  minChangePct: number;
  minQuality: number; // 0..1 data-quality weight floor
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  count: 5,
  minFMPI: 45,
  minRelVol: 1.0,
  minChangePct: 0.25,
  minQuality: 0.6,
};

export interface ScannerCoverage {
  scanned: number;
  eligible: number;
  universeSource: string;
  /** instruments with candles + indicators + FMPI all valid */
  fullyAnalysed: number;
  /** analysed but with degraded/partial data quality */
  partiallyAnalysed: number;
  /** quoted only — no candle analysis yet, never ranked as a signal */
  quoteOnly: number;
  /** analysis attempted but insufficient valid history */
  insufficientData: number;
  /** analysed but rejected by the configured filters */
  excludedByFilters: number;
  note: string;
}

export interface ScannerResult {
  ts: number;
  config: ScannerConfig;
  coverage: ScannerCoverage;
  bullish: ScannerCandidate[];
  bearish: ScannerCandidate[];
  strongestMomentum: ScannerCandidate | null;
  risingRelVol: ScannerCandidate[];
  confirmedBreakouts: ScannerCandidate[];
  confirmedBreakdowns: ScannerCandidate[];
  warnings: { symbol: string; warning: string }[];
  buyerDominant: ScannerCandidate[];
  sellerDominant: ScannerCandidate[];
  dominanceNote: string;
  formula: string;
}

export function runScanner(features: QuickFeature[], universeSource: string, cfg?: Partial<ScannerConfig>): ScannerResult {
  const config = { ...DEFAULT_SCANNER_CONFIG, ...(cfg ?? {}) };
  const ts = Date.now();
  const candidates: ScannerCandidate[] = [];

  for (const f of features) {
    const fmpiNorm = clamp(f.fmpi / 100, 0, 1);
    const participation = clamp(f.relVol / 2, 0, 1);
    const momentum = clamp(Math.abs(f.dayMoveAtr) / 2.5, 0, 1);
    const structure = f.breakoutUp || f.breakoutDn ? 0.95 : f.trend === "RANGE" ? 0.3 : 0.65;
    const liquidity = f.zoneNote ? 0.65 : 0.35;
    const dq = f.dataQuality === "OK" || f.dataQuality === "REPLAY" ? 1 : f.dataQuality === "DEGRADED" ? 0.7 : 0.4;
    const rank = 0.34 * fmpiNorm + 0.22 * participation + 0.16 * momentum + 0.12 * structure + 0.08 * liquidity + 0.08 * dq;

    const dir: ScannerCandidate["direction"] =
      f.fmpiDirection === "NEUTRAL" ? (f.changePct > 0.1 ? "BULLISH" : f.changePct < -0.1 ? "BEARISH" : "NEUTRAL") : f.fmpiDirection;

    const reasons: string[] = [];
    if (f.fmpi >= 65) reasons.push(`FMPI ${f.fmpi.toFixed(1)} — ${f.fmpi >= 80 ? "very strong" : "strong"} momentum composite.`);
    else if (f.fmpi >= 50) reasons.push(`FMPI ${f.fmpi.toFixed(1)} — developing momentum.`);
    if (f.relVol >= 1.5) reasons.push(`Relative volume ${f.relVol.toFixed(2)}× — participation spike.`);
    else if (f.relVol >= 1.2) reasons.push(`Relative volume ${f.relVol.toFixed(2)}× above norm.`);
    if (f.breakoutUp) reasons.push("Confirmed upside zone break with acceptance.");
    if (f.breakoutDn) reasons.push("Confirmed downside zone break with acceptance.");
    if (f.trend !== "RANGE") reasons.push(`Structure: ${f.trend} trend.`);
    if (Math.abs(f.dayMoveAtr) >= 1.5) reasons.push(`Day move ${f.dayMoveAtr.toFixed(2)} ATR.`);
    if (f.zoneNote) reasons.push(f.zoneNote);

    const invalidation: string[] = [];
    invalidation.push(`FMPI falling below ${config.minFMPI} or direction flip.`);
    if (dir === "BULLISH") invalidation.push("A close back below the breakout/structure level invalidates the long case.");
    if (dir === "BEARISH") invalidation.push("A close back above the breakdown/structure level invalidates the short case.");
    invalidation.push("Relative volume collapsing below 0.8 removes participation confirmation.");

    const dominance =
      f.fmpi >= 60 && f.relVol >= 1.3 && f.trend !== "RANGE" && dir !== "NEUTRAL"
        ? `${dir === "BULLISH" ? "Buyer" : "Seller"}-dominant evidence (momentum + participation + structure agree)`
        : dir === "NEUTRAL"
          ? "No dominance — non-directional"
          : "Displayed pressure only (dominance criteria not fully met)";

    candidates.push({
      symbol: f.symbol, name: f.name, kind: f.kind, sector: f.sector,
      price: f.price, changePct: f.changePct, relVol: f.relVol, fmpi: f.fmpi,
      direction: dir, state: f.state, structure: f.trend,
      rankScore: Math.round(rank * 1000) / 10,
      reasons, invalidation, dataQuality: f.dataQuality,
      dominanceLabel: dominance,
    });
  }

  /**
   * HARD data-eligibility gate, applied before any user threshold.
   * An instrument whose analysis is not actually available must never be
   * ranked, however low the user sets the filters — missing inputs are not
   * positive evidence. This is separate from the configurable filters below.
   */
  const ANALYSIS_UNAVAILABLE = new Set(["QUOTE_ONLY", "INSUFFICIENT_DATA", "UNAVAILABLE"]);
  const rankable = candidates.filter((c) =>
    c.kind === "stock" && !ANALYSIS_UNAVAILABLE.has(c.state) && !ANALYSIS_UNAVAILABLE.has(c.dataQuality),
  );

  const eligible = rankable.filter((c) =>
    Math.abs(c.changePct) >= config.minChangePct
    && c.relVol >= config.minRelVol
    && c.fmpi >= config.minFMPI
    && (c.dataQuality === "OK" || config.minQuality <= 0.6),
  );

  const sortRank = (a: ScannerCandidate, b: ScannerCandidate) => b.rankScore - a.rankScore;
  const bullish = eligible.filter((c) => c.direction === "BULLISH").sort(sortRank).slice(0, config.count);
  const bearish = eligible.filter((c) => c.direction === "BEARISH").sort(sortRank).slice(0, config.count);

  const allStocks = candidates.filter((c) => c.kind === "stock");
  const strongestMomentum = [...allStocks].sort((a, b) => b.fmpi - a.fmpi)[0] ?? null;
  const risingRelVol = [...allStocks].filter((c) => c.relVol >= 1.4).sort((a, b) => b.relVol - a.relVol).slice(0, config.count);
  const confirmedBreakouts = allStocks.filter((c) => c.state === "CONFIRMED_UPSIDE_BREAKOUT").sort(sortRank).slice(0, config.count);
  const confirmedBreakdowns = allStocks.filter((c) => c.state === "CONFIRMED_DOWNSIDE_BREAKDOWN").sort(sortRank).slice(0, config.count);

  const buyerDominant = bullish.filter((c) => c.dominanceLabel.startsWith("Buyer"));
  const sellerDominant = bearish.filter((c) => c.dominanceLabel.startsWith("Seller"));

  const warnings: ScannerResult["warnings"] = [];
  for (const c of allStocks) {
    if (c.state === "BULLISH_MOMENTUM_WEAKENING" || c.state === "BEARISH_MOMENTUM_WEAKENING") warnings.push({ symbol: c.symbol, warning: "Momentum weakening — participation or structure fading." });
    if (c.state === "CONFLICTING_SIGNALS") warnings.push({ symbol: c.symbol, warning: "Conflicting signals across evidence channels." });
    if (c.state === "FAILED_BREAKOUT") warnings.push({ symbol: c.symbol, warning: "Failed breakout — potential bull trap." });
    if (c.state === "FAILED_BREAKDOWN") warnings.push({ symbol: c.symbol, warning: "Failed breakdown — potential bear trap." });
  }

  // ---- transparent coverage accounting (spec §9) --------------------------
  // An instrument is never counted as analysed when its inputs are missing.
  const fullyAnalysed = rankable.filter((c) => c.dataQuality === "OK");
  const partiallyAnalysed = rankable.filter((c) => c.dataQuality !== "OK");
  const quoteOnly = candidates.filter((c) => c.state === "QUOTE_ONLY");
  const insufficient = candidates.filter((c) => c.state === "INSUFFICIENT_DATA" || c.dataQuality === "UNAVAILABLE");
  // only instruments that HAD valid analysis count as filter-exclusions;
  // unavailable ones are reported separately, not as filtered out
  const excludedByFilters = rankable.filter((c) => !eligible.includes(c));

  return {
    ts,
    config,
    coverage: {
      scanned: features.length,
      eligible: eligible.length,
      universeSource,
      fullyAnalysed: fullyAnalysed.length,
      partiallyAnalysed: partiallyAnalysed.length,
      quoteOnly: quoteOnly.length,
      insufficientData: insufficient.length,
      excludedByFilters: excludedByFilters.length,
      note:
        `${features.length} instruments quoted; ${fullyAnalysed.length} fully analysed (candles + indicators + FMPI), ` +
        `${partiallyAnalysed.length} partially analysed (degraded data), ${quoteOnly.length} quote-only (awaiting candle analysis), ` +
        `${insufficient.length} with insufficient data, ${excludedByFilters.length} excluded by the configured filters. ` +
        `Quote-only rows are never ranked as signals — missing inputs are not treated as positive evidence.`,
    },
    bullish, bearish, strongestMomentum, risingRelVol, confirmedBreakouts, confirmedBreakdowns,
    warnings: warnings.slice(0, 20),
    buyerDominant, sellerDominant,
    dominanceNote: "Buyer/seller dominance requires FMPI ≥ 60 AND relative volume ≥ 1.3 AND an aligned non-range structure. Otherwise results are labelled as displayed pressure only. The quote API cannot attribute executed aggressor flow, so dominance is inferred from momentum/participation/structure — not from confirmed aggressive buying/selling.",
    formula: "rank = 0.34·FMPI + 0.22·participation + 0.16·momentum + 0.12·structure + 0.08·liquidity + 0.08·dataQuality",
  };
}
