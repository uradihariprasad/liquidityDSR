/**
 * Historical replay & backtesting — LIVE-DATA-ONLY.
 *
 * Runs the documented breakout rule set over **real exchange candles**
 * fetched from the Upstox v3 historical-candle API. When no access token is
 * connected the module returns an explicit unavailable result — nothing is
 * ever substituted or invented.
 *
 * Strategy under test (documented, no lookahead):
 *  At each completed bar t (after the opening range):
 *    - levels computed ONLY from data strictly before t: previous-day high/low,
 *      opening range (first 15 min), swing highs/lows confirmed k=2.
 *    - LONG entry if close[t] > level + 0.10×ATR AND relVol ≥ 1.3 AND body ≥ 0.5
 *      AND FMPI-lite ≥ fmpiLiteMin. SHORT mirrors on support levels.
 *  Fill model: entry = open[t+1] ± slippage; intrabar resolution is
 *  conservative — if stop and target both lie inside a bar the STOP is hit
 *  first. Costs: configurable round-trip bps. Exit: stop / target / 15:20.
 *
 * Validation: chronological 60/40 in-sample/out-of-sample day split. The
 * engine performs no tuning; changing parameters and re-running on the same
 * days is manual in-sample tuning (disclosed in every report). Historical
 * performance never guarantees future results.
 */

import type { Candle } from "./types";
import { atrSeries, relVolSeries, candleBodyRatio } from "./indicators";
import { swingPoints } from "./structure";
import { getInstrument } from "./universe";
import { fetchHistoricalCandles } from "./upstox";
import { hasToken } from "./credentials";
import { istParts, shiftDate, aggregate } from "./candles";

export interface BacktestParams {
  symbols: string[];
  days: number;
  tfMinutes: number;
  rr: number;
  costBps: number;
  slippageBps: number;
  minRelVol: number;
  fmpiLiteMin: number;
}

export const DEFAULT_BACKTEST: BacktestParams = {
  symbols: ["RELIANCE", "HDFCBANK", "TCS", "INFY", "SBIN", "TATAMOTORS"],
  days: 20,
  tfMinutes: 5,
  rr: 1.5,
  costBps: 6,
  slippageBps: 2,
  minRelVol: 1.3,
  fmpiLiteMin: 55,
};

interface TradeRec {
  symbol: string; date: string; dir: "LONG" | "SHORT";
  entryTs: number; entry: number; stop: number; target: number;
  exitTs: number; exit: number; exitReason: "TARGET" | "STOP" | "EOD";
  rMultiple: number; pnlBps: number; regime: "TREND" | "RANGE"; levelType: string;
}

function fmpiLite(closes: number[], candles: Candle[], i: number, atr: (number | null)[], rel: (number | null)[]): number {
  const a = atr[i];
  if (!a) return 0;
  const roc3 = i >= 3 ? (closes[i] - closes[i - 3]) / a : 0;
  const mom = Math.min(1, Math.abs(roc3) / 2);
  const part = Math.min(1, (rel[i] ?? 1) / 2);
  const last6 = candles.slice(Math.max(0, i - 5), i + 1);
  const sign = Math.sign(closes[i] - closes[Math.max(0, i - 6)]) || 1;
  const pers = last6.filter((c) => Math.sign(c.close - c.open) === sign).length / last6.length;
  return (mom * 0.5 + part * 0.28 + pers * 0.22) * 100;
}

function unavailable(reason: string) {
  return {
    available: false,
    reason,
    params: DEFAULT_BACKTEST,
    trades: [],
    metrics: { overall: { setups: 0 }, inSample: { setups: 0 }, outOfSample: { setups: 0 }, daysTested: 0, inSampleDays: 0 },
    disclaimers: [
      "Backtesting runs only over real historical candles fetched from Upstox — no synthetic data is substituted.",
      "Historical performance never guarantees future results.",
    ],
    dataNote: reason,
  };
}

