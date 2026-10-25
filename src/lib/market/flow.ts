/**
 * MODULE C — Executed trade flow / footprint adapter.
 *
 * STATE: UNSUPPORTED on the current Upstox REST feed. See capabilities.ts for
 * the verified evidence: the quote payload exposes `last_trade_time` only —
 * a timestamp, not a trade record — with no executed quantity and no
 * aggressor side.
 *
 * This module therefore provides:
 *  1. An honest UNSUPPORTED result for the current feed.
 *  2. A typed adapter interface so a properly licensed trade-level feed can be
 *     plugged in later WITHOUT changing any calling code.
 *  3. Pure aggregation functions (delta, cumulative delta, price-level and
 *     per-candle aggregation, stacked/diagonal imbalance) that are fully
 *     implemented and unit-tested, but which only ever run when a real
 *     trade-level source is registered.
 *
 * NOTHING here infers aggressor side from candle colour, candle direction or
 * tick direction. There is no "experimental approximation" path enabled by
 * default, because the spec forbids presenting an approximation as real flow.
 */

import type { Capability } from "./capabilities";

export type AggressorSide = "BUY_INITIATED" | "SELL_INITIATED";

export interface TradeEvent {
  /** epoch ms of the execution */
  ts: number;
  price: number;
  quantity: number;
  aggressor: AggressorSide;
  instrumentKey: string;
  /** optional provider sequence number for dedup + ordering */
  sequence?: number;
}

export interface FlowAggregate {
  supported: boolean;
  reason: string;
  /** null whenever unsupported — never a fabricated number */
  aggressiveBuyVolume: number | null;
  aggressiveSellVolume: number | null;
  /** Delta = aggressive buy volume − aggressive sell volume */
  delta: number | null;
  /** running sum of valid deltas within the configured session */
  cumulativeDelta: number | null;
  tradeCount: number | null;
  /** executed volume bucketed by price */
  volumeByPrice: { price: number; buyVolume: number; sellVolume: number; delta: number }[] | null;
  /** executed volume bucketed by candle open timestamp */
  volumeByCandle: { candleTs: number; buyVolume: number; sellVolume: number; delta: number }[] | null;
  sessionFromTs: number | null;
  sessionToTs: number | null;
  dataQuality: Capability | "OK";
  droppedDuplicates: number;
  droppedOutOfSequence: number;
}

export const EMPTY_FLOW: FlowAggregate = {
  supported: false,
  reason: "",
  aggressiveBuyVolume: null,
  aggressiveSellVolume: null,
  delta: null,
  cumulativeDelta: null,
  tradeCount: null,
  volumeByPrice: null,
  volumeByCandle: null,
  sessionFromTs: null,
  sessionToTs: null,
  dataQuality: "UNSUPPORTED",
  droppedDuplicates: 0,
  droppedOutOfSequence: 0,
};

/**
 * Why executed flow is unavailable on the current feed. Exposed verbatim to
 * the UI so the limitation is visible rather than silently substituted.
 */
export const UNSUPPORTED_REASON =
  "The Upstox REST quote API is a snapshot feed. It reports last_trade_time (a timestamp) but no per-trade executed " +
  "quantity and no aggressor-side field, so aggressive buy/sell volume, net delta, cumulative delta and a true " +
  "bid/ask footprint cannot be computed. These metrics are left UNSUPPORTED rather than approximated from candle " +
  "colour or tick direction.";

export function unsupportedFlow(): FlowAggregate {
  return { ...EMPTY_FLOW, reason: UNSUPPORTED_REASON };
}

// ---------------------------------------------------------------------------
// Adapter interface — a real trade-level feed plugs in here
// ---------------------------------------------------------------------------

export interface TradeFeedAdapter {
  readonly name: string;
  /** true only when the feed genuinely supplies aggressor-side per trade */
  readonly suppliesAggressorSide: boolean;
  /** fetch trades for an instrument within a window */
  fetchTrades(instrumentKey: string, fromTs: number, toTs: number): Promise<TradeEvent[]>;
}

const registeredAdapters: TradeFeedAdapter[] = [];

/**
 * Register a trade-level feed. The adapter MUST set suppliesAggressorSide
 * only if its events carry a genuine aggressor classification; otherwise
 * executed flow stays unsupported.
 */
export function registerTradeFeed(adapter: TradeFeedAdapter): void {
  registeredAdapters.push(adapter);
}

function activeAdapter(): TradeFeedAdapter | null {
  return registeredAdapters.find((a) => a.suppliesAggressorSide) ?? null;
}

export function flowCapability(): { supported: boolean; adapterName: string | null; reason: string } {
  const a = activeAdapter();
  if (a) return { supported: true, adapterName: a.name, reason: "" };
  return { supported: false, adapterName: null, reason: UNSUPPORTED_REASON };
}

// ---------------------------------------------------------------------------
// Pure aggregation (implemented + tested, runs only with a real feed)
// ---------------------------------------------------------------------------

