/**
 * §13 Historical validation framework for the S&R engine.
 *
 * Chronological, no-lookahead replay that measures how the engine's zones
 * actually behave. Success criteria are declared BEFORE evaluation and are
 * never changed after inspecting results.
 *
 * IMPORTANT: this measures ZONE BEHAVIOUR, not trade profitability.
 * A touch rate is not a win rate, and nothing here is a return figure.
 */

import type { Candle, Zone } from "./types";
import { swingPoints } from "./structure";
import { atrSeries } from "./indicators";
import { buildZones, LEAVE_SEPARATION_ATR } from "./zones";
import { buildSREngine, DEFAULT_SR_CONFIG } from "./srEngine";

/**
 * Pre-registered definition of a "successful reaction" (§13).
 * Declared up front and never tuned after seeing results.
 */
export interface SuccessCriteria {
  /** favourable movement required after first touch, in ATR units */
  requiredFavourableAtr: number;
  /** maximum adverse movement allowed, in ATR units */
  maxAdverseAtr: number;
  /** evaluation horizon in candles after first touch */
  horizonCandles: number;
}

export const DEFAULT_CRITERIA: SuccessCriteria = {
  requiredFavourableAtr: 1.0,
  maxAdverseAtr: 1.5,
  horizonCandles: 12,
};

export interface ZoneOutcome {
  zoneId: string;
  zoneType: string;
  side: "support" | "resistance";
  touched: boolean;
  firstTouchIdx: number | null;
  /** favourable excursion after first touch, in ATR units (0 if untouched) */
  favourableAtr: number;
  /** adverse excursion after first touch, in ATR units */
  adverseAtr: number;
  reacted: boolean;
  /** price closed through the zone before the horizon elapsed */
  invalidatedBeforeHorizon: boolean;
}

export interface ValidationReport {
  criteria: SuccessCriteria;
  totalZones: number;
  touchedZones: number;
  /** share of eligible zones touched by price */
  touchRate: number;
  /** share of TOUCHED zones that met the reaction criteria */
  reactionRate: number;
  avgFavourableAtr: number;
  avgAdverseAtr: number;
  invalidationRate: number;
  /** how often R1/R2/S1/S2 assignments changed between consecutive steps */
  selectionInstabilityRate: number;
  byZoneSource: Record<string, { zones: number; touched: number; reacted: number }>;
  baseline: {
    /** same metrics computed on plain swing-high/low zones (no confluence) */
    touchRate: number;
    reactionRate: number;
    zones: number;
  };
  sampleSize: number;
  note: string;
}

/**
 * Evaluate one instrument's zones chronologically.
 *
 * At each step t the engine sees ONLY candles[0..t], so no future information
 * can influence zone creation, scoring or state. Zone outcomes are then
 * measured against the SUBSEQUENT horizon candles.
 */
