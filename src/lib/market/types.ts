/**
 * Core shared types for the market intelligence engine.
 * Everything here is plain data so it can cross the API boundary as JSON.
 */

export type EngineMode = "LIVE_UPSTOX" | "DISCONNECTED";

export type DataQualityStatus = "OK" | "DEGRADED" | "STALE" | "UNAVAILABLE";

export interface DataQuality {
  mode: EngineMode;
  status: DataQualityStatus;
  lastTickTs: number | null;
  lastCandleTs: number | null;
  marketSession: "PRE_OPEN" | "OPEN" | "CLOSED" | "REPLAY";
  warnings: string[];
}

export interface Candle {
  /** epoch ms of candle open */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** true while the candle is still forming */
  live: boolean;
}

export interface Instrument {
  /** canonical trading symbol, e.g. "TCS" */
  symbol: string;
  /** full display name from the instrument master */
  name: string;
  kind: "index" | "stock";
  /** EXACT instrument key from the master — never constructed from a symbol */
  instrumentKey: string;
  /** nearest non-expired futures contract key, when one exists */
  futuresKey?: string;
  futuresSymbol?: string;
  futuresExpiry?: number;
  futuresLotSize?: number;
  /** true only when a live futures contract exists for this underlying */
  foEligible: boolean;
  exchange: string;
  segment: string;
  isin?: string;
  exchangeToken?: string;
  sector: string;
  basePrice: number;
  lotSize: number;
  /** rupees per tick (master value is in paise and is divided by 100) */
  tickSize: number;
}

export interface SwingPoint {
  idx: number;
  /** timestamp of the PIVOT candle */
  ts: number;
  /**
   * Timestamp of the candle at index idx+k — the earliest moment the swing
   * was actually KNOWABLE. A swing needs k candles on each side, so using
   * `ts` as the availability time would let the k confirmation candles be
   * counted as zone tests (look-ahead).
   */
  confirmedTs: number;
  price: number;
  kind: "high" | "low";
  confirmed: boolean;
}

export type ZoneType =
  | "SWING_HIGH"
  | "SWING_LOW"
  | "EQUAL_HIGHS"
  | "EQUAL_LOWS"
  | "PDH"
  | "PDL"
  | "PWH"
  | "PWL"
  | "ORH"
  | "ORL"
  | "CONSOLIDATION"
  | "POC"
  | "VAH"
  | "VAL"
  | "HVN"
  | "LVN"
  | "SESSION_HIGH"
  | "SESSION_LOW"
  | "VWAP"
  | "VWAP_UPPER"
  | "VWAP_LOWER";

export type ZoneStatus =
  | "NEW"
  | "APPROACHING"
  | "TESTING"
  | "HOLDING"
  | "REJECTED"
  | "BROKEN"
  | "RECLAIMED"
  | "POTENTIALLY_SWEPT"
  | "INVALIDATED";

export interface Zone {
  id: string;
  type: ZoneType;
  /** BUY_SIDE = liquidity resting above highs; SELL_SIDE = liquidity below lows */
  liquiditySide: "BUY_SIDE" | "SELL_SIDE" | null;
  side: "support" | "resistance";
  top: number;
  bottom: number;
  mid: number;
  source: string;
  createdTs: number;
  updatedTs: number;
  strength: number; // 0..100 documented score
  tests: number;
  reactions: number;
  status: ZoneStatus;
  statusReason: string;
  invalidation: string;
  /** whether this level is derived from historical price structure (not live depth) */
  derived: boolean;
}

export interface VolumeProfileBin {
  price: number;
  volume: number;
}

