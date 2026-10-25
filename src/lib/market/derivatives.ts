/**
 * Futures & options intelligence (LIVE mode only — requires Upstox).
 *
 * Futures price/OI relationship (documented conventional mapping, always
 * labelled PROVISIONAL):
 *   price ↑, OI ↑  → LONG_BUILDUP      | price ↑, OI ↓  → SHORT_COVERING
 *   price ↓, OI ↑  → SHORT_BUILDUP     | price ↓, OI ↓  → LONG_UNWINDING
 * OI alone cannot identify who initiated trades or their intent; these are
 * descriptive combinations, not positioning facts.
 *
 * Option-chain strike labels (documented rules, applied only to real chain
 * data): for strikes within ±8% of spot, using OI + change-in-OI + volume:
 *   SUPPORT family (strikes below spot): rank by put OI.
 *     Strong Support       = top put-OI strike band AND ΔPutOI > +2% of mean Δ|OI|
 *     Support Strengthening= put OI rising (ΔPutOI > 0) over the window
 *     Weak Support         = put OI present but below 40th percentile of band
 *     Support Weakening    = ΔPutOI < −2% of mean Δ|OI|
 *     Support Breakdown Risk = price within 0.5 ATR-equivalent of strike AND
 *                              ΔPutOI < 0 AND price change negative
 *   RESISTANCE family mirrors with call OI above spot.
 * Rationale limitations are attached to every label: OI change does not
 * prove writer vs buyer initiation.
 */

export type StrikeLabel =
  | "STRONG_SUPPORT" | "SUPPORT_STRENGTHENING" | "WEAK_SUPPORT" | "SUPPORT_WEAKENING" | "SUPPORT_BREAKDOWN_RISK"
  | "STRONG_RESISTANCE" | "RESISTANCE_STRENGTHENING" | "WEAK_RESISTANCE" | "RESISTANCE_WEAKENING" | "RESISTANCE_BREAKOUT_RISK";

export interface StrikeIntel {
  strike: number;
  /** null when the source did not supply a valid value */
  callOI: number | null;
  putOI: number | null;
  /** null when either current or previous OI was missing/invalid */
  callDeltaOI: number | null;
  putDeltaOI: number | null;
  callVol: number;
  putVol: number;
  label: StrikeLabel;
  rule: string;
  caveat: string;
  ts: number;
}

export interface FuturesIntel {
  available: boolean;
  reason: string;
  symbol: string;
  futuresKey?: string;
  price: number | null;
  change: number | null;
  volume: number | null;
  oi: number | null;
  deltaOI: number | null;
  basis: number | null;
  priceOI: { label: string; provisional: boolean; caveat: string } | null;
  ts: number | null;
}

export interface OptionChainIntel {
  available: boolean;
  reason: string;
  underlying: string;
  expiry: string | null;
  spot: number | null;
  pcr: number | null;
  /** how many strikes actually contributed to PCR, and how many were dropped */
  pcrValidStrikes: { call: number; put: number; dropped: number };
  pcrScope: string;
  strikes: StrikeIntel[];
  ts: number | null;
}

export function interpretPriceOI(priceChange: number, deltaOI: number): FuturesIntel["priceOI"] {
  if (Math.abs(priceChange) < 1e-9 && Math.abs(deltaOI) < 1e-9) return null;
  const up = priceChange > 0;
  const oiUp = deltaOI > 0;
  const label = up && oiUp ? "LONG_BUILDUP" : up && !oiUp ? "SHORT_COVERING" : !up && oiUp ? "SHORT_BUILDUP" : "LONG_UNWINDING";
  return {
    label,
    provisional: true,
    caveat: "Conventional price/OI combination. OI cannot identify trade initiators or opening vs closing intent; treat as provisional context only.",
  };
}

/**
 * Parse an OI value, distinguishing MISSING from a GENUINE ZERO.
 *
 * DEFECT FIXED: the previous code used `Number(x ?? 0)`, which turned a
 * missing `prev_oi` into 0 and therefore computed
 *   ChangeInOI = currentOI - 0 = currentOI
 * — a fabricated positive change equal to the entire current OI.
 *
 * Upstox documents `prev_oi` as "the number of open positions that were
 * outstanding at the end of the previous trading day/session". When it is
 * absent, non-numeric or negative, Change in OI is UNAVAILABLE (null) —
 * never zero, and never a fabricated value.
 */
