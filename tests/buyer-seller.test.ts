/**
 * MODULE J — Buyer/seller intelligence engine tests.
 * OBI, depth edge cases, flow aggregation, absorption, sweep stages,
 * instrument mapping, verdict logic and no-lookahead.
 */
import { describe, it, expect } from "vitest";
import { buildDepthSnapshot, computeObi, diffDepth, DEFAULT_DEPTH_CONFIG } from "@/lib/market/depth";
import { normalizeTrades, aggregateFlow, stackedImbalance, unsupportedFlow, flowCapability, type TradeEvent } from "@/lib/market/flow";
import { detectAbsorption, DEFAULT_ABSORPTION_CONFIG } from "@/lib/market/absorption";
import { detectStagedSweeps, activeStagedSweep, DEFAULT_STAGED_SWEEP_CONFIG } from "@/lib/market/sweepstages";
import { buildBuyerSellerIntelligence } from "@/lib/market/buyerSeller";
import { capabilityRegistry } from "@/lib/market/capabilities";
import { atrSeries, relVolSeries } from "@/lib/market/indicators";
import type { Candle } from "@/lib/market/types";

const T0 = Date.parse("2026-10-21T09:15:00+05:30");
const bar = (i: number, o: number, h: number, l: number, c: number, v = 1000): Candle =>
  ({ ts: T0 + i * 300_000, open: o, high: h, low: l, close: c, volume: v, live: false });
const vb = (i: number, lo: number, hi: number, v = 1000) => bar(i, (lo + hi) / 2, hi, lo, (lo + hi) / 2, v);
const base = (n = 40, c = 100, a = 0.5) =>
  Array.from({ length: n }, (_, i) => {
    const p = c + Math.sin(i / 3) * a;
    return bar(i, p, p + 0.3, p - 0.3, p + 0.1);
  });

const INPUT = {
  instrumentKey: "NSE_EQ|INE467B01029",
  contractKey: "NSE_EQ|INE467B01029",
  contractLabel: "TCS (cash)",
  exchange: "NSE",
};

// ---------------------------------------------------------------------------
// MODULE B — OBI and depth safety
// ---------------------------------------------------------------------------

describe("OBI calculation", () => {
  it("computes the documented formula", () => {
    const { obi, totalBid, totalAsk } = computeObi(
      [{ price: 100, quantity: 600, orders: 5 }, { price: 99.9, quantity: 400, orders: 3 }],
      [{ price: 100.1, quantity: 300, orders: 2 }, { price: 100.2, quantity: 200, orders: 2 }],
      5,
    );
    expect(totalBid).toBe(1000);
    expect(totalAsk).toBe(500);
    expect(obi).toBeCloseTo((1000 - 500) / 1500, 6);
  });

  it("returns null (never ±1 or NaN) on a zero denominator", () => {
    expect(computeObi([], [], 5).obi).toBeNull();
    expect(computeObi([{ price: 1, quantity: 0, orders: 0 }], [], 5).obi).toBeNull();
    const r = computeObi([], [], 5);
    expect(Number.isFinite(r.obi as any)).toBe(false);
  });

  it("respects the configurable level count", () => {
    const bids = [1, 2, 3, 4, 5].map((q, i) => ({ price: 100 - i, quantity: q, orders: 1 }));
    const asks = [1, 1, 1, 1, 1].map((q, i) => ({ price: 101 + i, quantity: q, orders: 1 }));
    const two = computeObi(bids, asks, 2);
    expect(two.totalBid).toBe(3); // only levels 0,1
    expect(two.used).toBe(2);
    const five = computeObi(bids, asks, 5);
    expect(five.totalBid).toBe(15);
  });
});

