/**
 * Recorded fixture of the REAL Upstox instrument-master schema.
 * Captured from assets.upstox.com (Oct 2026) and trimmed to the rows the
 * registry tests need. Field names/shapes are byte-faithful to production,
 * including instrument_type "FUT"/"CE"/"PE", epoch-ms `expiry`, paise
 * `tick_size`, and the underlying_key linkage.
 *
 * TEST-ONLY: never used as production market data.
 */

const DAY = 86_400_000;
export const FIXTURE_NOW = Date.UTC(2026, 9, 21, 4, 0, 0); // 2026-10-21 09:30 IST

const eq = (trading_symbol: string, name: string, isin: string, token: string, instrument_type = "EQ") => ({
  segment: "NSE_EQ", name, exchange: "NSE", isin, instrument_type,
  instrument_key: `NSE_EQ|${isin}`, lot_size: 1, freeze_quantity: 100000.0,
  exchange_token: token, tick_size: 10.0, trading_symbol, short_name: trading_symbol,
  qty_multiplier: 1.0, security_type: "NORMAL", cas_eligible: true,
});

const fut = (underlying_symbol: string, name: string, underlying_key: string, token: string, expiry: number, lot_size: number, underlying_type = "EQUITY") => ({
  weekly: false, segment: "NSE_FO", name, exchange: "NSE", expiry,
  instrument_type: "FUT", asset_symbol: underlying_symbol, underlying_symbol,
  instrument_key: `NSE_FO|${token}`, lot_size, freeze_quantity: 9000.0,
  exchange_token: token, minimum_lot: lot_size, asset_key: underlying_key, underlying_key,
  tick_size: 10.0, asset_type: underlying_type, underlying_type,
  trading_symbol: `${underlying_symbol} FUT 29 DEC 26`, strike_price: 0.0, qty_multiplier: 1.0,
});

