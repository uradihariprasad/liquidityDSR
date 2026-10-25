/**
 * MODULE A — Market-data capability registry.
 *
 * Every state below is derived from either (a) a response we have actually
 * parsed in this codebase against the documented schema, or (b) the official
 * Upstox API documentation. Nothing is assumed.
 *
 * VERIFIED EVIDENCE
 *  - `/v2/market-quote/quotes` returns, per instrument: ohlc, depth (top 5
 *    bid + top 5 ask levels, each {price, quantity, orders} and ZERO-PADDED),
 *    last_price, volume, average_price, oi, previous_oi, total_buy_quantity,
 *    total_sell_quantity, timestamp, last_trade_time, circuit limits.
 *  - `/v3/historical-candle/intraday/...` and `/v3/historical-candle/...`
 *    return [ts, o, h, l, c, volume, oi] arrays.
 *  - `/v2/option/contract` and `/v2/option/chain` return strike/OI/Greeks.
 *
 * CRITICAL NEGATIVE FINDINGS (these gate Modules C and E)
 *  - The REST quote API is a SNAPSHOT. It exposes `last_trade_time` (a
 *    timestamp of the most recent trade) but NOT a trade record, NOT an
 *    executed quantity, and NOT an aggressor side.
 *  - There is no documented field for trade sequence numbers.
 *  - Therefore: true executed volume delta, cumulative delta and a true
 *    bid/ask footprint CANNOT be computed from this feed. They are marked
 *    UNSUPPORTED and are never approximated silently.
 */

export type Capability = "SUPPORTED" | "UNSUPPORTED" | "NOT_VERIFIED";

export interface CapabilityEntry {
  capability: string;
  state: Capability;
  source: string;
  /** what must be true for a NOT_VERIFIED entry to become SUPPORTED */
  verificationRequirement?: string;
  notes: string;
}

export interface CapabilityRegistry {
  auditedAt: number;
  entries: CapabilityEntry[];
  /** summary counts for the UI */
  summary: { supported: number; unsupported: number; notVerified: number };
  /** overall verdict for the executed-flow module */
  executedFlowVerdict: {
    state: Capability;
    reason: string;
    /** what a compatible feed must supply to enable it */
    requiredFields: string[];
  };
}

export function capabilityRegistry(): CapabilityRegistry {
  const entries: CapabilityEntry[] = [
    {
      capability: "Market quotes (LTP, OHLC, volume, OI)",
      state: "SUPPORTED",
      source: "GET /v2/market-quote/quotes",
      notes: "Batch up to 500 instrument keys. Authenticated. Returns a snapshot with timestamp.",
    },
    {
      capability: "Displayed market depth (top 5 bid / top 5 ask)",
      state: "SUPPORTED",
      source: "GET /v2/market-quote/quotes (data.<key>.depth)",
      notes: "Levels are {price, quantity, orders} and are ZERO-PADDED with {0,0,0} rows that must be discarded. Snapshot only — not a full order-book diff stream.",
    },
    {
      capability: "Intraday candles (1..300 minute intervals)",
      state: "SUPPORTED",
      source: "GET /v3/historical-candle/intraday/{key}/{unit}/{interval}",
      notes: "Current session only. Verified to respond without authentication for candle endpoints.",
    },
    {
      capability: "Historical candles (prior sessions)",
      state: "SUPPORTED",
      source: "GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}",
      notes: "EXCLUDES the current session, so it must be merged with the intraday endpoint. Minutes data from Jan 2022.",
    },
    {
      capability: "Futures quotes, volume and OI",
      state: "SUPPORTED",
      source: "GET /v2/market-quote/quotes (futures instrument key)",
      notes: "Requires the mapped futures contract key. previous_oi supplied on the payload; else derived from the same contract's daily candles.",
    },
    {
      capability: "Option chain (strikes, OI, Greeks)",
      state: "SUPPORTED",
      source: "GET /v2/option/chain + /v2/option/contract",
      notes: "Requires auth and app entitlement. 403 on unentitled apps — handled as a per-endpoint issue, not a token failure.",
    },
    {
      capability: "Trade-level executed events",
      state: "UNSUPPORTED",
      source: "REST quote API",
      notes: "The payload exposes last_trade_time only — a timestamp, not a trade record. There is no executed quantity and no aggressor side per trade.",
    },
    {
      capability: "Aggressor-side classification (buy-initiated vs sell-initiated)",
      state: "UNSUPPORTED",
      source: "REST quote API",
      notes: "No field identifies which side lifted the offer or hit the bid. Inferring it from candle colour or tick direction would be fabrication.",
    },
    {
      capability: "WebSocket streaming market data (v3 protobuf feed)",
      state: "NOT_VERIFIED",
      source: "WSS market-data-feed (v3)",
      verificationRequirement: "A valid Upstox token plus a working protobuf decoder; the v2 feed endpoint is marked Discontinued in the docs.",
      notes: "Documented as protobuf-over-WebSocket. Not implemented or verified in this build; the app uses controlled polling instead and never claims tick-level streaming.",
    },
    {
      capability: "Full order-book depth (beyond top 5 levels)",
      state: "UNSUPPORTED",
      source: "REST quote API",
      notes: "Only 5 levels per side are returned. Liquidity at other prices is never extrapolated.",
    },
    {
      capability: "Order cancellation / modification events",
      state: "UNSUPPORTED",
      source: "REST quote API",
      notes: "A disappeared displayed quantity may have been cancelled, modified or moved — it is never reported as executed.",
    },
  ];

  const supported = entries.filter((e) => e.state === "SUPPORTED").length;
  const unsupported = entries.filter((e) => e.state === "UNSUPPORTED").length;
  const notVerified = entries.filter((e) => e.state === "NOT_VERIFIED").length;

  return {
    auditedAt: Date.now(),
    entries,
    summary: { supported, unsupported, notVerified },
    executedFlowVerdict: {
      state: "UNSUPPORTED",
      reason:
        "The available REST quote feed is a snapshot API. It does not expose per-trade executed quantities or an aggressor-side field, " +
        "so aggressive buy/sell volume, net delta, cumulative delta and a true bid/ask footprint cannot be computed without fabricating data.",
      requiredFields: [
        "trade timestamp (per execution)",
        "executed price",
        "executed quantity",
        "aggressor side (buy-initiated | sell-initiated)",
        "instrument/contract identifier",
        "sequence number (for deduplication and ordering)",
      ],
    },
  };
}
