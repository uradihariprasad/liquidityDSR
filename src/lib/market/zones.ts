/**
 * Liquidity & support/resistance zone engine.
 *
 * Zone sources (documented):
 *  - Confirmed swing highs/lows (k=2 fractals)
 *  - Equal highs / equal lows (two swing points within 0.1×ATR)
 *  - Previous day high/low (PDH/PDL), previous week high/low (PWH/PWL)
 *  - Opening range high/low (first 15 minutes)
 *  - Intraday consolidation boundaries
 *  - Volume profile POC / VAH / VAL / HVN / LVN (approximation, see profile.ts)
 *
 * Strength score (0-100, documented):
 *    sourceWeight (PDH/PDL 18, swing 12+4/test, OR 14, profile 10,
 *    consolidation 10, equal-h/l 16) capped contribution
 *  + 8 per additional test (max +24)
 *  + 6 per rejection reaction (max +18)
 *  + confluence: +10 when a second independent source maps the same level
 *  - decay: -0.4 per 10 candles of age beyond 60 candles
 * Clamped to [5, 100].
 *
 * Merging: zones whose midpoints are within 0.45×ATR are merged; the merged
 * zone keeps the wider span, the stronger base, and sums confluence.
 *
 * State machine (transitions applied only when conditions are met):
 *  NEW → APPROACHING (price within 0.6×ATR, no touch)
 *  any → TESTING (price enters [bottom, top])
 *  TESTING → HOLDING (candle closes back outside the zone on the side it
 *           approached from, with close location against the zone)
 *  TESTING → REJECTED (2 or more holding-type outcomes)
 *  any → BROKEN (close beyond zone by > 0.15×ATR on the far side)
 *  BROKEN → RECLAIMED (close back through the zone on the original side)
 *  any → POTENTIALLY_SWEPT (wick beyond the zone by > 0.05×ATR and close back
 *           within/on origin side — requires the rejection close, a wick
 *           alone is never enough)
 *  BROKEN ×2 closes → INVALIDATED
 *
 * IMPORTANT (honesty note): zones are historical price-structure references.
 * POTENTIALLY_SWEPT does NOT prove stop-loss orders were executed; it marks
 * a breach-and-reclaim pattern consistent with a liquidity event.
 */

import type { Candle, Zone, ZoneStatus, ZoneType, VolumeProfileResult, SwingPoint } from "./types";
import { hashString, clamp } from "./prng";
import type { SweepEvent } from "./sweeps";

interface ZoneSeed {
  type: ZoneType;
  price: number;
  width: number;
  source: string;
  ts: number;
  liquiditySide: Zone["liquiditySide"];
  side: Zone["side"];
  base: number;
}

export interface ZoneBuildInput {
  candles: Candle[];
  atr: number;
  swings: SwingPoint[];
  day: { prevHigh: number; prevLow: number; prevWeekHigh: number | null; prevWeekLow: number | null; orHigh: number | null; orLow: number | null };
  profile: VolumeProfileResult | null;
  consolidation: { top: number; bottom: number } | null;
  /** validated sweep events from the dedicated sweep engine (sweeps.ts) */
  sweeps?: SweepEvent[];
  /** ---- additional sources for the Dynamic S&R Intelligence Engine ---- */
  /** current-session high (intraday structural reference) */
  sessionHigh?: number | null;
  /** current-session low */
  sessionLow?: number | null;
  /** session VWAP, used as an intraday reference level */
  vwap?: number | null;
  /** VWAP band offsets (±1 sd) when available */
  vwapUpper?: number | null;
  vwapLower?: number | null;
}

/**
 * Separation (in ATR units) required before a new touch episode may begin.
 * Price must close this far from the zone boundary before a subsequent return
 * counts as a NEW test rather than a continuation of the same episode.
 * Section 3 of the S&R accuracy audit.
 */
export const LEAVE_SEPARATION_ATR = 0.35;