describe("depth safety", () => {
  it("discards Upstox's zero-padded placeholder levels", () => {
    const snap = buildDepthSnapshot({
      ...INPUT,
      depth: {
        buy: [{ price: 100, quantity: 500, orders: 3 }, { price: 0, quantity: 0, orders: 0 }],
        sell: [{ price: 0, quantity: 0, orders: 0 }, { price: 100.1, quantity: 500, orders: 3 }],
      },
      eventTs: Date.now(),
    });
    expect(snap.validity).toBe("VALID");
    expect(snap.bids.length).toBe(1);
    expect(snap.asks.length).toBe(1);
    expect(snap.obi).toBeCloseTo(0, 6); // 500 vs 500
  });

  it("rejects a crossed book", () => {
    const snap = buildDepthSnapshot({
      ...INPUT,
      depth: { buy: [{ price: 100.5, quantity: 100, orders: 1 }], sell: [{ price: 100.4, quantity: 100, orders: 1 }] },
      eventTs: Date.now(),
    });
    expect(snap.validity).toBe("INVALID");
    expect(snap.invalidReason).toMatch(/Crossed book/);
    expect(snap.obi).toBeNull();
  });

  it("rejects invalid quantities", () => {
    const snap = buildDepthSnapshot({
      ...INPUT,
      depth: { buy: [{ price: 100, quantity: -5, orders: 1 }], sell: [] },
      eventTs: Date.now(),
    });
    expect(snap.validity).toBe("INVALID");
  });

  it("marks a snapshot STALE when older than the freshness window", () => {
    const snap = buildDepthSnapshot({
      ...INPUT,
      depth: { buy: [{ price: 100, quantity: 10, orders: 1 }], sell: [{ price: 100.1, quantity: 10, orders: 1 }] },
      eventTs: Date.now() - 60_000,
    });
    expect(snap.stale).toBe(true);
    expect(snap.ageMs).toBeGreaterThan(DEFAULT_DEPTH_CONFIG.staleAfterMs);
  });

  it("reports a one-sided book without crashing", () => {
    const snap = buildDepthSnapshot({
      ...INPUT,
      depth: { buy: [{ price: 100, quantity: 700, orders: 2 }], sell: [] },
      eventTs: Date.now(),
    });
    expect(snap.validity).toBe("VALID");
    expect(snap.bestAsk).toBeNull();
    expect(snap.spread).toBeNull();
    expect(snap.obi).toBeCloseTo(1, 6);
  });
});