export const MASTER_FIXTURE: any[] = [
  // ---- indices (note: trading_symbol is UPPER, name is mixed-case) -------
  { segment: "NSE_INDEX", name: "Nifty 50", exchange: "NSE", instrument_type: "INDEX", instrument_key: "NSE_INDEX|Nifty 50", exchange_token: "26000", trading_symbol: "NIFTY" },
  { segment: "NSE_INDEX", name: "Nifty Bank", exchange: "NSE", instrument_type: "INDEX", instrument_key: "NSE_INDEX|Nifty Bank", exchange_token: "26009", trading_symbol: "BANKNIFTY" },
  { segment: "BSE_INDEX", name: "BSE SENSEX", exchange: "BSE", instrument_type: "INDEX", instrument_key: "BSE_INDEX|SENSEX", exchange_token: "1", trading_symbol: "SENSEX" },

  // ---- equities ---------------------------------------------------------
  eq("TCS", "TATA CONSULTANCY SERV LT", "INE467B01029", "11536"),
  eq("RELIANCE", "RELIANCE INDUSTRIES LTD", "INE002A01018", "2885"),
  eq("HDFCBANK", "HDFC BANK LTD", "INE040A01034", "1333"),
  eq("INFY", "INFOSYS LIMITED", "INE009A01021", "1594"),
  eq("SBIN", "STATE BANK OF INDIA", "INE062A01020", "3045"),
  eq("BAJFINANCE", "BAJAJ FINANCE LIMITED", "INE296A01024", "317"),
  eq("KOTAKBANK", "KOTAK MAHINDRA BANK LTD", "INE237A01028", "1922"),
  // a cash-only scrip (NOT F&O eligible) — must still be resolvable
  eq("ZEEMEDIA", "ZEE MEDIA CORPORATION LTD", "INE966H01019", "18789"),
  // non-equity series that must be excluded from the registry
  { segment: "NSE_EQ", name: "GOI LOAN 7.26%", exchange: "NSE", isin: "IN0020230085", instrument_type: "SG", instrument_key: "NSE_EQ|IN0020230085", lot_size: 1, exchange_token: "9999", tick_size: 1.0, trading_symbol: "726GS2033", security_type: "NORMAL" },

  // ---- futures: nearest + far expiry, plus one EXPIRED contract ---------
  fut("TCS", "TATA CONSULTANCY SERV LT", "NSE_EQ|INE467B01029", "59132", FIXTURE_NOW + 30 * DAY, 225),
  fut("TCS", "TATA CONSULTANCY SERV LT", "NSE_EQ|INE467B01029", "59133", FIXTURE_NOW + 60 * DAY, 225),
  fut("TCS", "TATA CONSULTANCY SERV LT", "NSE_EQ|INE467B01029", "59100", FIXTURE_NOW - 5 * DAY, 225), // expired
  fut("RELIANCE", "RELIANCE INDUSTRIES LTD", "NSE_EQ|INE002A01018", "59201", FIXTURE_NOW + 30 * DAY, 250),
  fut("HDFCBANK", "HDFC BANK LTD", "NSE_EQ|INE040A01034", "59301", FIXTURE_NOW + 30 * DAY, 550),
  fut("INFY", "INFOSYS LIMITED", "NSE_EQ|INE009A01021", "59401", FIXTURE_NOW + 30 * DAY, 400),
  fut("SBIN", "STATE BANK OF INDIA", "NSE_EQ|INE062A01020", "59501", FIXTURE_NOW + 30 * DAY, 750),
  fut("BAJFINANCE", "BAJAJ FINANCE LIMITED", "NSE_EQ|INE296A01024", "59601", FIXTURE_NOW + 30 * DAY, 750),
  fut("KOTAKBANK", "KOTAK MAHINDRA BANK LTD", "NSE_EQ|INE237A01028", "59701", FIXTURE_NOW + 30 * DAY, 400),
  fut("NIFTY", "NIFTY", "NSE_INDEX|Nifty 50", "48001", FIXTURE_NOW + 10 * DAY, 75, "INDEX"),
  fut("BANKNIFTY", "BANKNIFTY", "NSE_INDEX|Nifty Bank", "48699", FIXTURE_NOW + 10 * DAY, 30, "INDEX"),

  // ---- options (must not be treated as futures) ------------------------
  { weekly: false, segment: "NSE_FO", name: "NIFTY", exchange: "NSE", expiry: FIXTURE_NOW + 10 * DAY, instrument_type: "CE", asset_symbol: "NIFTY", underlying_symbol: "NIFTY", instrument_key: "NSE_FO|50918", lot_size: 75, exchange_token: "50918", asset_key: "NSE_INDEX|Nifty 50", underlying_key: "NSE_INDEX|Nifty 50", tick_size: 5.0, asset_type: "INDEX", underlying_type: "INDEX", trading_symbol: "NIFTY 25000 CE 27 OCT 26", strike_price: 25000.0 },
  { weekly: false, segment: "NSE_FO", name: "NIFTY", exchange: "NSE", expiry: FIXTURE_NOW + 10 * DAY, instrument_type: "PE", asset_symbol: "NIFTY", underlying_symbol: "NIFTY", instrument_key: "NSE_FO|50919", lot_size: 75, exchange_token: "50919", asset_key: "NSE_INDEX|Nifty 50", underlying_key: "NSE_INDEX|Nifty 50", tick_size: 5.0, asset_type: "INDEX", underlying_type: "INDEX", trading_symbol: "NIFTY 25000 PE 27 OCT 26", strike_price: 25000.0 },
];

/** Raw Upstox v3 historical-candle rows: [ts, o, h, l, c, volume, oi] */
export const CANDLE_ROWS: any[][] = [
  ["2026-10-21T09:15:00+05:30", 100, 101, 99.5, 100.8, 12000, 0],
  ["2026-10-21T09:16:00+05:30", 100.8, 101.6, 100.4, 101.2, 9000, 0],
  ["2026-10-21T09:17:00+05:30", 101.2, 101.4, 100.2, 100.5, 15000, 0],
  ["2026-10-21T09:18:00+05:30", 100.5, 102.0, 100.4, 101.9, 21000, 0],
  ["2026-10-21T09:19:00+05:30", 101.9, 102.4, 101.5, 102.1, 11000, 0],
];

/** Malformed rows that candle validation MUST reject. */
export const BAD_CANDLE_ROWS = [
  { ts: NaN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },     // bad timestamp
  { ts: 1, open: -5, high: 2, low: 0.5, close: 1.5, volume: 10 },      // negative price
  { ts: 2, open: 1, high: 0.4, low: 0.5, close: 1.5, volume: 10 },     // high < low
  { ts: 3, open: 1, high: 1.2, low: 0.5, close: 9.9, volume: 10 },     // close above high
  { ts: 4, open: 1, high: 1.2, low: 0.5, close: 1.1, volume: -3 },     // negative volume
];