export async function runBacktest(params: Partial<BacktestParams>): Promise<any> {
  const p = { ...DEFAULT_BACKTEST, ...params };
  if (!hasToken()) {
    return unavailable("Backtesting requires a connected Upstox access token (live historical data only — the platform no longer ships a simulated price source).");
  }

  const today = istParts(Date.now()).dateStr;
  const from = shiftDate(today, -Math.max(7, Math.ceil(p.days * 1.8)));
  const trades: TradeRec[] = [];
  const errors: string[] = [];

  for (const symbol of p.symbols) {
    const inst = getInstrument(symbol);
    if (!inst) { errors.push(`${symbol}: not in discovered universe`); continue; }
    let rawCandles: { ts: number; open: number; high: number; low: number; close: number; volume: number }[];
    try {
      rawCandles = await fetchHistoricalCandles(inst.instrumentKey, "minutes", p.tfMinutes, today, from);
    } catch (err) {
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (rawCandles.length < 100) { errors.push(`${symbol}: insufficient historical candles (${rawCandles.length})`); continue; }

    // group by trading date
    const byDay = new Map<string, Candle[]>();
    for (const c of rawCandles) {
      const d = new Date(c.ts + 5.5 * 3600_000).toISOString().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0, live: false });
    }
    const days = [...byDay.keys()].sort().slice(-p.days);

    for (let di = 1; di < days.length; di++) {
      const dateStr = days[di];
      const candles = byDay.get(dateStr)!;
      const prevDay = byDay.get(days[di - 1])!;
      if (candles.length < 20 || !prevDay?.length) continue;
      const pdh = Math.max(...prevDay.map((c) => c.high));
      const pdl = Math.min(...prevDay.map((c) => c.low));
      const atr = atrSeries(candles, 14);
      const rel = relVolSeries(candles, 20);
      const closes = candles.map((c) => c.close);
      const dayAtr = atr[atr.length - 1] ?? 1;
      const regime: "TREND" | "RANGE" = Math.abs(closes[closes.length - 1] - candles[0].open) > dayAtr * 1.2 ? "TREND" : "RANGE";

      let open: TradeRec | null = null;
      for (let t = 6; t < candles.length - 1; t++) {
        if (open) {
          const c = candles[t];
          const hitStop = open.dir === "LONG" ? c.low <= open.stop : c.high >= open.stop;
          const hitTarget = open.dir === "LONG" ? c.high >= open.target : c.low <= open.target;
          let closed = false;
          if (hitStop) { open.exit = open.stop; open.exitTs = c.ts; open.exitReason = "STOP"; closed = true; }
          else if (hitTarget) { open.exit = open.target; open.exitTs = c.ts; open.exitReason = "TARGET"; closed = true; }
          else if (t >= candles.length - 2) { open.exit = c.close; open.exitTs = c.ts; open.exitReason = "EOD"; closed = true; }
          if (closed) {
            const dirSign = open.dir === "LONG" ? 1 : -1;
            const risk = Math.abs(open.entry - open.stop);
            open.rMultiple = ((open.exit - open.entry) * dirSign) / Math.max(risk, 1e-9);
            open.pnlBps = ((open.exit - open.entry) * dirSign) / open.entry * 10000 - p.costBps;
            trades.push(open);
            open = null;
          }
          continue;
        }
        const atrT = atr[t];
        const relT = rel[t];
        if (!atrT || relT == null) continue;
        const past = candles.slice(0, t);
        const swings = swingPoints(past, 2);
        const orEnd = Math.ceil(15 / p.tfMinutes);
        const orHigh = t > orEnd ? Math.max(...past.slice(0, orEnd).map((c) => c.high)) : null;
        const orLow = t > orEnd ? Math.min(...past.slice(0, orEnd).map((c) => c.low)) : null;
        const lastSwingHigh = [...swings].reverse().find((s) => s.kind === "high");
        const lastSwingLow = [...swings].reverse().find((s) => s.kind === "low");
        const f = fmpiLite(closes, candles, t, atr, rel);
        const body = candleBodyRatio(candles[t]);
        if (body < 0.5 || relT < p.minRelVol || f < p.fmpiLiteMin) continue;

        const closeT = closes[t];
        const buf = 0.1 * atrT;
        let dir: "LONG" | "SHORT" | null = null;
        let levelType = "";
        let lvl = 0;
        const priorHigh = Math.max(...past.map((c) => c.high));
        const priorLow = Math.min(...past.map((c) => c.low));
        const resLevels: { p: number; type: string }[] = [{ p: pdh, type: "PDH" }];
        if (orHigh != null) resLevels.push({ p: orHigh, type: "ORH" });
        if (lastSwingHigh) resLevels.push({ p: lastSwingHigh.price, type: "SWING_HIGH" });
        const supLevels: { p: number; type: string }[] = [{ p: pdl, type: "PDL" }];
        if (orLow != null) supLevels.push({ p: orLow, type: "ORL" });
        if (lastSwingLow) supLevels.push({ p: lastSwingLow.price, type: "SWING_LOW" });

        for (const L of resLevels) {
          if (closeT > L.p + buf && priorHigh <= L.p + buf) { dir = "LONG"; levelType = L.type; lvl = L.p; break; }
        }
        if (!dir) for (const L of supLevels) {
          if (closeT < L.p - buf && priorLow >= L.p - buf) { dir = "SHORT"; levelType = L.type; lvl = L.p; break; }
        }
        if (!dir) continue;

        const entry = candles[t + 1].open * (1 + (dir === "LONG" ? 1 : -1) * p.slippageBps / 10000);
        const structStop = dir === "LONG"
          ? Math.min(lastSwingLow?.price ?? lvl - atrT, lvl - 0.35 * atrT)
          : Math.max(lastSwingHigh?.price ?? lvl + atrT, lvl + 0.35 * atrT);
        const stop = dir === "LONG" ? structStop - 0.1 * atrT : structStop + 0.1 * atrT;
        const riskPts = Math.abs(entry - stop);
        if (riskPts < atrT * 0.2) continue;
        const target = dir === "LONG" ? entry + riskPts * p.rr : entry - riskPts * p.rr;
        open = { symbol, date: dateStr, dir, entryTs: candles[t + 1].ts, entry, stop, target, exitTs: 0, exit: 0, exitReason: "EOD", rMultiple: 0, pnlBps: 0, regime, levelType };
      }
    }
  }

  const uniqDays = [...new Set(trades.map((t) => t.date))].sort();
  const cutoff = Math.floor(uniqDays.length * 0.6);
  const inDays = new Set(uniqDays.slice(0, cutoff));
  const summarize = (ts: TradeRec[]) => {
    const n = ts.length;
    if (!n) return { setups: 0 };
    const wins = ts.filter((t) => t.pnlBps > 0);
    const losses = ts.filter((t) => t.pnlBps <= 0);
    const grossWin = wins.reduce((a, t) => a + t.pnlBps, 0);
    const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlBps, 0));
    const equity: number[] = [];
    let eq = 0;
    for (const t of [...ts].sort((a, b) => a.exitTs - b.exitTs)) { eq += t.pnlBps; equity.push(eq); }
    let peak = 0; let mdd = 0;
    for (const v of equity) { peak = Math.max(peak, v); mdd = Math.min(mdd, v - peak); }
    const lite = (xs: TradeRec[]) => {
      const m = xs.length;
      if (!m) return { setups: 0 };
      const w = xs.filter((t) => t.pnlBps > 0).length;
      return { setups: m, winRate: Math.round((w / m) * 1000) / 10, expectancyBps: Math.round((xs.reduce((a, t) => a + t.pnlBps, 0) / m) * 10) / 10 };
    };
    return {
      setups: n,
      winRate: Math.round((wins.length / n) * 1000) / 10,
      avgWinBps: wins.length ? Math.round((grossWin / wins.length) * 10) / 10 : 0,
      avgLossBps: losses.length ? Math.round((grossLoss / losses.length) * 10) / 10 : 0,
      expectancyBps: Math.round((ts.reduce((a, t) => a + t.pnlBps, 0) / n) * 10) / 10,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
      maxDrawdownBps: Math.round(Math.abs(mdd) * 10) / 10,
      avgR: Math.round((ts.reduce((a, t) => a + t.rMultiple, 0) / n) * 100) / 100,
      stops: ts.filter((t) => t.exitReason === "STOP").length,
      targets: ts.filter((t) => t.exitReason === "TARGET").length,
      eodExits: ts.filter((t) => t.exitReason === "EOD").length,
      falseBreakouts: ts.filter((t) => t.exitReason === "STOP").length,
      byRegime: { trend: lite(ts.filter((t) => t.regime === "TREND")), range: lite(ts.filter((t) => t.regime === "RANGE")) },
    };
  };

  return {
    available: true,
    reason: "",
    params: p,
    trades: trades.slice(-400),
    errors,
    metrics: {
      overall: summarize(trades),
      inSample: summarize(trades.filter((t) => inDays.has(t.date))),
      outOfSample: summarize(trades.filter((t) => !inDays.has(t.date))),
      daysTested: uniqDays.length,
      inSampleDays: inDays.size,
    },
    disclaimers: [
      "Underlying data: real exchange candles fetched live from the Upstox v3 historical-candle API — no synthetic series.",
      "Fills are next-bar-open with conservative stop-first intrabar resolution; costs configured above are applied.",
      "Chronological 60/40 in-sample/out-of-sample split; the engine performs no tuning — re-running with changed parameters on the same days is manual in-sample tuning.",
      "Historical performance never guarantees future results.",
    ],
    dataNote: "Upstox v3 historical minute candles, grouped into trading days; previous-day levels derive strictly from the prior trading day.",
  };
}