describe("depth change tracking", () => {
  let tick = 0;
  const mk = (bids: [number, number][], asks: [number, number][], ts?: number) => {
    // distinct timestamps by default so the duplicate guard never fires
    tick += 1;
    return buildDepthSnapshot({
      ...INPUT,
      depth: {
        buy: bids.map(([p, q]) => ({ price: p, quantity: q, orders: 1 })),
        sell: asks.map(([p, q]) => ({ price: p, quantity: q, orders: 1 })),
      },
      eventTs: ts ?? Date.now() + tick,
    }, null);
  };

  it("classifies increased, reduced, appeared and removed displayed quantity", () => {
    const a = mk([[100, 500]], [[100.1, 300]]);
    const b = mk([[100, 800], [99.9, 200]], [[100.2, 300]]);
    const ch = diffDepth(a, b);
    const byPrice = (side: string, price: number) => ch.find((c) => c.side === side && c.price === price);
    expect(byPrice("bid", 100)?.classification).toBe("INCREASED");
    expect(byPrice("bid", 99.9)?.classification).toBe("APPEARED");
    expect(byPrice("ask", 100.1)?.classification).toBe("REMOVED");
    expect(byPrice("ask", 100.2)?.classification).toBe("APPEARED");
  });

  it("never labels a removed order as executed", () => {
    const a = mk([[100, 500]], []);
    const b = mk([], []);
    const ch = diffDepth(a, b);
    expect(ch[0].classification).toBe("REMOVED");
    expect(ch[0].note).toMatch(/NOT proof of execution|not.*executed/i);
  });

  it("a duplicate update (same event timestamp) produces no changes", () => {
    const ts = Date.now() + 9999;
    const a = mk([[100, 500]], [[100.1, 300]], ts);
    const b = mk([[100, 500]], [[100.1, 300]], ts);
    expect(diffDepth(a, b)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MODULE C — flow aggregation (pure functions; feed itself is UNSUPPORTED)
// ---------------------------------------------------------------------------

describe("trade normalization and aggregation", () => {
  const t = (ts: number, price: number, qty: number, agg: "BUY_INITIATED" | "SELL_INITIATED", seq?: number): TradeEvent =>
    ({ ts, price, quantity: qty, aggressor: agg, instrumentKey: "X", sequence: seq });

  it("deduplicates by sequence number when present", () => {
    const { events, droppedDuplicates } = normalizeTrades([
      t(1, 100, 10, "BUY_INITIATED", 1),
      t(1, 100, 10, "BUY_INITIATED", 1),
      t(2, 101, 5, "SELL_INITIATED", 2),
    ]);
    expect(events.length).toBe(2);
    expect(droppedDuplicates).toBe(1);
  });

  it("deduplicates by composite key when no sequence is supplied", () => {
    const { events, droppedDuplicates } = normalizeTrades([
      t(1, 100, 10, "BUY_INITIATED"),
      t(1, 100, 10, "BUY_INITIATED"),
      t(1, 100, 10, "SELL_INITIATED"), // different side, not a duplicate
    ]);
    expect(events.length).toBe(2);
    expect(droppedDuplicates).toBe(1);
  });

  it("drops invalid trades (bad price, non-positive quantity, bad side)", () => {
    const { events } = normalizeTrades([
      t(1, -5, 10, "BUY_INITIATED"),
      t(1, 100, 0, "BUY_INITIATED"),
      t(1, 100, -3, "SELL_INITIATED"),
      { ts: NaN, price: 100, quantity: 5, aggressor: "BUY_INITIATED", instrumentKey: "X" },
      t(1, 100, 7, "BUY_INITIATED"),
    ]);
    expect(events.length).toBe(1);
  });

  it("computes delta and cumulative delta within the session", () => {
    const f = aggregateFlow(
      [t(1, 100, 100, "BUY_INITIATED"), t(2, 101, 40, "SELL_INITIATED"), t(3, 102, 60, "BUY_INITIATED")],
      0, 10,
    );
    expect(f.supported).toBe(true);
    expect(f.aggressiveBuyVolume).toBe(160);
    expect(f.aggressiveSellVolume).toBe(40);
    expect(f.delta).toBe(120);
    expect(f.cumulativeDelta).toBe(120);
    expect(f.tradeCount).toBe(3);
  });

  it("excludes trades outside the session window", () => {
    const f = aggregateFlow([t(1, 100, 100, "BUY_INITIATED"), t(50, 101, 999, "BUY_INITIATED")], 0, 10);
    expect(f.aggressiveBuyVolume).toBe(100);
    expect(f.tradeCount).toBe(1);
  });

  it("aggregates executed volume by price and by candle", () => {
    const f = aggregateFlow([
      t(T0 + 1000, 100, 10, "BUY_INITIATED"),
      t(T0 + 2000, 100, 5, "SELL_INITIATED"),
      t(T0 + 61_000, 101, 7, "BUY_INITIATED"),
    ], T0, T0 + 120_000);
    const p100 = f.volumeByPrice!.find((x) => x.price === 100)!;
    expect(p100.buyVolume).toBe(10);
    expect(p100.sellVolume).toBe(5);
    expect(p100.delta).toBe(5);
    expect(f.volumeByCandle!.length).toBe(2);
  });

  it("computes stacked imbalance between adjacent price levels", () => {
    const levels = [
      { price: 99, buyVolume: 10, sellVolume: 100 },
      { price: 100, buyVolume: 400, sellVolume: 10 },
      { price: 101, buyVolume: 10, sellVolume: 5 },
    ];
    const im = stackedImbalance(levels, 3);
    expect(im.length).toBeGreaterThanOrEqual(1);
    expect(im[0].side).toBe("BUY");
    expect(im[0].ratio).toBeGreaterThanOrEqual(3);
  });
});

describe("flow capability on the current feed", () => {
  it("reports UNSUPPORTED with the documented reason", () => {
    expect(flowCapability().supported).toBe(false);
    expect(unsupportedFlow().supported).toBe(false);
    expect(unsupportedFlow().delta).toBeNull();
    expect(unsupportedFlow().cumulativeDelta).toBeNull();
    expect(unsupportedFlow().volumeByPrice).toBeNull();
    expect(unsupportedFlow().reason).toMatch(/snapshot/i);
  });

  it("the capability registry marks executed flow and aggressor side UNSUPPORTED", () => {
    const r = capabilityRegistry();
    expect(r.executedFlowVerdict.state).toBe("UNSUPPORTED");
    const trade = r.entries.find((e) => e.capability.includes("Trade-level"));
    const aggressor = r.entries.find((e) => e.capability.includes("Aggressor"));
    expect(trade?.state).toBe("UNSUPPORTED");
    expect(aggressor?.state).toBe("UNSUPPORTED");
    expect(r.summary.supported).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MODULE E — absorption
// ---------------------------------------------------------------------------

describe("absorption detector", () => {
  const ZONE = (side: "support" | "resistance", bottom: number, top: number, status = "TESTING") => ({
    id: "z", type: "PDL" as any, liquiditySide: null as any, side,
    top, bottom, mid: (top + bottom) / 2, source: "test", createdTs: T0, updatedTs: T0,
    strength: 50, tests: 3, reactions: 1, status: status as any, statusReason: "", invalidation: "", derived: true,
  });

  it("reports the aggressor-flow evidence as MISSING (not proxied) on this feed", () => {
    const cs = base(40);
    const a = detectAbsorption({ candles: cs, zones: [ZONE("support", 99.5, 100.5)] as any, atr: 1, flow: unsupportedFlow(), price: 100 });
    const flowEv = a.buyer.evidence.find((e) => e.key === "aggressiveFlow")!;
    expect(flowEv.present).toBe(false);
    expect(flowEv.unavailable).toBe(true);
    expect(flowEv.detail).toMatch(/MISSING|not.*suppl/i);
  });

  it("detects buyer absorption at support with enough structural evidence", () => {
    // support zone near 100; price repeatedly dips below and closes back above
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(vb(i, 103, 105));
    for (let i = 20; i < 40; i++) {
      const dip = 99.4;
      cs.push(bar(i, 100.5, 100.8, dip, 100.6, 2500));
    }
    const a = detectAbsorption({ candles: cs, zones: [ZONE("support", 99.8, 100.4)] as any, atr: 1.0, flow: unsupportedFlow(), price: 100.6 });
    const prog = a.buyer.evidence.find((e) => e.key === "limitedProgress")!;
    const fail = a.buyer.evidence.find((e) => e.key === "repeatedFailure")!;
    expect(prog.present).toBe(true);
    expect(fail.present).toBe(true);
    expect(fail.detail).toMatch(/breaked the zone|candle\(s\) breached/);
    expect(a.buyer.presentCount).toBeGreaterThanOrEqual(3);
  });

  it("does not detect absorption when price breaks decisively through the zone", () => {
    const cs: Candle[] = [];
    for (let i = 0; i < 20; i++) cs.push(vb(i, 103, 105));
    for (let i = 20; i < 40; i++) cs.push(bar(i, 100.0, 100.4, 99.0, 99.3, 2500)); // closes below support
    const a = detectAbsorption({ candles: cs, zones: [ZONE("support", 100.0, 100.4, "BROKEN")] as any, atr: 1.0, flow: unsupportedFlow(), price: 99.3 });
    expect(a.buyer.detected).toBe(false);
    expect(a.buyer.note).toMatch(/Insufficient evidence/i);
  });

  it("never claims a hidden or iceberg order", () => {
    const cs = base(40);
    const a = detectAbsorption({ candles: cs, zones: [], atr: 1, flow: unsupportedFlow(), price: 100 });
    for (const c of [a.buyer, a.seller]) {
      expect(c.note).not.toMatch(/iceberg detected|hidden order detected/i);
    }
  });

  it("requires the configured minimum evidence count", () => {
    const cs = base(40);
    const a = detectAbsorption({ candles: cs, zones: [], atr: 1, flow: unsupportedFlow(), price: 100 }, { ...DEFAULT_ABSORPTION_CONFIG, minEvidence: 99 });
    expect(a.buyer.detected).toBe(false);
    expect(a.buyer.requiredCount).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// MODULE F — staged sweeps
// ---------------------------------------------------------------------------

describe("staged sweep detection", () => {
  it("separates TOUCHED from PENETRATED from a confirmed sweep", () => {
    const cs = base(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const n = cs.length;
    // shallow touch: barely exceeds, closes back below
    cs.push(bar(n, priorHigh - 0.02, priorHigh + 0.01, priorHigh - 0.03, priorHigh - 0.02, 2000));
    const atrArr = atrSeries(cs, 14);
    const relArr = relVolSeries(cs, 20);
    const staged = detectStagedSweeps(cs, atrArr, relArr);
    const touch = staged.find((s) => s.ts === cs[n].ts && s.side === "HIGH");
    expect(touch).toBeTruthy();
    expect(["TOUCHED", "PENETRATED"]).toContain(touch!.stage);
    expect(touch!.stageReason).toMatch(/touch|penetration threshold|no reclaim/i);
  });

  it("never reports a mere touch as a confirmed sweep", () => {
    const cs = base(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const n = cs.length;
    cs.push(bar(n, priorHigh - 0.02, priorHigh + 0.005, priorHigh - 0.03, priorHigh - 0.02, 1500));
    const staged = detectStagedSweeps(cs, atrSeries(cs, 14), relVolSeries(cs, 20));
    const t = staged.find((s) => s.ts === cs[n].ts);
    if (t) expect(t.stage).not.toBe("FOLLOW_THROUGH_CONFIRMED");
  });

  it("reports the full stage progression for a genuine sweep", () => {
    const cs = base(40);
    const priorLow = Math.min(...cs.slice(-10).map((c) => c.low));
    const n = cs.length;
    const atrNow = atrSeries(cs, 14).at(-1)!;
    const pen = atrNow * 0.5;
    cs.push(bar(n, priorLow + 0.03, priorLow + 0.06, priorLow - pen, priorLow + 0.04, 4000));
    cs.push(bar(n + 1, priorLow + 0.06, priorLow + pen * 2, priorLow + 0.05, priorLow + pen * 1.8, 4200));
    const staged = detectStagedSweeps(cs, atrSeries(cs, 14), relVolSeries(cs, 20));
    const s = staged.find((x) => x.side === "LOW" && x.level === priorLow);
    expect(s).toBeTruthy();
    expect(s!.stage).toBe("FOLLOW_THROUGH_CONFIRMED");
    expect(activeStagedSweep(staged)?.side).toBe("LOW");
  });

  it("marks an invalidated sweep separately from a confirmed one", () => {
    const cs = base(40);
    const priorHigh = Math.max(...cs.slice(-10).map((c) => c.high));
    const n = cs.length;
    const atrNow = atrSeries(cs, 14).at(-1)!;
    const pen = atrNow * 0.5;
    cs.push(bar(n, priorHigh - 0.03, priorHigh + pen, priorHigh - 0.06, priorHigh - 0.04, 3000));
    // price then ACCEPTS above the swept extreme -> invalidated
    cs.push(bar(n + 1, priorHigh - 0.03, priorHigh + pen * 2, priorHigh - 0.04, priorHigh + pen * 1.8, 5000));
    const staged = detectStagedSweeps(cs, atrSeries(cs, 14), relVolSeries(cs, 20));
    const inv = staged.find((x) => x.side === "HIGH" && x.stage === "INVALIDATED");
    expect(inv).toBeTruthy();
    expect(inv!.stageReason).toMatch(/NOT rejected|invalidated/i);
  });

  it("always reports executed-flow confirmation as not evaluable on this feed", () => {
    const cs = base(40);
    const staged = detectStagedSweeps(cs, atrSeries(cs, 14), relVolSeries(cs, 20));
    for (const s of staged) expect(s.confirmations.executedFlow).toBeNull();
  });

  it("does not use future candles (no look-ahead)", () => {
    const cs = base(40);
    const priorLow = Math.min(...cs.slice(-10).map((c) => c.low));
    const n = cs.length;
    const atrNow = atrSeries(cs, 14).at(-1)!;
    const pen = atrNow * 0.5;
    const sweepBar = bar(n, priorLow + 0.03, priorLow + 0.06, priorLow - pen, priorLow + 0.04, 4000);
    const followBar = bar(n + 1, priorLow + 0.06, priorLow + pen * 2, priorLow + 0.05, priorLow + pen * 1.8, 4200);
    // truncated before the follow-through bar -> not yet confirmed
    const partial = detectStagedSweeps([...cs, sweepBar], atrSeries([...cs, sweepBar], 14), relVolSeries([...cs, sweepBar], 20));
    const p = partial.find((x) => x.side === "LOW");
    expect(["SWEEP_CANDIDATE", "RECLAIM_CONFIRMED"]).toContain(p?.stage);
    expect(p?.stage).not.toBe("FOLLOW_THROUGH_CONFIRMED");
    // with the follow-through bar it advances.
    // Select by the sweep bar's own timestamp: the detector also emits
    // TOUCHED/PENETRATED fallback rows for later bars, so filtering by side
    // alone could match one of those instead of the real event.
    const fullArr = [...cs, sweepBar, followBar];
    const full = detectStagedSweeps(fullArr, atrSeries(fullArr, 14), relVolSeries(fullArr, 20));
    const atSweepBar = full.filter((x) => x.ts === sweepBar.ts && x.side === "LOW");
    expect(atSweepBar.length).toBeGreaterThan(0);
    expect(atSweepBar.some((x) => x.stage === "FOLLOW_THROUGH_CONFIRMED" || x.stage === "RECLAIM_CONFIRMED")).toBe(true);
    // and it must never be a mere TOUCHED once follow-through exists
    expect(atSweepBar.every((x) => x.stage !== "TOUCHED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MODULE G — verdicts and instrument mapping
// ---------------------------------------------------------------------------

describe("unified intelligence verdicts", () => {
  const mkInput = (over: any = {}) => ({
    symbol: "TCS", underlyingLabel: "TCS", underlyingKey: "NSE_EQ|INE467B01029",
    underlyingPrice: 100, analysisContractKey: "NSE_EQ|INE467B01029", analysisContractLabel: "TCS (cash)",
    analysisContractPrice: null, contractExpiry: null, rolloverNote: "none",
    candles: base(40), zones: [], atr: 1,
    depth: null, flow: unsupportedFlow(),
    absorption: detectAbsorption({ candles: base(40), zones: [], atr: 1, flow: unsupportedFlow(), price: 100 }),
    sweeps: [], structureTrend: "RANGE", movementState: "RANGE_BOUND",
    vwap: null, relativeVolume: null, ...over,
  });

  it("returns INSUFFICIENT_DATA when nothing directional is available", () => {
    const r = buildBuyerSellerIntelligence(mkInput());
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    expect(r.verdictReason.length).toBeGreaterThan(10);
    expect(r.disclaimers.length).toBeGreaterThan(3);
  });

  it("returns CONFLICTING_EVIDENCE when bullish and bearish signals both exist", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      structureTrend: "UP", movementState: "BULLISH_CONTINUATION",
      vwap: 90, // price above vwap -> bullish
      depth: buildDepthSnapshot({
        ...INPUT,
        depth: { buy: [{ price: 99, quantity: 100, orders: 1 }], sell: [{ price: 101, quantity: 900, orders: 1 }] },
        eventTs: Date.now(),
      }),
    }));
    expect(r.bullishCount).toBeGreaterThan(0);
    expect(r.bearishCount).toBeGreaterThan(0);
    expect(r.verdict).toBe("CONFLICTING_EVIDENCE");
  });

  it("returns BULLISH_EVIDENCE when multiple independent signals agree", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      structureTrend: "UP", movementState: "BULLISH_CONTINUATION", vwap: 90,
    }));
    expect(r.verdict).toBe("BULLISH_EVIDENCE");
  });

  it("a depth imbalance alone NEVER produces a directional verdict", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      depth: buildDepthSnapshot({
        ...INPUT,
        depth: { buy: [{ price: 99, quantity: 900, orders: 1 }], sell: [{ price: 101, quantity: 100, orders: 1 }] },
        eventTs: Date.now(),
      }),
    }));
    // only the OBI signal is directional -> not enough for a verdict
    expect(r.verdict).not.toBe("BULLISH_EVIDENCE");
    expect(r.verdict).toBe("INSUFFICIENT_DATA");
    const obi = r.signals.find((s) => s.key === "obi")!;
    expect(obi.strength).toBe("WEAK");
    expect(obi.dataClass).toBe("DISPLAYED_DEPTH");
  });

  it("returns LIQUIDITY_SWEEP_CANDIDATE when a sweep is confirmed", () => {
    const cs = base(40);
    const priorLow = Math.min(...cs.slice(-10).map((c) => c.low));
    const n = cs.length;
    const atrNow = atrSeries(cs, 14).at(-1)!;
    const pen = atrNow * 0.5;
    cs.push(bar(n, priorLow + 0.03, priorLow + 0.06, priorLow - pen, priorLow + 0.04, 4000));
    cs.push(bar(n + 1, priorLow + 0.06, priorLow + pen * 2, priorLow + 0.05, priorLow + pen * 1.8, 4200));
    const sweeps = detectStagedSweeps(cs, atrSeries(cs, 14), relVolSeries(cs, 20));
    const r = buildBuyerSellerIntelligence(mkInput({ candles: cs, sweeps, structureTrend: "RANGE", movementState: "RANGE_BOUND" }));
    expect(r.verdict).toBe("LIQUIDITY_SWEEP_CANDIDATE");
    expect(r.activeSweep?.side).toBe("LOW");
  });

  it("keeps data classes distinct — depth never blends into flow", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      depth: buildDepthSnapshot({
        ...INPUT,
        depth: { buy: [{ price: 99, quantity: 900, orders: 1 }], sell: [{ price: 101, quantity: 100, orders: 1 }] },
        eventTs: Date.now(),
      }),
    }));
    const classes = new Set(r.signals.map((s: any) => s.dataClass));
    expect(classes.has("DISPLAYED_DEPTH")).toBe(true);
    const flowSig = r.signals.find((s: any) => s.dataClass === "EXECUTED_FLOW")!;
    expect(flowSig.available).toBe(false);
  });

  it("exposes contract mapping with underlying and analysis contract kept distinct", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      underlyingKey: "NSE_INDEX|Nifty 50",
      underlyingLabel: "Nifty 50",
      analysisContractKey: "NSE_FO|48001",
      analysisContractLabel: "NIFTY FUT 27 OCT 26",
      analysisContractPrice: 22480,
      contractExpiry: "2026-10-27",
    }));
    expect(r.contract.underlyingKey).toBe("NSE_INDEX|Nifty 50");
    expect(r.contract.analysisContractKey).toBe("NSE_FO|48001");
    expect(r.contract.underlyingKey).not.toBe(r.contract.analysisContractKey);
    expect(r.contract.expiry).toBe("2026-10-27");
  });

  it("carries freshness for each channel separately", () => {
    const r = buildBuyerSellerIntelligence(mkInput({
      depth: buildDepthSnapshot({
        ...INPUT,
        depth: { buy: [{ price: 99, quantity: 100, orders: 1 }], sell: [{ price: 101, quantity: 100, orders: 1 }] },
        eventTs: Date.now() - 60_000,
      }),
    }));
    expect(r.freshness.depthTs).toBeGreaterThan(0);
    expect(r.freshness.depthStale).toBe(true);
    expect(r.freshness.candleTs).toBeGreaterThan(0);
    expect(r.freshness.flowSessionTo).toBeNull(); // flow unsupported
  });

  it("reports channel availability honestly", () => {
    const r = buildBuyerSellerIntelligence(mkInput());
    expect(r.channels.executedFlow.available).toBe(false);
    expect(r.channels.executedFlow.state).toBe("UNSUPPORTED");
    expect(r.channels.depth.available).toBe(false);
    expect(r.channels.priceStructure.available).toBe(true);
  });
});