export interface VolumeProfileResult {
  method: string;
  approximation: boolean;
  bins: VolumeProfileBin[];
  poc: number;
  vah: number;
  val: number;
  hvns: number[];
  lvns: number[];
  valueAreaPct: number;
  position:
    | "INSIDE_VALUE"
    | "TESTING_VAH"
    | "TESTING_VAL"
    | "ACCEPTING_ABOVE"
    | "ACCEPTING_BELOW"
    | "ROTATING_AROUND_POC";
  positionDetail: string;
  totalVolume: number;
  /** ---- period & provenance (audit fix) ---- */
  /** MULTI_SESSION or SINGLE_SESSION — never implied, always stated */
  period: "MULTI_SESSION" | "SINGLE_SESSION" | string;
  /** IST trading dates actually included in the calculation */
  sessions: string[];
  sessionCount: number;
  fromTs: number;
  toTs: number;
  /** the profile's own valid price range (POC must lie inside it) */
  priceLow: number;
  priceHigh: number;
  binSize: number;
  binCount: number;
  /** completed candles used (forming candle excluded) */
  candlesUsed: number;
  /** timeframe the profile was aggregated on, e.g. "5m" */
  timeframe: string;
  /** instrument tick size used for level snapping, in rupees */
  tickSize: number | null;
  calculatedAt: number;
  /** consistency guard results, so the UI can prove the checks ran */
  consistency: { valLeVah: boolean; pocInRange: boolean; binsValid: boolean };
}

export type MovementState =
  | "BULLISH_CONTINUATION"
  | "BEARISH_CONTINUATION"
  | "BULLISH_MOMENTUM_STRENGTHENING"
  | "BEARISH_MOMENTUM_STRENGTHENING"
  | "BULLISH_MOMENTUM_WEAKENING"
  | "BEARISH_MOMENTUM_WEAKENING"
  | "RANGE_BOUND"
  | "CONSOLIDATION"
  | "VOLATILITY_CONTRACTION"
  | "VOLATILITY_EXPANSION"
  | "BREAKOUT_DEVELOPING"
  | "CONFIRMED_UPSIDE_BREAKOUT"
  | "CONFIRMED_DOWNSIDE_BREAKDOWN"
  | "FAILED_BREAKOUT"
  | "FAILED_BREAKDOWN"
  | "POTENTIAL_LIQUIDITY_SWEEP"
  | "POTENTIAL_BULLISH_REVERSAL"
  | "POTENTIAL_BEARISH_REVERSAL"
  | "CONFIRMED_STRUCTURAL_SHIFT"
  | "CONFLICTING_SIGNALS"
  | "INSUFFICIENT_DATA"
  | "NO_TRADE";

export interface StructureInfo {
  swings: SwingPoint[];
  trend: "UP" | "DOWN" | "RANGE";
  lastBOS: { direction: "up" | "down"; idx: number; ts: number; level: number } | null;
  lastCHOCH: { direction: "up" | "down"; idx: number; ts: number; level: number } | null;
  hhCount: number;
  hlCount: number;
  lhCount: number;
  llCount: number;
}

export interface MovementAssessment {
  state: MovementState;
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  momentum: "STRENGTHENING" | "WEAKENING" | "STABLE" | "CONFLICTING";
  quality: "HIGH" | "MEDIUM" | "LOW";
  supporting: string[];
  contradicting: string[];
  confirmNext: string[];
  invalidateBias: string[];
  tradeJustified: boolean;
  waitReason: string | null;
}

export interface FMPIComponent {
  key: string;
  label: string;
  weight: number;
  available: boolean;
  value: number | null; // 0..1
  signed: number; // -1..1 direction vote
  contribution: number | null;
  detail: string;
}

export interface FMPIResult {
  score: number; // 0..100 — never a win probability
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  state: "STRENGTHENING" | "WEAKENING" | "STABLE" | "CONFLICTING";
  classification:
    | "VERY_WEAK"
    | "WEAK"
    | "NEUTRAL"
    | "DEVELOPING"
    | "STRONG"
    | "VERY_STRONG";
  acceleration: "ACCELERATING" | "DECELERATING" | "FLAT";
  relVolumeConfirm: boolean;
  structureConfirm: boolean;
  liquidityContext: string;
  orderFlowStatus: "CONFIRMING" | "DISAGREEING" | "UNAVAILABLE";
  futuresStatus: "CONFIRMING" | "DISAGREEING" | "UNAVAILABLE";
  dataQuality: string;
  dataQualityMultiplier: number;
  components: FMPIComponent[];
  penalties: { reason: string; amount: number }[];
  supporting: string[];
  reducing: string[];
  invalidation: string[];
  asOfCandleTs: number;
  history: { ts: number; score: number }[];
}

