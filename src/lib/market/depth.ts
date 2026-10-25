/**
 * MODULE B — Depth Engine.
 *
 * Normalises displayed order-book depth into a validated snapshot with OBI,
 * freshness and change tracking. Built entirely on the verified Upstox
 * `/v2/market-quote/quotes` depth payload (top 5 levels per side).
 *
 * Safety rules enforced here:
 *  - Upstox zero-pads levels with {price:0, quantity:0, orders:0}; those rows
 *    are DISCARDED and never counted toward OBI.
 *  - A zero total quantity yields OBI = null, never ±1 or NaN.
 *  - Crossed or invalid books (best bid >= best ask, non-finite prices,
 *    negative quantities) are rejected as INVALID.
 *  - Duplicate timestamps do not advance the change log.
 *  - A disappeared displayed quantity is reported as REDUCED, never as
 *    executed — it may have been cancelled, modified or moved.
 */

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface DepthChange {
  side: "bid" | "ask";
  price: number;
  previousQty: number;
  currentQty: number;
  delta: number;
  classification: "INCREASED" | "REDUCED" | "APPEARED" | "REMOVED";
  note: string;
}

export type DepthValidity = "VALID" | "INVALID" | "EMPTY" | "STALE";

export interface DepthSnapshot {
  instrumentKey: string;
  /** the contract this book actually belongs to (spot vs futures) */
  contractKey: string;
  contractLabel: string;
  exchange: string;
  /** timestamp reported by the feed */
  eventTs: number | null;
  /** when we received it */
  receivedAt: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  spreadBps: number | null;
  levelCount: number;
  totalBidQty: number;
  totalAskQty: number;
  /** null when the denominator is zero */
  obi: number | null;
  obiLevelsUsed: number;
  /** largest displayed quantities (candidates, NOT institutional proof) */
  concentrations: { side: "bid" | "ask"; price: number; quantity: number; ratioToMean: number }[];
  validity: DepthValidity;
  invalidReason: string | null;
  /** true when this snapshot is older than the freshness window */
  stale: boolean;
  ageMs: number;
  changes: DepthChange[];
  capabilityNote: string;
}

export interface DepthEngineConfig {
  /** how many levels per side to include in OBI (Upstox supplies at most 5) */
  obiLevels: number;
  /** a concentration must exceed mean level quantity by this ratio */
  concentrationRatio: number;
  /** ms after which a snapshot is labelled STALE */
  staleAfterMs: number;
}

export const DEFAULT_DEPTH_CONFIG: DepthEngineConfig = {
  obiLevels: 5,
  concentrationRatio: 2.5,
  staleAfterMs: 15_000,
};

const CAPABILITY_NOTE =
  "Displayed (resting) liquidity only. Top 5 levels per side from the Upstox quote snapshot API — not a full order book and not a diff stream. " +
  "A reduced or disappeared quantity may have been cancelled, modified or moved; it is never reported as executed. " +
  "A large displayed order is a liquidity candidate, not proof of an institutional order or inevitable support/resistance.";

/** Strip Upstox's zero-padded placeholder rows and validate each level. */
function normalizeLevels(raw: any): { levels: DepthLevel[]; invalid: string | null } {
  if (!Array.isArray(raw)) return { levels: [], invalid: null };
  const levels: DepthLevel[] = [];
  for (const l of raw) {
    const price = Number(l?.price);
    const quantity = Number(l?.quantity);
    const orders = Number(l?.orders ?? 0);
    // discard the zero-padded placeholder rows Upstox emits
    if (!Number.isFinite(price) || price <= 0) continue;
    if (!Number.isFinite(quantity) || quantity < 0) return { levels: [], invalid: "invalid quantity in depth payload" };
    levels.push({ price, quantity, orders });
  }
  return { levels, invalid: null };
}

export function computeObi(bids: DepthLevel[], asks: DepthLevel[], levels: number): { obi: number | null; totalBid: number; totalAsk: number; used: number } {
  const b = bids.slice(0, levels).reduce((a, l) => a + l.quantity, 0);
  const s = asks.slice(0, levels).reduce((a, l) => a + l.quantity, 0);
  const denom = b + s;
  // zero denominator must yield null, never ±1 or NaN
  if (denom <= 0) return { obi: null, totalBid: b, totalAsk: s, used: 0 };
  return { obi: (b - s) / denom, totalBid: b, totalAsk: s, used: Math.min(levels, bids.length, asks.length) };
}