function parseOi(v: unknown): number | null {
  if (v === null || v === undefined) return null;      // missing -> unavailable
  const n = Number(v);
  if (!Number.isFinite(n)) return null;                // malformed -> unavailable
  if (n < 0) return null;                              // negative is invalid
  return n;                                            // 0 is a GENUINE zero
}

/** Change in OI only when BOTH values are valid and comparable. */
function deltaOi(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null) return null;
  return cur - prev;
}

export function classifyStrikes(chainRows: any[], spot: number, atr: number): OptionChainIntel {
  const rows = (chainRows ?? [])
    .map((r: any) => {
      const callOi = parseOi(r.call_options?.market_data?.oi);
      const putOi = parseOi(r.put_options?.market_data?.oi);
      const callPrevOi = parseOi(r.call_options?.market_data?.prev_oi);
      const putPrevOi = parseOi(r.put_options?.market_data?.prev_oi);
      return {
        strike: Number(r.strike_price),
        callOI: callOi,
        putOI: putOi,
        callDeltaOI: deltaOi(callOi, callPrevOi),
        putDeltaOI: deltaOi(putOi, putPrevOi),
        callVol: Number(r.call_options?.market_data?.volume ?? 0),
        putVol: Number(r.put_options?.market_data?.volume ?? 0),
      };
    })
    .filter((r) => Number.isFinite(r.strike) && r.strike > 0 && Math.abs(r.strike - spot) / spot <= 0.08);
  if (!rows.length) {
    return { available: false, reason: "No option-chain rows within ±8% of spot for the selected expiry.", underlying: "", expiry: null, spot, pcr: null, pcrValidStrikes: { call: 0, put: 0, dropped: 0 }, pcrScope: "", strikes: [], ts: Date.now() };
  }
  /**
   * PCR and every downstream ranking use ONLY strikes with VALID OI.
   *
   * DEFECT FIXED: previously missing OI was coerced to 0, so PCR was computed
   * over understated sums and strike percentile ranks were distorted. Now
   * invalid strikes are excluded from each side's aggregate and the dropped
   * count is reported.
   */
  const validCall = rows.filter((r) => r.callOI != null);
  const validPut = rows.filter((r) => r.putOI != null);
  const sumCall = validCall.reduce((a, r) => a + (r.callOI as number), 0);
  const sumPut = validPut.reduce((a, r) => a + (r.putOI as number), 0);
  const droppedOiStrikes = rows.length * 2 - validCall.length - validPut.length;

  // meanAbsDelta uses only strikes where ΔOI is genuinely computable
  const deltaPairs = rows.filter((r) => r.callDeltaOI != null || r.putDeltaOI != null);
  const meanAbsDelta = Math.max(
    1,
    deltaPairs.reduce((a, r) => a + Math.abs(r.callDeltaOI ?? 0) + Math.abs(r.putDeltaOI ?? 0), 0) / Math.max(1, deltaPairs.length * 2),
  );
  const putOIs = validPut.map((r) => r.putOI as number).sort((a, b) => a - b);
  const callOIs = validCall.map((r) => r.callOI as number).sort((a, b) => a - b);
  const pctl = (sorted: number[], v: number) => sorted.filter((x) => x <= v).length / Math.max(1, sorted.length);

  const maxPutOI = putOIs.length ? putOIs[putOIs.length - 1] : 0;
  const maxCallOI = callOIs.length ? callOIs[callOIs.length - 1] : 0;

  const strikes: StrikeIntel[] = [];
  const caveat = "Strike labels use OI + ΔOI + volume heuristics. OI change does not prove writer vs buyer initiation or intent.";
  for (const r of rows) {
    const below = r.strike <= spot;
    let label: StrikeLabel | null = null;
    let rule = "";

    /**
     * A strike is only classified when its CURRENT OI is valid for the side
     * being assessed. Missing OI no longer coerces to zero.
     *
     * Labels that depend on ΔOI additionally require a valid ΔOI. When
     * `prev_oi` is absent the change-dependent labels are SUPPRESSED rather
     * than computed from a fabricated value.
     */
    if (below) {
      if (r.putOI == null) continue;                       // no valid put OI -> unclassifiable
      const dPut = r.putDeltaOI;                            // null when prev_oi missing
      if (dPut != null && r.putOI >= maxPutOI * 0.9 && r.putOI > 0 && dPut > meanAbsDelta * 0.02) { label = "STRONG_SUPPORT"; rule = "Highest put-OI band with fresh put-OI addition (> 2% of mean |ΔOI|)."; }
      else if (dPut != null && dPut > meanAbsDelta * 0.02 && r.putOI > putOIs[Math.floor(putOIs.length * 0.4)]) { label = "SUPPORT_STRENGTHENING"; rule = "Put OI rising while put-OI rank above the 40th percentile."; }
      else if (r.putOI > 0 && pctl(putOIs, r.putOI) <= 0.4) { label = "WEAK_SUPPORT"; rule = "Put OI below the 40th percentile of the strike band."; }
      else if (dPut != null && dPut < -meanAbsDelta * 0.02) { label = spot - r.strike <= atr * 0.5 ? "SUPPORT_BREAKDOWN_RISK" : "SUPPORT_WEAKENING"; rule = label === "SUPPORT_BREAKDOWN_RISK" ? "Spot within 0.5×ATR of strike + put OI shedding — support at risk." : "Put OI shedding (> 2% of mean |ΔOI|)."; }
    } else {
      if (r.callOI == null) continue;                      // no valid call OI -> unclassifiable
      const dCall = r.callDeltaOI;
      if (dCall != null && r.callOI >= maxCallOI * 0.9 && r.callOI > 0 && dCall > meanAbsDelta * 0.02) { label = "STRONG_RESISTANCE"; rule = "Highest call-OI band with fresh call-OI addition."; }
      else if (dCall != null && dCall > meanAbsDelta * 0.02 && r.callOI > callOIs[Math.floor(callOIs.length * 0.4)]) { label = "RESISTANCE_STRENGTHENING"; rule = "Call OI rising while call-OI rank above the 40th percentile."; }
      else if (r.callOI > 0 && pctl(callOIs, r.callOI) <= 0.4) { label = "WEAK_RESISTANCE"; rule = "Call OI below the 40th percentile of the strike band."; }
      else if (dCall != null && dCall < -meanAbsDelta * 0.02) { label = r.strike - spot <= atr * 0.5 ? "RESISTANCE_BREAKOUT_RISK" : "RESISTANCE_WEAKENING"; rule = label === "RESISTANCE_BREAKOUT_RISK" ? "Spot within 0.5×ATR of strike + call OI shedding — resistance at risk." : "Call OI shedding (> 2% of mean |ΔOI|)."; }
    }
    if (label) strikes.push({ strike: r.strike, callOI: r.callOI, putOI: r.putOI, callDeltaOI: r.callDeltaOI, putDeltaOI: r.putDeltaOI, callVol: r.callVol, putVol: r.putVol, label, rule, caveat, ts: Date.now() });
  }

  return {
    available: true,
    reason: "",
    underlying: "",
    expiry: null,
    spot,
    pcr: sumCall > 0 ? Math.round((sumPut / sumCall) * 1000) / 1000 : null,
    pcrValidStrikes: { call: validCall.length, put: validPut.length, dropped: droppedOiStrikes },
    pcrScope: "PCR = Σ put OI / Σ call OI over strikes within ±8% of spot for the selected expiry (documented scope).",
    strikes: strikes.sort((a, b) => a.strike - b.strike),
    ts: Date.now(),
  };
}

export function unavailableFutures(symbol: string, reason: string): FuturesIntel {
  return { available: false, reason, symbol, price: null, change: null, volume: null, oi: null, deltaOI: null, basis: null, priceOI: null, ts: null };
}

export function unavailableOptions(underlying: string, reason: string): OptionChainIntel {
  return { available: false, reason, underlying, expiry: null, spot: null, pcr: null, pcrValidStrikes: { call: 0, put: 0, dropped: 0 }, pcrScope: "", strikes: [], ts: null };
}