/**
 * Deduplicate and order trade events.
 * Dedup key: (instrumentKey, ts, price, quantity, aggressor) — or the provider
 * sequence number when present, which is authoritative.
 */
export function normalizeTrades(trades: TradeEvent[]): { events: TradeEvent[]; droppedDuplicates: number; droppedOutOfSequence: number } {
  const bySeq = new Map<number, TradeEvent>();
  const byComposite = new Set<string>();
  const out: TradeEvent[] = [];
  let dupes = 0;

  for (const t of trades) {
    if (!Number.isFinite(t.ts) || !Number.isFinite(t.price) || t.price <= 0 || !Number.isFinite(t.quantity) || t.quantity <= 0) continue;
    if (t.aggressor !== "BUY_INITIATED" && t.aggressor !== "SELL_INITIATED") continue;

    if (t.sequence != null && Number.isFinite(t.sequence)) {
      if (bySeq.has(t.sequence)) { dupes++; continue; }
      bySeq.set(t.sequence, t);
      out.push(t);
      continue;
    }
    const key = `${t.instrumentKey}|${t.ts}|${t.price}|${t.quantity}|${t.aggressor}`;
    if (byComposite.has(key)) { dupes++; continue; }
    byComposite.add(key);
    out.push(t);
  }

  out.sort((a, b) => a.ts - b.ts);
  return { events: out, droppedDuplicates: dupes, droppedOutOfSequence: 0 };
}

/** Aggregate normalized trades into the FlowAggregate shape. */
export function aggregateFlow(trades: TradeEvent[], sessionFromTs: number, sessionToTs: number): FlowAggregate {
  const { events, droppedDuplicates, droppedOutOfSequence } = normalizeTrades(trades);
  if (!events.length) {
    return { ...EMPTY_FLOW, supported: true, reason: "No valid trade events in the requested window.", dataQuality: "OK", droppedDuplicates, droppedOutOfSequence };
  }

  let buy = 0;
  let sell = 0;
  const byPrice = new Map<number, { buyVolume: number; sellVolume: number }>();
  const byCandle = new Map<number, { buyVolume: number; sellVolume: number }>();

  for (const t of events) {
    if (t.ts < sessionFromTs || t.ts > sessionToTs) continue;
    const isBuy = t.aggressor === "BUY_INITIATED";
    if (isBuy) buy += t.quantity; else sell += t.quantity;

    const p = byPrice.get(t.price) ?? { buyVolume: 0, sellVolume: 0 };
    if (isBuy) p.buyVolume += t.quantity; else p.sellVolume += t.quantity;
    byPrice.set(t.price, p);

    // bucket to the containing minute (candle open ts)
    const candleTs = Math.floor(t.ts / 60_000) * 60_000;
    const c = byCandle.get(candleTs) ?? { buyVolume: 0, sellVolume: 0 };
    if (isBuy) c.buyVolume += t.quantity; else c.sellVolume += t.quantity;
    byCandle.set(candleTs, c);
  }

  const delta = buy - sell;
  // cumulative delta: running sum within the session, computed in time order
  let cum = 0;
  const ordered = events.filter((t) => t.ts >= sessionFromTs && t.ts <= sessionToTs);
  for (const t of ordered) cum += t.aggressor === "BUY_INITIATED" ? t.quantity : -t.quantity;

  return {
    supported: true,
    reason: "",
    aggressiveBuyVolume: buy,
    aggressiveSellVolume: sell,
    delta,
    cumulativeDelta: cum,
    tradeCount: ordered.length,
    volumeByPrice: [...byPrice.entries()]
      .map(([price, v]) => ({ price, buyVolume: v.buyVolume, sellVolume: v.sellVolume, delta: v.buyVolume - v.sellVolume }))
      .sort((a, b) => a.price - b.price),
    volumeByCandle: [...byCandle.entries()]
      .map(([candleTs, v]) => ({ candleTs, buyVolume: v.buyVolume, sellVolume: v.sellVolume, delta: v.buyVolume - v.sellVolume }))
      .sort((a, b) => a.candleTs - b.candleTs),
    sessionFromTs,
    sessionToTs,
    dataQuality: "OK",
    droppedDuplicates,
    droppedOutOfSequence,
  };
}

/**
 * Stacked imbalance between two adjacent price levels (footprint concept).
 * Requires per-price buy/sell volumes, so it is only callable with real flow.
 */
export function stackedImbalance(
  levels: { price: number; buyVolume: number; sellVolume: number }[],
  threshold = 3,
): { price: number; side: "BUY" | "SELL"; ratio: number }[] {
  const out: { price: number; side: "BUY" | "SELL"; ratio: number }[] = [];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    const b = levels[i];
    if (a.sellVolume > 0 && b.buyVolume / a.sellVolume >= threshold) out.push({ price: b.price, side: "BUY", ratio: b.buyVolume / a.sellVolume });
    if (a.buyVolume > 0 && b.sellVolume / a.buyVolume >= threshold) out.push({ price: b.price, side: "SELL", ratio: b.sellVolume / a.buyVolume });
  }
  return out;
}