export function validateZones(
  candles: Candle[],
  opts: {
    criteria?: SuccessCriteria;
    /** candles between evaluation steps (default 5) */
    step?: number;
    /** warm-up candles before the first evaluation */
    warmup?: number;
    day?: { prevHigh: number; prevLow: number; prevWeekHigh: number | null; prevWeekLow: number | null; orHigh: number | null; orLow: number | null };
  } = {},
): ValidationReport {
  const criteria = opts.criteria ?? DEFAULT_CRITERIA;
  const step = opts.step ?? 5;
  const warmup = opts.warmup ?? 60;
  const day = opts.day ?? { prevHigh: 0, prevLow: 0, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null };

  const done = candles.filter((c) => !c.live);
  const atrFull = atrSeries(done, 14);
  const outcomes = new Map<string, ZoneOutcome>();
  const selections: string[] = [];
  let selectionChanges = 0;
  let selectionSteps = 0;

  // ---- chronological evaluation, strictly no lookahead ----------------
  for (let t = warmup; t < done.length - criteria.horizonCandles; t += step) {
    const visible = done.slice(0, t + 1);          // only data available at t
    const atr = atrFull[t] ?? 1;
    if (!atr || atr <= 0) continue;

    const zones = buildZones({
      candles: visible, atr, swings: swingPoints(visible),
      day, profile: null, consolidation: null, sweeps: [],
    });

    const sr = buildSREngine({
      symbol: "REPLAY", timeframe: "5m", candles: visible, zones,
      structure: { swings: swingPoints(visible), trend: "RANGE", lastBOS: null, lastCHOCH: null, hhCount: 0, hlCount: 0, lhCount: 0, llCount: 0 },
      profile: null, atr, price: visible[visible.length - 1].close,
      relVol: null, vwap: null, futuresAvailable: false, optionOiAvailable: false,
    });

    // track R1/R2/S1/S2 stability
    const key = [sr.scenario.levels.R1, sr.scenario.levels.R2, sr.scenario.levels.S1, sr.scenario.levels.S2]
      .map((x) => x?.zone.id ?? "-").join("|");
    if (selections.length) {
      selectionSteps++;
      if (selections[selections.length - 1] !== key) selectionChanges++;
    }
    selections.push(key);

    // ---- measure each zone's outcome over the NEXT horizon candles ----
    const horizon = done.slice(t + 1, t + 1 + criteria.horizonCandles);
    for (const z of sr.zones) {
      const existing = outcomes.get(z.id);
      if (existing?.touched) continue;             // already measured

      let firstTouch: number | null = null;
      for (let h = 0; h < horizon.length; h++) {
        const c = horizon[h];
        if (c.low <= z.top && c.high >= z.bottom) { firstTouch = h; break; }
      }

      if (firstTouch == null) {
        if (!existing) outcomes.set(z.id, {
          zoneId: z.id, zoneType: z.type, side: z.currentRole,
          touched: false, firstTouchIdx: null,
          favourableAtr: 0, adverseAtr: 0, reacted: false,
          invalidatedBeforeHorizon: false,
        });
        continue;
      }

      // measure excursions from the first-touch candle onward
      let fav = 0;
      let adv = 0;
      let invalidated = false;
      for (let h = firstTouch; h < horizon.length; h++) {
        const c = horizon[h];
        if (z.currentRole === "support") {
          fav = Math.max(fav, c.high - z.top);
          adv = Math.max(adv, z.bottom - c.low);
          if (c.close < z.bottom - 0.15 * atr) invalidated = true;
        } else {
          fav = Math.max(fav, z.bottom - c.low);
          adv = Math.max(adv, c.high - z.top);
          if (c.close > z.top + 0.15 * atr) invalidated = true;
        }
      }

      const favAtr = fav / atr;
      const advAtr = adv / atr;
      outcomes.set(z.id, {
        zoneId: z.id, zoneType: z.type, side: z.currentRole,
        touched: true, firstTouchIdx: firstTouch,
        favourableAtr: favAtr, adverseAtr: advAtr,
        reacted: favAtr >= criteria.requiredFavourableAtr && advAtr <= criteria.maxAdverseAtr,
        invalidatedBeforeHorizon: invalidated,
      });
    }
  }

  // ---- aggregate -------------------------------------------------------
  const all = [...outcomes.values()];
  const touched = all.filter((o) => o.touched);
  const reacted = touched.filter((o) => o.reacted);

  const bySource: Record<string, { zones: number; touched: number; reacted: number }> = {};
  for (const o of all) {
    const k = o.zoneType;
    const e = (bySource[k] ??= { zones: 0, touched: 0, reacted: 0 });
    e.zones++;
    if (o.touched) e.touched++;
    if (o.reacted) e.reacted++;
  }

  // ---- baseline: plain swing zones with NO confluence -----------------
  const baselineOutcomes = new Map<string, ZoneOutcome>();
  for (let t = warmup; t < done.length - criteria.horizonCandles; t += step) {
    const visible = done.slice(0, t + 1);
    const atr = atrFull[t] ?? 1;
    if (!atr || atr <= 0) continue;
    const zones = buildZones({
      candles: visible, atr, swings: swingPoints(visible),
      day: { prevHigh: 0, prevLow: 0, prevWeekHigh: null, prevWeekLow: null, orHigh: null, orLow: null },
      profile: null, consolidation: null, sweeps: [],
    }).filter((z) => z.type === "SWING_HIGH" || z.type === "SWING_LOW" || z.type === "EQUAL_HIGHS" || z.type === "EQUAL_LOWS");
    const horizon = done.slice(t + 1, t + 1 + criteria.horizonCandles);
    for (const z of zones) {
      if (baselineOutcomes.has(z.id)) continue;
      let firstTouch: number | null = null;
      for (let h = 0; h < horizon.length; h++) {
        const c = horizon[h];
        if (c.low <= z.top && c.high >= z.bottom) { firstTouch = h; break; }
      }
      if (firstTouch == null) {
        baselineOutcomes.set(z.id, { zoneId: z.id, zoneType: z.type, side: z.side as any, touched: false, firstTouchIdx: null, favourableAtr: 0, adverseAtr: 0, reacted: false, invalidatedBeforeHorizon: false });
        continue;
      }
      let fav = 0, adv = 0;
      for (let h = firstTouch; h < horizon.length; h++) {
        const c = horizon[h];
        if (z.side === "support") { fav = Math.max(fav, c.high - z.top); adv = Math.max(adv, z.bottom - c.low); }
        else { fav = Math.max(fav, z.bottom - c.low); adv = Math.max(adv, c.high - z.top); }
      }
      baselineOutcomes.set(z.id, {
        zoneId: z.id, zoneType: z.type, side: z.side as any, touched: true, firstTouchIdx: firstTouch,
        favourableAtr: fav / atr, adverseAtr: adv / atr,
        reacted: (fav / atr) >= criteria.requiredFavourableAtr && (adv / atr) <= criteria.maxAdverseAtr,
        invalidatedBeforeHorizon: false,
      });
    }
  }
  const bAll = [...baselineOutcomes.values()];
  const bTouched = bAll.filter((o) => o.touched);
  const bReacted = bTouched.filter((o) => o.reacted);

  return {
    criteria,
    totalZones: all.length,
    touchedZones: touched.length,
    touchRate: all.length ? touched.length / all.length : 0,
    reactionRate: touched.length ? reacted.length / touched.length : 0,
    avgFavourableAtr: touched.length ? touched.reduce((a, o) => a + o.favourableAtr, 0) / touched.length : 0,
    avgAdverseAtr: touched.length ? touched.reduce((a, o) => a + o.adverseAtr, 0) / touched.length : 0,
    invalidationRate: touched.length ? touched.filter((o) => o.invalidatedBeforeHorizon).length / touched.length : 0,
    selectionInstabilityRate: selectionSteps ? selectionChanges / selectionSteps : 0,
    byZoneSource: bySource,
    baseline: {
      zones: bAll.length,
      touchRate: bAll.length ? bTouched.length / bAll.length : 0,
      reactionRate: bTouched.length ? bReacted.length / bTouched.length : 0,
    },
    sampleSize: all.length,
    note:
      "Zone-behaviour metrics, NOT trade profitability. A touch rate is not a win rate. " +
      `Success was pre-registered as ≥ ${criteria.requiredFavourableAtr}×ATR favourable within ${criteria.horizonCandles} candles ` +
      `with ≤ ${criteria.maxAdverseAtr}×ATR adverse. Criteria were not changed after seeing results. ` +
      "Volume-profile and option-chain evidence were unavailable in this replay, so only structural zones were measured.",
  };
}

export { DEFAULT_SR_CONFIG, LEAVE_SEPARATION_ATR };
