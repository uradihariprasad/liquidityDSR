/**
 * Volume Profile engine.
 *
 * Method (documented): candles only carry OHLCV — the exact executed volume
 * at every price is NOT known. We therefore use a uniform-allocation
 * APPROXIMATION: each candle's volume is spread evenly across the price bins
 * its [low, high] range touches. This is standard for candle-based profiles
 * but is an approximation and is labelled as such everywhere it is shown.
 *
 * POC = bin with the highest allocated volume.
 * Value Area: expand from POC to neighbouring bins until `valueAreaPct`
 * (default 0.70) of total volume is covered (classic greedy expansion).
 * HVN = bins with volume >= 1.5 × mean bin volume (reported top 5).
 * LVN = bins with volume <= 0.5 × mean bin volume (reported top 5).
 *
 * POC/VAH/VAL/HVN/LVN are contextual references, not guaranteed S/R.
 *
 * ---------------------------------------------------------------------------
 * PERIOD SEMANTICS (audit fix)
 *
 * Callers pass the SAME candle series that drives the chart, the zone engine
 * and the movement classifier, so all three stay consistent by construction.
 * Since the chart merges prior sessions with today, the profile is
 * MULTI-SESSION by default. The result records exactly which sessions,
 * timestamps and candle count were used, plus when it was calculated, so the
 * UI can disclose the period rather than implying "today only".
 *
 * CONSISTENCY GUARDS (audit fix)
 *   - VAL must not exceed VAH
 *   - POC must lie inside the profile's own price range
 *   - every bin must have a finite price and non-negative volume
 *   - all reported levels are snapped to the instrument's tick size
 * If any guard fails the profile is rejected (returns null) rather than
 * returning levels that could be mapped to the wrong price.
 */

import type { Candle, VolumeProfileResult, VolumeProfileBin } from "./types";
import { clamp } from "./prng";

const IST_MS = 5.5 * 3600_000;

/** ist trading date for a timestamp */
function istDate(ts: number): string {
  return new Date(ts + IST_MS).toISOString().slice(0, 10);
}

/** Snap a price to the instrument's tick size (e.g. 0.05). */
function snapToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  return Math.round(price / tickSize) * tickSize;
}

export interface VolumeProfileOptions {
  /** instrument tick size in rupees (master value is paise, already converted) */
  tickSize?: number;
  /** 0..1 fraction of total volume inside the value area */
  valueAreaPct?: number;
  /** override the label for the period in the UI */
  periodLabel?: string;
}

