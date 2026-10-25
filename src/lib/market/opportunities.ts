/**
 * Universe-wide opportunity + alert scan (spec §7, §8).
 *
 * ROOT CAUSE FIXED: Trade Finder previously evaluated ONLY the currently
 * selected instrument, and Alerts only displayed static rule definitions —
 * neither ever scanned the eligible universe, so both pages looked inert.
 *
 * This service runs one shared pass over the eligible universe:
 *   shortlist by live activity -> full analysis per candidate ->
 *   scenario generation + alert-rule evaluation -> ranking -> dedupe
 *
 * It reuses the SAME validated pipeline as the chart (getAnalysis), so a
 * Trade Finder row and the instrument page can never disagree.
 */

import { getAnalysis, quickFeatures, scanState } from "./engine";
import { evaluateAlertRules, markFired, type AlertEventData } from "./alerts";
import { getRuntimeConfig } from "./runtime";
import { upstoxConfigured } from "./upstox";
import { getInstrument } from "./universe";

export interface TradeCandidate {
  rank: number;
  symbol: string;
  name: string;
  kind: string;
  instrumentType: string;
  direction: "LONG" | "SHORT";
  setup: string;
  price: number;
  fmpi: number;
  movementState: string;
  entryZone: [number, number] | null;
  entryTrigger: string;
  stop: number | null;
  stopReason: string;
  t1: number | null;
  t2: number | null;
  rr: number | null;
  liquidityContext: string;
  supporting: string[];
  contradicting: string[];
  dataTs: number;
  dataQuality: string;
  status: string;
  rankScore: number;
  rankReason: string;
  foEligible: boolean;
}

export interface OpportunityScan {
  ts: number;
  scanned: number;
  evaluated: number;
  qualified: number;
  coverage: { universeSource: string; shortlist: number; note: string };
  /** explicit UI state (spec §9) */
  status: "SCANNING" | "PARTIAL_DATA" | "NO_QUALIFYING_SETUP" | "RATE_LIMITED" | "SCAN_FAILED" | "NOT_CONNECTED" | "OK";
  /** per-stage exclusion counts, so every drop-off is accounted for */
  funnel: {
    universe: number;
    quoted: number;
    freshlyAnalysed: number;
    enteredRanking: number;
    evaluated: number;
    qualified: number;
    pendingEvaluation: number;
    excluded: { stage: string; count: number; reason: string }[];
  };
  /** false when the evaluation budget expired before every instrument was scored */
  complete?: boolean;
  timedOut?: boolean;
  pendingEvaluation?: number;
  candidates: TradeCandidate[];
  rejected: { symbol: string; reason: string }[];
  alerts: AlertEventData[];
  qualifyingByRule: Record<string, { symbol: string; value: string; price: number }[]>;
  formula: string;
  available: boolean;
  reason: string;
  /** progressive-scheduler coverage: scanned / evaluated / excluded / pending */
  scheduler: {
    universe: number;
    quoted: number;
    fullyAnalysed: number;
    partiallyAnalysed: number;
    quoteOnly: number;
    insufficientData: number;
    pendingAnalysis: number;
    analysisBudgetPerCycle: number;
    freshnessSec: number;
    cyclesCompleted: number;
    progressPct: number;
    note: string;
  } | null;
}

/**
 * Ranking (documented, configurable):
 *   0.30 FMPI
 *   0.20 reward:risk (normalised, capped at 3R)
 *   0.18 movement-state quality (confirmed > strengthening > continuation)
 *   0.12 participation (relative volume)
 *   0.10 evidence balance (supporting − contradicting)
 *   0.10 data quality
 * Instruments missing a required input are EXCLUDED, never scored as neutral.
 */
const STATE_QUALITY: Record<string, number> = {
  CONFIRMED_UPSIDE_BREAKOUT: 1.0,
  CONFIRMED_DOWNSIDE_BREAKDOWN: 1.0,
  CONFIRMED_STRUCTURAL_SHIFT: 0.9,
  BULLISH_MOMENTUM_STRENGTHENING: 0.85,
  BEARISH_MOMENTUM_STRENGTHENING: 0.85,
  BULLISH_CONTINUATION: 0.7,
  BEARISH_CONTINUATION: 0.7,
  POTENTIAL_LIQUIDITY_SWEEP: 0.55,
  FAILED_BREAKOUT: 0.5,
  FAILED_BREAKDOWN: 0.5,
};