export interface DepthLevel {
  price: number;
  bidQty: number;
  askQty: number;
  bidOrders: number;
  askOrders: number;
}

export interface DepthAnalysis {
  available: boolean;
  reason: string;
  ts: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  spreadBps: number | null;
  levels: DepthLevel[];
  totalBidQty: number | null;
  totalAskQty: number | null;
  obi: number | null; // (bidQty-askQty)/(bidQty+askQty), documented
  obiWindow: string;
  walls: { side: "bid" | "ask"; price: number; qty: number; note: string }[];
  capabilityNote: string;
}

export interface TradeScenario {
  status:
    | "DEVELOPING"
    | "WAITING_CONFIRMATION"
    | "ENTRY_CONDITION_MET"
    | "INVALIDATED"
    | "NO_TRADE";
  direction: "LONG" | "SHORT" | null;
  setup: string;
  symbol: string;
  tf: string;
  ts: number;
  price: number;
  level: number | null;
  entryZone: [number, number] | null;
  entryTrigger: string;
  stop: number | null;
  stopReason: string;
  t1: number | null;
  t2: number | null;
  rr: number | null;
  fmpi: number | null;
  supporting: string[];
  contradicting: string[];
  noTradeReasons: string[];
  cancelIf: string[];
  lifecycle: { state: string; ts: number; note: string }[];
}

export interface IndicatorSnapshots {
  ema9: (number | null)[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  vwap: (number | null)[];
  rsi: (number | null)[];
  bbMid: (number | null)[];
  bbUp: (number | null)[];
  bbLo: (number | null)[];
  atr: (number | null)[];
  relVol: (number | null)[];
}

export interface DayContext {
  date: string;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  prevHigh: number;
  prevLow: number;
  prevWeekHigh: number | null;
  prevWeekLow: number | null;
  orHigh: number | null; // first 15m
  orLow: number | null;
  replay: boolean;
}

export interface AnalysisBundle {
  symbol: string;
  label: string;
  kind: string;
  sector: string;
  tf: string;
  tfMinutes: number;
  ts: number;
  quality: DataQuality;
  day: DayContext;
  candles: Candle[];
  indicators: IndicatorSnapshots;
  last: {
    price: number;
    change: number;
    changePct: number;
    volume: number;
    relVol: number | null;
    atr: number | null;
    rsi: number | null;
    vwap: number | null;
  };
  structure: StructureInfo;
  zones: Zone[];
  profile: VolumeProfileResult | null;
  movement: MovementAssessment;
  fmpi: FMPIResult;
  scenario: TradeScenario;
  depth: DepthAnalysis;
  futures: any;
  optionLevels: any;
  footprint: any;
  events: { ts: number; kind: string; text: string; price: number }[];
}

export interface ScannerCandidate {
  symbol: string;
  name: string;
  kind: string;
  sector: string;
  price: number;
  changePct: number;
  relVol: number;
  fmpi: number;
  direction: "BULLISH" | "BEARISH" | "NEUTRAL";
  state: string;
  structure: string;
  rankScore: number;
  reasons: string[];
  invalidation: string[];
  dataQuality: string;
  dominanceLabel: string;
}

export interface NewsItem {
  id: string;
  headline: string;
  source: string;
  link: string;
  publishedTs: number;
  summary: string;
  related: string | null;
  tone: "BULLISH" | "BEARISH" | "NEUTRAL" | "UNCERTAIN";
  impact: "HIGH" | "MEDIUM" | "LOW";
  impactReason: string;
  verified: boolean;
}