export function volumeProfile(
  candles: Candle[],
  atr: number,
  valueAreaPctOrOpts: number | VolumeProfileOptions = 0.7,
  maybeOpts: VolumeProfileOptions = {},
): VolumeProfileResult | null {
  // accept both the historical number argument and an options object
  const opts: VolumeProfileOptions =
    typeof valueAreaPctOrOpts === "number" ? { ...maybeOpts, valueAreaPct: valueAreaPctOrOpts } : valueAreaPctOrOpts;
  const valueAreaPct = opts.valueAreaPct ?? 0.7;
  const tickSize = opts.tickSize && opts.tickSize > 0 ? opts.tickSize : 0;

  // Only COMPLETED candles feed the profile, so a forming bar can never
  // repaint the levels.
  const src = candles.filter((c) => !c.live);
  if (src.length < 20 || atr <= 0) return null;
  const hi = Math.max(...src.map((c) => c.high));
  const lo = Math.min(...src.map((c) => c.low));
  const range = hi - lo;
  if (range <= 0) return null;

  const binCount = clamp(Math.round(range / Math.max(atr * 0.22, range / 60)), 14, 64);
  const binSize = range / binCount;
  const vol = new Array(binCount).fill(0);
  const binFor = (p: number) => clamp(Math.floor((p - lo) / binSize), 0, binCount - 1);

  let totalVolume = 0;
  for (const c of src) {
    const a = binFor(c.low);
    const b = binFor(c.high);
    const n = b - a + 1;
    for (let i = a; i <= b; i++) vol[i] += c.volume / n;
    totalVolume += c.volume;
  }

  const bins: VolumeProfileBin[] = vol.map((v, i) => ({ price: lo + (i + 0.5) * binSize, volume: Math.round(v) }));

  // ---- GUARD: bins must be finite with non-negative volume --------------
  for (const b of bins) {
    if (!Number.isFinite(b.price) || !Number.isFinite(b.volume) || b.volume < 0) return null;
  }

  // POC
  let pocIdx = 0;
  for (let i = 1; i < binCount; i++) if (vol[i] > vol[pocIdx]) pocIdx = i;

  // Value area by greedy expansion from POC
  let covered = vol[pocIdx];
  let vahIdx = pocIdx;
  let valIdx = pocIdx;
  const target = totalVolume * valueAreaPct;
  while (covered < target && (vahIdx < binCount - 1 || valIdx > 0)) {
    const upV = vahIdx < binCount - 1 ? vol[vahIdx + 1] : -1;
    const dnV = valIdx > 0 ? vol[valIdx - 1] : -1;
    if (upV >= dnV) {
      vahIdx++;
      covered += upV;
    } else {
      valIdx--;
      covered += dnV;
    }
  }

  // Snap every reported level to the instrument's tick size so POC/VAH/VAL
  // can never land on a price the instrument cannot actually trade at.
  const poc = snapToTick(lo + (pocIdx + 0.5) * binSize, tickSize);
  const vah = snapToTick(lo + (vahIdx + 1) * binSize, tickSize);
  const val = snapToTick(lo + valIdx * binSize, tickSize);

  // ---- GUARD: VAL must not exceed VAH ----------------------------------
  // Greedy expansion can invert when the profile is degenerate (e.g. all
  // volume in one bin). Reject rather than emit an inverted value area.
  if (!(val <= vah)) return null;

  // ---- GUARD: POC must lie inside the profile's own price range --------
  if (!(poc >= lo && poc <= hi)) return null;

  // HVN / LVN
  const meanV = vol.reduce((a, b) => a + b, 0) / binCount;
  const hvn: { p: number; v: number }[] = [];
  const lvn: { p: number; v: number }[] = [];
  for (let i = 1; i < binCount - 1; i++) {
    const p = snapToTick(lo + (i + 0.5) * binSize, tickSize);
    if (vol[i] >= meanV * 1.5 && vol[i] >= vol[i - 1] && vol[i] >= vol[i + 1]) hvn.push({ p, v: vol[i] });
    if (vol[i] <= meanV * 0.5 && vol[i] <= vol[i - 1] && vol[i] <= vol[i + 1]) lvn.push({ p, v: vol[i] });
  }
  const hvns = hvn.sort((a, b) => b.v - a.v).slice(0, 5).map((x) => x.p);
  const lvns = lvn.sort((a, b) => a.v - b.v).slice(0, 5).map((x) => x.p);

  // Position classification.
  // `price` is the close of the LAST COMPLETED candle of the SAME series the
  // profile was built from, and it is compared against THIS profile's own
  // vah/val — never against another timeframe's or another instrument's.
  const price = src[src.length - 1].close;
  const tol = atr * 0.12;
  let position: VolumeProfileResult["position"] = "INSIDE_VALUE";
  let positionDetail = "Price is trading inside the developing value area.";
  const lastCloses = src.slice(-4).map((c) => c.close);
  if (Math.abs(price - vah) <= tol) {
    position = "TESTING_VAH";
    positionDetail = "Price is within 0.12×ATR of Value Area High — a value-boundary test is in progress.";
  } else if (Math.abs(price - val) <= tol) {
    position = "TESTING_VAL";
    positionDetail = "Price is within 0.12×ATR of Value Area Low — a value-boundary test is in progress.";
  } else if (price > vah && lastCloses.every((c) => c > vah)) {
    position = "ACCEPTING_ABOVE";
    positionDetail = "Multiple closes above VAH — the market is accepting prices above the prior value area.";
  } else if (price < val && lastCloses.every((c) => c < val)) {
    position = "ACCEPTING_BELOW";
    positionDetail = "Multiple closes below VAL — the market is accepting prices below the prior value area.";
  } else {
    const recent = src.slice(-10);
    const crosses = recent.slice(1).filter((c, i) => (c.close - poc) * (recent[i].close - poc) < 0).length;
    const r = Math.max(...recent.map((c) => c.high)) - Math.min(...recent.map((c) => c.low));
    if (crosses >= 3 && r < atr * 1.6) {
      position = "ROTATING_AROUND_POC";
      positionDetail = "Price has crossed the Point of Control repeatedly within a tight range — balance around fairest price.";
    }
  }

  // ---- Period metadata (audit fix: disclose what was actually used) -----
  const sessions = [...new Set(src.map((c) => istDate(c.ts)))].sort();
  const timeframeMin =
    src.length > 1 ? Math.max(1, Math.round((src[1].ts - src[0].ts) / 60000)) : 1;

  return {
    method: "UNIFORM_ALLOCATION_FROM_OHLCV",
    approximation: true,
    bins,
    poc,
    vah,
    val,
    hvns,
    lvns,
    valueAreaPct,
    position,
    positionDetail,
    totalVolume,
    // --- period / provenance ---
    period: opts.periodLabel ?? (sessions.length > 1 ? "MULTI_SESSION" : "SINGLE_SESSION"),
    sessions,
    sessionCount: sessions.length,
    fromTs: src[0].ts,
    toTs: src[src.length - 1].ts,
    priceLow: lo,
    priceHigh: hi,
    binSize,
    binCount,
    candlesUsed: src.length,
    timeframe: `${timeframeMin}m`,
    tickSize: tickSize || null,
    calculatedAt: Date.now(),
    consistency: { valLeVah: true, pocInRange: true, binsValid: true },
  };
}