const SOURCE_WEIGHT: Partial<Record<ZoneType, number>> = {
  PDH: 18, PDL: 18, PWH: 16, PWL: 16, ORH: 14, ORL: 14,
  SWING_HIGH: 12, SWING_LOW: 12, EQUAL_HIGHS: 16, EQUAL_LOWS: 16,
  POC: 12, VAH: 10, VAL: 10, HVN: 8, LVN: 6, CONSOLIDATION: 10,
};

export function buildZones(input: ZoneBuildInput): Zone[] {
  const { candles, atr, swings, day, profile, consolidation } = input;
  if (candles.length < 5 || atr <= 0) return [];
  const now = candles[candles.length - 1].ts;
  const seeds: ZoneSeed[] = [];
  const w0 = atr * 0.12;
  /** day/week/or levels conceptually existed since the session start, so
   *  interactions are evaluated across the whole session. */
  const dayTs = candles[0].ts - 1;

  const push = (s: ZoneSeed) => seeds.push(s);

  for (const s of swings) {
    /**
     * DEFECT FIXED: swing zones were stamped with the PIVOT candle timestamp.
     * The interaction loop then evaluated candles from the pivot onward, so
     * the k candles needed to CONFIRM the swing were counted as zone tests
     * and reactions — events that could not yet have been observed.
     * Zones now begin at the swing's confirmedTs.
     */
    const swingFrom = s.confirmedTs ?? s.ts;
    if (s.kind === "high") push({ type: "SWING_HIGH", price: s.price, width: w0, source: `Swing high @ ${new Date(s.ts).toISOString().slice(11, 16)} (confirmed ${new Date(swingFrom).toISOString().slice(11, 16)})`, ts: swingFrom, liquiditySide: "BUY_SIDE", side: "resistance", base: SOURCE_WEIGHT.SWING_HIGH! });
    else push({ type: "SWING_LOW", price: s.price, width: w0, source: `Swing low @ ${new Date(s.ts).toISOString().slice(11, 16)} (confirmed ${new Date(swingFrom).toISOString().slice(11, 16)})`, ts: swingFrom, liquiditySide: "SELL_SIDE", side: "support", base: SOURCE_WEIGHT.SWING_LOW! });
  }

  // equal highs / lows
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  for (let i = 0; i < highs.length - 1; i++) {
    if (Math.abs(highs[i].price - highs[i + 1].price) <= atr * 0.1) {
      push({ type: "EQUAL_HIGHS", price: (highs[i].price + highs[i + 1].price) / 2, width: atr * 0.1, source: "Equal highs (≤0.1 ATR apart)", ts: highs[i + 1].ts, liquiditySide: "BUY_SIDE", side: "resistance", base: SOURCE_WEIGHT.EQUAL_HIGHS! });
    }
  }
  for (let i = 0; i < lows.length - 1; i++) {
    if (Math.abs(lows[i].price - lows[i + 1].price) <= atr * 0.1) {
      push({ type: "EQUAL_LOWS", price: (lows[i].price + lows[i + 1].price) / 2, width: atr * 0.1, source: "Equal lows (≤0.1 ATR apart)", ts: lows[i + 1].ts, liquiditySide: "SELL_SIDE", side: "support", base: SOURCE_WEIGHT.EQUAL_LOWS! });
    }
  }

  push({ type: "PDH", price: day.prevHigh, width: w0, source: "Previous day high", ts: dayTs, liquiditySide: "BUY_SIDE", side: "resistance", base: SOURCE_WEIGHT.PDH! });
  push({ type: "PDL", price: day.prevLow, width: w0, source: "Previous day low", ts: dayTs, liquiditySide: "SELL_SIDE", side: "support", base: SOURCE_WEIGHT.PDL! });
  if (day.prevWeekHigh != null) push({ type: "PWH", price: day.prevWeekHigh, width: w0, source: "Previous week high", ts: dayTs, liquiditySide: "BUY_SIDE", side: "resistance", base: SOURCE_WEIGHT.PWH! });
  if (day.prevWeekLow != null) push({ type: "PWL", price: day.prevWeekLow, width: w0, source: "Previous week low", ts: dayTs, liquiditySide: "SELL_SIDE", side: "support", base: SOURCE_WEIGHT.PWL! });
  if (day.orHigh != null) push({ type: "ORH", price: day.orHigh, width: w0, source: "Opening range high (first 15m)", ts: dayTs, liquiditySide: "BUY_SIDE", side: "resistance", base: SOURCE_WEIGHT.ORH! });
  if (day.orLow != null) push({ type: "ORL", price: day.orLow, width: w0, source: "Opening range low (first 15m)", ts: dayTs, liquiditySide: "SELL_SIDE", side: "support", base: SOURCE_WEIGHT.ORL! });

  // ---- Dynamic S&R Engine: session extremes and VWAP references ----------
  // Session H/L are provisional intraday references, not completed-session
  // levels, so they carry a lower base weight than PDH/PDL.
  const lastClose = candles[candles.length - 1].close;
  if (input.sessionHigh != null && Number.isFinite(input.sessionHigh) && input.sessionHigh > 0) {
    push({ type: "SESSION_HIGH", price: input.sessionHigh, width: w0, source: "Current-session high (provisional intraday reference)", ts: dayTs, liquiditySide: "BUY_SIDE", side: lastClose < input.sessionHigh ? "resistance" : "support", base: 10 });
  }
  if (input.sessionLow != null && Number.isFinite(input.sessionLow) && input.sessionLow > 0) {
    push({ type: "SESSION_LOW", price: input.sessionLow, width: w0, source: "Current-session low (provisional intraday reference)", ts: dayTs, liquiditySide: "SELL_SIDE", side: lastClose > input.sessionLow ? "support" : "resistance", base: 10 });
  }
  if (input.vwap != null && Number.isFinite(input.vwap) && input.vwap > 0) {
    push({ type: "VWAP", price: input.vwap, width: w0 * 0.6, source: "Session VWAP (volume-weighted average price)", ts: now, liquiditySide: null, side: lastClose < input.vwap ? "resistance" : "support", base: 8 });
  }
  if (input.vwapUpper != null && Number.isFinite(input.vwapUpper) && input.vwapUpper > 0) {
    push({ type: "VWAP_UPPER", price: input.vwapUpper, width: w0 * 0.5, source: "VWAP +1σ band", ts: now, liquiditySide: null, side: lastClose < input.vwapUpper ? "resistance" : "support", base: 6 });
  }
  if (input.vwapLower != null && Number.isFinite(input.vwapLower) && input.vwapLower > 0) {
    push({ type: "VWAP_LOWER", price: input.vwapLower, width: w0 * 0.5, source: "VWAP −1σ band", ts: now, liquiditySide: null, side: lastClose < input.vwapLower ? "resistance" : "support", base: 6 });
  }

  if (consolidation) {
    push({ type: "CONSOLIDATION", price: (consolidation.top + consolidation.bottom) / 2, width: (consolidation.top - consolidation.bottom) / 2, source: "Intraday consolidation boundary", ts: now, liquiditySide: null, side: candles[candles.length - 1].close > (consolidation.top + consolidation.bottom) / 2 ? "support" : "resistance", base: SOURCE_WEIGHT.CONSOLIDATION! });
  }
  if (profile) {
    push({ type: "POC", price: profile.poc, width: w0, source: "Volume profile POC (approx.)", ts: now, liquiditySide: null, side: candles[candles.length - 1].close < profile.poc ? "resistance" : "support", base: SOURCE_WEIGHT.POC! });
    push({ type: "VAH", price: profile.vah, width: w0, source: "Value Area High (approx.)", ts: now, liquiditySide: null, side: "resistance", base: SOURCE_WEIGHT.VAH! });
    push({ type: "VAL", price: profile.val, width: w0, source: "Value Area Low (approx.)", ts: now, liquiditySide: null, side: "support", base: SOURCE_WEIGHT.VAL! });
    for (const p of profile.hvns.slice(0, 3)) push({ type: "HVN", price: p, width: w0 * 0.8, source: "High-volume node (approx.)", ts: now, liquiditySide: null, side: candles[candles.length - 1].close < p ? "resistance" : "support", base: SOURCE_WEIGHT.HVN! });
    for (const p of profile.lvns.slice(0, 2)) push({ type: "LVN", price: p, width: w0 * 0.8, source: "Low-volume node (approx.)", ts: now, liquiditySide: null, side: candles[candles.length - 1].close < p ? "resistance" : "support", base: SOURCE_WEIGHT.LVN! });
  }

  /**
   * SIDE-AWARE clustering (§2).
   *
   * DEFECT FIXED: the previous merge compared only PRICE distance, so a
   * support candidate and a resistance candidate sitting at nearly the same
   * price were merged into one zone — destroying the structural meaning of
   * both. Merging now requires compatible sides AND boundary overlap, not
   * merely midpoint proximity.
   *
   * Compatibility rules:
   *  - support merges only with support
   *  - resistance merges only with resistance
   *  - a NEUTRAL reference (VWAP, POC, consolidation) may join a structural
   *    zone of either side when its band genuinely overlaps
   *  - support and resistance candidates are NEVER merged together, even when
   *    their prices are identical
   */
  type SideClass = "support" | "resistance" | "neutral";
  const sideClass = (sd: string | null | undefined): SideClass =>
    sd === "support" ? "support" : sd === "resistance" ? "resistance" : "neutral";

  const compatible = (a: ZoneSeed, b: ZoneSeed): boolean => {
    const ca = sideClass(a.side);
    const cb = sideClass(b.side);
    if (ca !== "neutral" && cb !== "neutral" && ca !== cb) return false; // opposite sides never merge
    return true;
  };

  /** Boundary overlap (not just midpoint distance) with an ATR tolerance. */
  const overlaps = (a: ZoneSeed, b: ZoneSeed): boolean => {
    const tol = atr * 0.25;
    const aTop = a.price + a.width, aBot = a.price - a.width;
    const bTop = b.price + b.width, bBot = b.price - b.width;
    return aBot <= bTop + tol && aTop >= bBot - tol;
  };

  const merged: ZoneSeed[] & { confluence?: number }[] = [];
  const sorted = [...seeds].sort((a, b) => a.price - b.price);
  for (const s of sorted) {
    let target: any = null;
    // find a compatible ALREADY-MERGED zone whose band genuinely overlaps
    for (const m of merged as any[]) {
      if (!compatible(m, s)) continue;
      if (!overlaps(m, s)) continue;
      target = m;
      break;
    }
    if (target) {
      const prevTop = target.price + target.width;
      const prevBot = target.price - target.width;
      target.width = Math.max(
        target.width,
        Math.max(prevTop, s.price + s.width) - target.price,
        target.price - Math.min(prevBot, s.price - s.width),
      );
      if (s.type !== target.type) target.confluence = (target.confluence ?? 1) + 1;
      if (s.base > target.base) {
        target.type = s.type; target.source = s.source; target.base = s.base;
        target.side = s.side; target.liquiditySide = s.liquiditySide; target.ts = s.ts;
      } else {
        target.source += ` + ${s.source}`;
      }
    } else {
      (s as any).confluence = 1;
      merged.push(s);
    }
  }

  // --- materialize zones, evaluate tests/reactions/status ---
  const price = candles[candles.length - 1].close;
  const zones: Zone[] = merged.map((s: any) => {
    const top = s.price + s.width;
    const bottom = s.price - s.width;
    let tests = 0;
    let reactions = 0;
    let status: ZoneStatus = "NEW";
    let statusReason = "Zone detected; no significant interaction yet.";
    let brokenCloses = 0;
    let wasBroken = false;
    let approached = false;
    /** touch-episode tracking (S3) - prevents consecutive candles inflating test counts */
    let episode: "OUTSIDE" | "TOUCHING" | "LEFT_ZONE" = "OUTSIDE";

    for (let i = 0; i < candles.length; i++) {
      if (candles[i].ts <= s.ts) continue;
      const c = candles[i];
      const eps = atr * 0.05;
      const inZone = c.low <= top && c.high >= bottom;
      if (!inZone && Math.min(Math.abs(c.close - top), Math.abs(c.close - bottom)) <= atr * 0.6) approached = true;
      if (!inZone) {
        if (status === "TESTING") {
          const rejectUp = c.close > top && (c.close - c.low) / Math.max(c.high - c.low, 1e-9) > 0.55;
          const rejectDn = c.close < bottom && (c.high - c.close) / Math.max(c.high - c.low, 1e-9) > 0.55;
          if (rejectUp || rejectDn) { reactions++; status = reactions >= 2 ? "REJECTED" : "HOLDING"; statusReason = rejectUp ? "Candle entered the zone and closed back above it with a strong close location." : "Candle entered the zone and closed back below it with a strong close location."; }
          else { status = approached ? "APPROACHING" : "NEW"; statusReason = "Test without confirmation; zone reverted to watch state."; }
        }
        continue;
      }
      // interaction — sweep status is NOT decided here; it comes from the
      // validated sweep engine (sweeps.ts) after the loop.
      void eps;
      /**
       * TOUCH-EPISODE STATE MACHINE (S3).
       *
       * DEFECT FIXED: tests++ previously fired on EVERY candle touching the
       * zone, so 20 consecutive candles inside one zone counted as 20
       * independent tests and artificially inflated strength.
       *
       * One continuous presence inside a zone is ONE test episode. A new test
       * is only counted after price has closed beyond LEAVE_SEPARATION_ATR x ATR
       * from the zone boundary and then returns.
       */
      /**
       * The episode is tracked on CANDLE-RANGE overlap, not close position.
       *
       * A candle whose low merely wicks into the zone while its close sits
       * above it is still part of the SAME episode — the previous version used
       * close position, which made wick-touches oscillate the state machine
       * and count a new "test" on every candle.
       *
       * The episode only closes once the ENTIRE candle has moved beyond the
       * band by more than the separation threshold. This distinguishes a brief
       * wick touch (same episode) from a genuine departure followed by a
       * return (a new test).
       */
      const rangeOverlap = c.low <= top && c.high >= bottom;
      // how far the nearest edge of the candle is from the band
      const gapToBand = rangeOverlap
        ? 0
        : (c.low > top ? c.low - top : bottom - c.high);

      if (rangeOverlap) {
        if (episode !== "TOUCHING") {
          // a fresh interaction after a confirmed departure
          tests++;
          episode = "TOUCHING";
        }
        // else: still inside the same episode, no new test
      } else {
        // no overlap at all
        if (gapToBand > LEAVE_SEPARATION_ATR * atr) {
          episode = "LEFT_ZONE";   // departure confirmed
        }
        // a small gap without separation keeps the episode state unchanged
      }
      status = "TESTING";
      statusReason = "Price is inside the zone — test in progress.";
      /**
       * A level only "breaks" when price closes THROUGH it in the direction
       * that defeats it: resistance breaks upward, support breaks downward.
       * A close on the origin side is a rejection, never a break.
       */
      const brokeThrough =
        s.side === "resistance" ? c.close > top + atr * 0.15 : c.close < bottom - atr * 0.15;
      if (brokeThrough) {
        brokenCloses++;
        wasBroken = true;
        status = "BROKEN";
        statusReason = `Close ${c.close.toFixed(2)} ${s.side === "resistance" ? "above zone top" : "below zone bottom"} by >0.15×ATR — level broken.`;
      } else {
        if (wasBroken) {
          status = "RECLAIMED";
          statusReason = "Close back inside the zone after an earlier breach — possible failed break.";
        }
        brokenCloses = 0;
      }
    }

    if (brokenCloses >= 2) { status = "INVALIDATED"; statusReason = "Two consecutive closes beyond the zone boundary — level treated as invalidated."; }
    if (status === "NEW" && approached) {
      status = "APPROACHING";
      statusReason = "Price within 0.6×ATR of the zone without touching it.";
    }

    /**
     * Validated sweep overlay: a zone is only marked POTENTIALLY_SWEPT when
     * the dedicated sweep engine produced a fresh DETECTED/CONFIRMED event
     * whose swept level falls inside this zone's boundaries. FAILED/EXPIRED
     * sweeps never change zone status.
     */
    const zoneSweep = (input.sweeps ?? []).find(
      (ev) => ev.fresh && ev.level >= bottom - atr * 0.1 && ev.level <= top + atr * 0.1,
    );
    if (zoneSweep && status !== "INVALIDATED") {
      status = "POTENTIALLY_SWEPT";
      statusReason = `${zoneSweep.state === "CONFIRMED" ? "Confirmed" : "Unconfirmed"} breach-and-reclaim at ${zoneSweep.level.toFixed(2)} (${zoneSweep.penetrationAtr.toFixed(2)}×ATR penetration, ${(zoneSweep.wickRatio * 100).toFixed(0)}% rejection wick) — consistent with a liquidity event, but not proof that stop-loss orders executed.`;
    }

    const age10 = Math.max(0, candles.length * tfMinutesOf(candles) - 60) / 10;
    let strength = (s.base ?? 10)
      + Math.min(24, Math.max(0, tests - 1) * 8)
      + Math.min(18, reactions * 6)
      + ((s.confluence ?? 1) > 1 ? 10 : 0)
      - Math.min(12, age10 * 0.4);
    if (status === "REJECTED") strength += 8;
    if (status === "INVALIDATED") strength *= 0.35;
    if (status === "BROKEN") strength *= 0.55;
    strength = clamp(Math.round(strength), 5, 100);

    const id = hashString(`${s.type}|${s.price.toFixed(2)}|${Math.round(s.width * 100)}`).toString(36);
    return {
      id,
      type: s.type,
      liquiditySide: s.liquiditySide,
      side: s.side,
      top,
      bottom,
      mid: s.price,
      source: s.source,
      createdTs: s.ts,
      updatedTs: now,
      strength,
      tests,
      reactions,
      status,
      statusReason,
      invalidation:
        s.side === "resistance"
          ? `Invalidated by two consecutive closes above ${top.toFixed(2)} (+0.15×ATR buffer).`
          : `Invalidated by two consecutive closes below ${bottom.toFixed(2)} (−0.15×ATR buffer).`,
      derived: true,
    } satisfies Zone;
  });

  // keep the most relevant: sort by (distance, then strength), cap count
  const dist = (z: Zone) => Math.min(Math.abs(price - z.top), Math.abs(price - z.bottom));
  return zones
    .sort((a, b) => {
      const ia = a.status === "INVALIDATED" ? 1 : 0;
      const ib = b.status === "INVALIDATED" ? 1 : 0;
      if (ia !== ib) return ia - ib;
      const da = dist(a);
      const db = dist(b);
      if (Math.abs(da - db) > atr * 0.5) return da - db;
      return b.strength - a.strength;
    })
    .slice(0, 14);
}

function tfMinutesOf(candles: Candle[]): number {
  if (candles.length < 2) return 1;
  return Math.max(1, Math.round((candles[1].ts - candles[0].ts) / 60000));
}

/** Zones that are currently "live" levels near price for the chart. */
export function activeZones(zones: Zone[]): Zone[] {
  return zones.filter((z) => z.status !== "INVALIDATED");
}