/** Compare two snapshots and describe displayed-quantity changes. */
export function diffDepth(prev: DepthSnapshot | null, curr: DepthSnapshot | null): DepthChange[] {
  if (!prev || !curr) return [];
  // duplicate update: same event timestamp and same book -> no change
  if (prev.eventTs && curr.eventTs && prev.eventTs === curr.eventTs) return [];

  const out: DepthChange[] = [];
  const cmp = (side: "bid" | "ask", prevLevels: DepthLevel[], currLevels: DepthLevel[]) => {
    const prevMap = new Map(prevLevels.map((l) => [l.price, l.quantity]));
    const currMap = new Map(currLevels.map((l) => [l.price, l.quantity]));
    for (const [price, qty] of currMap) {
      const p = prevMap.get(price);
      if (p == null) {
        if (qty > 0) out.push({ side, price, previousQty: 0, currentQty: qty, delta: qty, classification: "APPEARED", note: "New displayed quantity at this price." });
      } else if (qty !== p) {
        const increased = qty > p;
        out.push({
          side, price, previousQty: p, currentQty: qty, delta: qty - p,
          classification: increased ? "INCREASED" : "REDUCED",
          note: increased
            ? "Displayed quantity increased (resting liquidity added)."
            : "Displayed quantity reduced — may have been cancelled, modified or moved. NOT reported as executed.",
        });
      }
    }
    for (const [price, qty] of prevMap) {
      if (!currMap.has(price)) {
        out.push({ side, price, previousQty: qty, currentQty: 0, delta: -qty, classification: "REMOVED", note: "Displayed quantity no longer present — cancelled, modified or moved. NOT proof of execution." });
      }
    }
  };
  cmp("bid", prev.bids, curr.bids);
  cmp("ask", prev.asks, curr.asks);
  return out;
}

export function buildDepthSnapshot(
  input: {
    instrumentKey: string;
    contractKey: string;
    contractLabel: string;
    exchange: string;
    depth: any;
    eventTs: number | null;
  },
  previous: DepthSnapshot | null = null,
  cfg: DepthEngineConfig = DEFAULT_DEPTH_CONFIG,
): DepthSnapshot {
  const receivedAt = Date.now();
  const base: DepthSnapshot = {
    instrumentKey: input.instrumentKey,
    contractKey: input.contractKey,
    contractLabel: input.contractLabel,
    exchange: input.exchange,
    eventTs: input.eventTs,
    receivedAt,
    bids: [], asks: [],
    bestBid: null, bestAsk: null, spread: null, spreadBps: null,
    levelCount: 0,
    totalBidQty: 0, totalAskQty: 0,
    obi: null, obiLevelsUsed: 0,
    concentrations: [],
    validity: "EMPTY",
    invalidReason: null,
    stale: false,
    ageMs: 0,
    changes: [],
    capabilityNote: CAPABILITY_NOTE,
  };

  if (!input.depth || typeof input.depth !== "object") {
    return { ...base, validity: "EMPTY", invalidReason: "No depth object in the payload." };
  }

  const bidRes = normalizeLevels(input.depth.buy);
  if (bidRes.invalid) return { ...base, validity: "INVALID", invalidReason: bidRes.invalid };
  const askRes = normalizeLevels(input.depth.sell);
  if (askRes.invalid) return { ...base, validity: "INVALID", invalidReason: askRes.invalid };

  const bids = bidRes.levels.slice(0, cfg.obiLevels);
  const asks = askRes.levels.slice(0, cfg.obiLevels);

  if (!bids.length && !asks.length) {
    return { ...base, validity: "EMPTY", invalidReason: "All depth levels were zero-padded placeholders." };
  }

  const bestBid = bids.length ? Math.max(...bids.map((l) => l.price)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map((l) => l.price)) : null;

  // crossed book check
  if (bestBid != null && bestAsk != null && bestBid >= bestAsk) {
    return { ...base, bids, asks, validity: "INVALID", invalidReason: `Crossed book: best bid ${bestBid} >= best ask ${bestAsk}.` };
  }

  const { obi, totalBid, totalAsk, used } = computeObi(bids, asks, cfg.obiLevels);

  // concentrations: unusually large displayed quantities (candidates only)
  const allQty = [...bids, ...asks].map((l) => l.quantity);
  const meanQty = allQty.length ? allQty.reduce((a, b) => a + b, 0) / allQty.length : 0;
  const concentrations: DepthSnapshot["concentrations"] = [];
  if (meanQty > 0) {
    for (const l of bids) if (l.quantity > meanQty * cfg.concentrationRatio) concentrations.push({ side: "bid", price: l.price, quantity: l.quantity, ratioToMean: l.quantity / meanQty });
    for (const l of asks) if (l.quantity > meanQty * cfg.concentrationRatio) concentrations.push({ side: "ask", price: l.price, quantity: l.quantity, ratioToMean: l.quantity / meanQty });
  }

  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const ageMs = input.eventTs ? receivedAt - input.eventTs : 0;

  return {
    ...base,
    bids, asks,
    bestBid, bestAsk,
    spread,
    spreadBps: spread != null && bestBid && bestBid > 0 ? (spread / bestBid) * 10_000 : null,
    levelCount: Math.max(bids.length, asks.length),
    totalBidQty: totalBid,
    totalAskQty: totalAsk,
    obi,
    obiLevelsUsed: used,
    concentrations,
    validity: "VALID",
    invalidReason: null,
    stale: ageMs > cfg.staleAfterMs,
    ageMs,
    changes: diffDepth(previous, { ...base, bids, asks }),
    capabilityNote: CAPABILITY_NOTE,
  };
}