const g = globalThis as typeof globalThis & { __pgOpp?: { at: number; v: OpportunityScan | null } };
const cache = (g.__pgOpp ??= { at: 0, v: null });

export async function scanOpportunities(opts: { force?: boolean; limit?: number; maxEvaluate?: number; budgetMs?: number } = {}): Promise<OpportunityScan> {
  const limit = opts.limit ?? 10;
  const maxEvaluate = opts.maxEvaluate ?? 24;

  if (!opts.force && cache.v && Date.now() - cache.at < 30_000) return cache.v;

  const schedCov = () => scanState().coverage;

  const empty = (reason: string): OpportunityScan => ({
    ts: Date.now(), scanned: 0, evaluated: 0, qualified: 0,
    coverage: { universeSource: "NONE", shortlist: 0, note: reason },
    candidates: [], rejected: [], alerts: [], qualifyingByRule: {},
    formula: "rank = 0.30·FMPI + 0.20·RR + 0.18·stateQuality + 0.12·participation + 0.10·evidence + 0.10·dataQuality",
    available: false, reason,
    status: /rate.?limit|429/i.test(reason) ? "RATE_LIMITED"
      : /not connected|token|401|expired/i.test(reason) ? "NOT_CONNECTED"
      : "SCAN_FAILED",
    funnel: {
      universe: schedCov().universe, quoted: schedCov().lastKnownQuotes,
      freshlyAnalysed: 0, enteredRanking: 0, evaluated: 0, qualified: 0, pendingEvaluation: 0,
      excluded: [{ stage: "scan", count: schedCov().universe, reason }],
    },
    scheduler: schedCov(),
  });

  if (!upstoxConfigured()) {
    const out = empty("Upstox is not connected — no instruments can be scanned. Connect an access token (top-left).");
    cache.at = Date.now(); cache.v = out;
    return out;
  }

  /**
   * `force` re-runs the ANALYSIS selection, but the quote stage still honours
   * its own 25s TTL inside quickFeatures(). A manual "Scan now" therefore
   * never re-quotes the whole universe and cannot trip the shared quote
   * quota on its own (B29).
   */
  const feats = await quickFeatures(opts.force === true);
  if (!feats.length) {
    const out = empty("Instrument universe is empty — discovery has not completed yet.");
    cache.at = Date.now(); cache.v = out;
    return out;
  }

  /**
   * ROOT CAUSE B18 (fixed): this previously sliced to 24 instruments, making
   * that the ceiling on Trade Finder and alert coverage.
   *
   * It now consumes EVERY instrument the scheduler has fully analysed in the
   * current freshness window. Coverage grows progressively across cycles until
   * the entire eligible universe is evaluated; quote-only rows are excluded
   * because their analysis inputs are not yet available.
   */
  // Account for EVERY instrument dropped before ranking, with its reason.
  const exQuoteOnly = feats.filter((f) => f.state === "QUOTE_ONLY").length;
  const exInsufficient = feats.filter((f) => f.state === "INSUFFICIENT_DATA").length;
  const exUnavailable = feats.filter((f) => f.dataQuality === "UNAVAILABLE" && f.state !== "QUOTE_ONLY" && f.state !== "INSUFFICIENT_DATA").length;
  const exZeroFmpi = feats.filter(
    (f) => f.dataQuality !== "UNAVAILABLE" && f.state !== "QUOTE_ONLY" && f.state !== "INSUFFICIENT_DATA" && !(f.fmpi > 0),
  ).length;

  const ranked = feats
    .filter((f) => f.dataQuality !== "UNAVAILABLE" && f.state !== "QUOTE_ONLY" && f.state !== "INSUFFICIENT_DATA" && f.fmpi > 0)
    .sort((a, b) => b.fmpi - a.fmpi);

  const alertsCfg = getRuntimeConfig().alerts;
  const candidates: TradeCandidate[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  const alerts: AlertEventData[] = [];
  const qualifyingByRule: Record<string, { symbol: string; value: string; price: number }[]> = {};

  /**
   * ROOT CAUSE B23 (fixed): the evaluation loop had no deadline, so a slow or
   * rate-limited API could leave the UI on "Scanning universe..." forever.
   * The scan now always terminates and reports how far it got.
   */
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  let timedOut = false;
  let evaluated = 0;

  for (const f of ranked) {
    if (Date.now() > deadline) { timedOut = true; break; }
    evaluated += 1;
    let b: any = null;
    try {
      b = await getAnalysis(f.symbol, 5);
    } catch (err) {
      rejected.push({ symbol: f.symbol, reason: `analysis failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (!b || !b.candles?.length) {
      rejected.push({ symbol: f.symbol, reason: b?.diagnostics?.failureDetail ?? "no candle data" });
      continue;
    }

    // ---- alert rule evaluation on REAL analysis (spec §7) ---------------
    const fired = evaluateAlertRules(b, { fmpiHigh: alertsCfg.fmpiHigh, fmpiLow: alertsCfg.fmpiLow });
    if (fired.length) { markFired(fired); alerts.push(...fired); }

    // "currently qualifying" snapshot — a rule's live state, not a fired event
    const push = (rule: string, value: string) => {
      (qualifyingByRule[rule] ??= []).push({ symbol: b.symbol, value, price: b.last.price });
    };
    if (b.fmpi.score >= alertsCfg.fmpiHigh) push("FMPI_HIGH", `FMPI ${b.fmpi.score.toFixed(1)}`);
    if (b.fmpi.score > 0 && b.fmpi.score <= alertsCfg.fmpiLow) push("FMPI_LOW", `FMPI ${b.fmpi.score.toFixed(1)}`);
    if (b.fmpi.state === "STRENGTHENING") push("MOMENTUM_STRENGTHENING", `${b.fmpi.direction} ${b.fmpi.score.toFixed(1)}`);
    if (b.fmpi.state === "WEAKENING") push("MOMENTUM_WEAKENING", `${b.fmpi.direction} ${b.fmpi.score.toFixed(1)}`);
    if (b.movement.state === "CONFIRMED_UPSIDE_BREAKOUT") push("BREAKOUT", "confirmed close + volume");
    if (b.movement.state === "CONFIRMED_DOWNSIDE_BREAKDOWN") push("BREAKDOWN", "confirmed close + volume");
    if (b.movement.state === "FAILED_BREAKOUT") push("FAILED_BREAKOUT", "reclaim after break");
    if (b.movement.state === "FAILED_BREAKDOWN") push("FAILED_BREAKDOWN", "reclaim after break");
    if (b.movement.state === "CONFIRMED_STRUCTURAL_SHIFT") push("STRUCTURAL_SHIFT", "CHOCH + follow-through");
    if (b.activeSweep) push("LIQUIDITY_SWEEP", `${b.activeSweep.side} ${b.activeSweep.state}`);
    for (const z of b.zones ?? []) {
      if (z.status === "TESTING") push("ZONE_TESTING", `${z.type} ${z.bottom.toFixed(1)}-${z.top.toFixed(1)}`);
      if (z.status === "REJECTED") push("ZONE_REJECTED", `${z.type} str ${z.strength}`);
      if (z.status === "BROKEN") push("ZONE_BROKEN", `${z.type} str ${z.strength}`);
      if (z.status === "RECLAIMED") push("ZONE_RECLAIMED", `${z.type} str ${z.strength}`);
      if (z.status === "POTENTIALLY_SWEPT") push("ZONE_SWEPT", `${z.type} breach+reclaim`);
    }
    if (b.scenario?.status === "ENTRY_CONDITION_MET") push("SCENARIO_CONFIRMED", `${b.scenario.direction} ${b.scenario.setup}`);
    if (b.quality?.status === "STALE" || b.quality?.status === "UNAVAILABLE") push("FEED_HEALTH", b.quality.status);

    // ---- trade candidate (only genuinely qualifying scenarios) ----------
    const s = b.scenario;
    if (!s || s.status === "NO_TRADE" || !s.direction || s.rr == null) {
      rejected.push({ symbol: f.symbol, reason: s?.noTradeReasons?.[0] ?? "no qualifying setup" });
      continue;
    }
    const inst = getInstrument(b.symbol);
    const rrNorm = Math.min(1, (s.rr ?? 0) / 3);
    const stateQ = STATE_QUALITY[b.movement.state] ?? 0.4;
    const participation = Math.min(1, (b.last.relVol ?? 0) / 2);
    const evidence = Math.max(0, Math.min(1, ((s.supporting?.length ?? 0) - (s.contradicting?.length ?? 0) + 3) / 6));
    const dq = b.quality?.status === "OK" ? 1 : b.quality?.status === "DEGRADED" ? 0.7 : 0.4;
    const rankScore = 0.30 * (b.fmpi.score / 100) + 0.20 * rrNorm + 0.18 * stateQ + 0.12 * participation + 0.10 * evidence + 0.10 * dq;

    candidates.push({
      rank: 0,
      symbol: b.symbol,
      name: b.label,
      kind: b.kind,
      instrumentType: b.kind === "index" ? "INDEX" : inst?.foEligible ? "F&O STOCK" : "CASH STOCK",
      direction: s.direction,
      setup: s.setup,
      price: b.last.price,
      fmpi: b.fmpi.score,
      movementState: b.movement.state,
      entryZone: s.entryZone,
      entryTrigger: s.entryTrigger,
      stop: s.stop,
      stopReason: s.stopReason,
      t1: s.t1,
      t2: s.t2,
      rr: s.rr,
      liquidityContext: b.fmpi.liquidityContext,
      supporting: s.supporting ?? [],
      contradicting: s.contradicting ?? [],
      dataTs: b.ts,
      dataQuality: b.quality?.status ?? "UNKNOWN",
      status: s.status,
      rankScore: Math.round(rankScore * 1000) / 10,
      rankReason: `FMPI ${b.fmpi.score.toFixed(1)} · RR ${s.rr} · ${b.movement.state.replace(/_/g, " ").toLowerCase()} · relVol ${(b.last.relVol ?? 0).toFixed(2)}x`,
      foEligible: !!inst?.foEligible,
    });
  }

  candidates.sort((a, b) => b.rankScore - a.rankScore);
  candidates.forEach((c, i) => { c.rank = i + 1; });

  const out: OpportunityScan = {
    ts: Date.now(),
    scanned: feats.length,
    evaluated,
    qualified: candidates.length,
    complete: !timedOut,
    timedOut,
    pendingEvaluation: Math.max(0, ranked.length - evaluated),
    coverage: {
      universeSource: "UPSTOX_INSTRUMENT_MASTER",
      shortlist: ranked.length,
      note: `${feats.length} instruments quoted; ${evaluated} of ${ranked.length} with fresh validated analysis were evaluated for setups${timedOut ? ` (evaluation budget reached — ${ranked.length - evaluated} still pending, they are carried into the next scan)` : ""}. Instruments awaiting analysis are disclosed as pending, never scored.`,
    },
    candidates: candidates.slice(0, limit),
    rejected: rejected.slice(0, 40),
    alerts,
    qualifyingByRule,
    formula: "rank = 0.30·FMPI + 0.20·RR + 0.18·stateQuality + 0.12·participation + 0.10·evidence + 0.10·dataQuality",
    available: true,
    reason: "",
    status: (() => {
      const cov = schedCov();
      if (cov.blockedReason && /rate.?limit|429/i.test(cov.blockedReason)) return "RATE_LIMITED";
      if (candidates.length > 0) return "OK";
      // no candidates: distinguish "still warming up" from "genuinely nothing"
      if (timedOut || cov.pendingAnalysis > 0 || cov.quotesStale) return "PARTIAL_DATA";
      return "NO_QUALIFYING_SETUP";
    })(),
    funnel: {
      universe: schedCov().universe,
      quoted: schedCov().lastKnownQuotes,
      freshlyAnalysed: schedCov().fullyAnalysed,
      enteredRanking: ranked.length,
      evaluated,
      qualified: candidates.length,
      pendingEvaluation: Math.max(0, ranked.length - evaluated),
      excluded: [
        { stage: "quote-only", count: exQuoteOnly, reason: "quoted but not yet fully analysed — never ranked as a signal" },
        { stage: "insufficient-data", count: exInsufficient, reason: "analysis attempted but not enough valid candles" },
        { stage: "data-unavailable", count: exUnavailable, reason: "analysis failed or data quality UNAVAILABLE" },
        { stage: "no-fmpi", count: exZeroFmpi, reason: "FMPI could not be computed (suppressed, not neutral)" },
        { stage: "budget-pending", count: Math.max(0, ranked.length - evaluated), reason: "evaluation budget reached — carried into the next cycle" },
        { stage: "no-setup", count: rejected.length, reason: "evaluated but failed the mandatory trade gates" },
      ].filter((x) => x.count > 0),
    },
    scheduler: schedCov(),
  };
  cache.at = Date.now();
  cache.v = out;
  return out;
}

export function invalidateOpportunityCache(): void {
  cache.at = 0;
  cache.v = null;
}
