# PulseGrid — Market Movement, Liquidity, Order Flow & FMPI Intelligence Platform

A standalone, production-oriented Indian stock-market **decision-support** platform.
It explains **what the market is doing now**, ** where liquidity may exist **, whether a
move is **strengthening or weakening**, and whether an intraday setup has **sufficient
documented evidence** to justify reviewing a trade scenario.

> This is **not** a prediction system. No signal guarantees profit, no accuracy
> percentage is claimed anywhere, and order execution is deliberately **disabled**
> (analysis-only platform).

---

## 0a. ROOT-CAUSE REPORT — "TCS not in the discovered Upstox universe"

Traced end-to-end: `selection → registry → instrument key → API → candles → chart`.
The failure was entirely in **instrument discovery** (`discovery.ts`), not the
frontend, not auth, and not the chart. Evidence came from downloading the real
master (`assets.upstox.com/.../NSE.json.gz`, 80,017 rows) and inspecting rows.

| # | Bug | Evidence | Effect | Fix |
|---|---|---|---|---|
| **B1** | Futures filtered on `instrument_type === "FUTSTK"/"FUTIDX"` | Real master uses **`FUT`** (653 rows), options `CE`/`PE`. `FUTSTK` count = **0** | `futByUnderlying` empty → **zero stocks** added → every equity "not in universe" | match `FUT`, treat `CE`/`PE` as options |
| **B2** | `expiry` parsed as `"YYYY-MM-DD"` string | `expiry` is **epoch ms** (`1798568999000`) | `"1798568999000" < "20261021"` lexicographically → **every contract judged expired** | numeric epoch comparison |
| **B3** | Futures→equity linked via `r.name` | Futures `name` = `"TATA CONSULTANCY SERV LT"`, equity map keyed by `trading_symbol` = `"TCS"` | never matched even if B1/B2 were fixed | link via `underlying_symbol` + `underlying_key` |
| **B4** | Indices looked up by `name` in a `trading_symbol`-keyed map | index rows: `trading_symbol:"NIFTY"`, `name:"Nifty 50"` | lookup missed; survived only via a hardcoded fallback key | index by **both**, match canonical ticker first |
| **B5** | Stocks required F&O eligibility to exist at all | — | cash-only scrips could never be charted (violates §2.7) | all listed equities registered; `foEligible` is an independent flag |
| **B6** | `tick_size` used raw | master value is **paise** (`10.0` = ₹0.10) | 100× wrong tick | `/100` |
| **B7** | Only the NSE master was downloaded | SENSEX lives in **BSE** master | SENSEX unresolvable from the master | both masters loaded |
| **B8** | `/api/analysis` returned **404** for unresolved symbols | — | Depth/Futures/Trades/Alerts tabs rendered **blank** | always returns a renderable bundle + diagnostics |

**Verified after the fix, against the live masters:** 3,516 equities parsed ·
665 live FUT contracts · **223 F&O underlyings** · NIFTY/BANKNIFTY/SENSEX all
resolve. `TCS → NSE_EQ|INE467B01029` + `NSE_FO|49013` (lot 225); RELIANCE,
HDFCBANK, INFY, SBIN, BAJFINANCE, KOTAKBANK all resolve to distinct keys.

**TATAMOTORS is genuinely absent** from the current NSE master (post-demerger
rename; no `TATAMOT*` trading symbol and no F&O underlying exists). It is
therefore reported honestly as `INSTRUMENT_UNAVAILABLE` with "did you mean"
suggestions, and removed from the seeded watchlist — **not** faked.

### File-level changes
- `src/lib/market/discovery.ts` — rewritten; correct schema parsing (B1–B7), pure `parseMasterRows()` for tests
- `src/lib/market/upstox.ts` — `fetchInstrumentMaster(NSE|BSE)`, token validation, `prevOI`
- `src/lib/market/universe.ts` — canonical registry: alias/case/punctuation-tolerant resolve, `foUniverse()`, `suggestSymbols()`
- `src/lib/market/diagnostics.ts` — **new**: per-stage pipeline results, per-channel freshness, failure categories
- `src/lib/market/sweeps.ts` — **new**: validated 5-criteria sweep engine + state machine
- `src/lib/market/engine.ts` — candle validation/sanitisation, diagnostics wiring, index depth via futures, F&O-only scanning, `batchQuotes()`
- `src/lib/market/zones.ts` — break direction respects zone side; sweeps only from validated events
- `src/app/api/quotes/route.ts` — **new**: batched watchlist quotes
- `src/app/api/analysis/route.ts` — never 404s
- `src/lib/client/api.ts` — race-safe polling (abort + key guard)
- `src/components/Diagnostics.tsx` — **new** expandable diagnostic panel
- `src/components/panels/*` — FeedGate states, batch watchlist rail, sweep cards

## 0b. PIPELINE REPAIR — ROUND 2 (Futures/OI, Depth, Alerts, Trade Finder)

Three further root causes were found by tracing each dead module:

| # | Bug | Evidence | Effect | Fix |
|---|---|---|---|---|
| **B9** | Option expiry compared/sent as the wrong type | `/v2/option/contract` returns `expiry` as **epoch ms**; code did `expiry >= "2026-10-21"` (number vs string → NaN → always false) then sent the raw epoch as `expiry_date=` | **Every option-chain request rejected** → Futures & Options permanently empty | `toExpiryDate()` normalises epoch→`YYYY-MM-DD` (IST); `selectExpiry()` picks the nearest non-expired |
| **B10** | ΔOI depended on `prev_oi` | Quote API frequently omits `prev_oi` | OI change permanently `null`, OI panel inert | previous OI now derived from the **same contract's daily candles** (v3 carries OI at index 6) |
| **B11** | Trade Finder / Alerts never scanned anything | Trade Finder evaluated only the *selected* symbol; Alerts rendered only static rule definitions | Both pages looked permanently inert | new `opportunities.ts` runs one shared universe pass feeding **both** |
| **B12** | `buildDepth` gated on `upstoxConfigured()` even with a valid payload | — | redundant gate, untestable | guard applies only when there is no payload |

### New shared services
- **`src/lib/market/futures.ts`** — `futuresSnapshot()` (price, change, %, volume, OI, ΔOI, ΔOI%, basis, basis%, expiry, days-to-expiry, lot size, price/OI label, per-field `missing[]`) and `optionChainIntel()` with correct expiry handling. Unavailable fields render **"Unavailable" + reason**, never `0`.
- **`src/lib/market/opportunities.ts`** — one universe pass → ranked Trade Finder candidates **and** alert evaluation + live "currently qualifying" snapshot per rule.
  `rank = 0.30·FMPI + 0.20·RR + 0.18·stateQuality + 0.12·participation + 0.10·evidence + 0.10·dataQuality`
  Instruments missing required inputs are **excluded**, never scored neutral; the list is never padded to 10.
- **`/api/opportunities`** (GET cached 30s / POST force+persist), **`/api/quotes`** (batch watchlist), **`/api/alerts`** (universe or symbol mode, dedupe + cooldown + persistence).

### UI (layout preserved)
- **Trade Finder** — ranked top-10 cards (rank, symbol, instrument type, direction, setup, price, FMPI, state, entry, stop, T1/T2, RR, liquidity context, supporting/contradicting, data timestamp, status, *reason for ranking*), filters (direction / index·F&O·cash / min RR / min FMPI), "Scan now", and an expandable **"why N instruments were excluded"** list. Clicking a card opens that instrument's synchronized view.
- **Alerts** — "Currently qualifying stocks" grouped by rule, triggered-alert history with symbol/rule filter, all **17 rules** with live match counts, and an explicit *rule ≠ trigger* note.
- **Futures & Options** — full field grid + OI interpretation chip + `missing[]` disclosure.

## 0a-2. ROUND 3 ROOT-CAUSE REPORT — Futures/OI + Depth returning nothing

The two screenshots showing **“Futures channel unavailable”** and **“Order book not
being received”** had a single shared root cause, found by verifying every
endpoint against the current official Upstox documentation.

| # | Bug | Evidence | Effect | Fix |
|---|---|---|---|---|
| **B13** | `fetchFullQuote()` called `GET /v2/market-quote/full` | **Not a documented Upstox endpoint.** The documented *Full Market Quotes* API (which returns depth + OI + OHLC) is `GET /v2/market-quote/quotes`. Only `quotes`, `ltp`, `ohlc` exist under `/v2/market-quote/` | Every depth **and** futures quote request failed → both panels permanently showed “unavailable” regardless of token validity | both single and batch quotes now use `/v2/market-quote/quotes` |
| **B14** | Response `data` keyed by `<EXCHANGE>:<TRADING_SYMBOL>`; depth padded with `{quantity:0,price:0,orders:0}` placeholder rows | documented V3/V2 response example | lookups by `instrument_key` could miss; **OBI was computed from phantom zero-levels**, producing misleading ±1.0 readings | quotes indexed under 4 identifiers; placeholder depth rows stripped before any calculation |
| **B15** | `fetchQuotes()` did `.slice(0, 450)` | Upstox caps a call at 500 keys (UDAPI100042) | **every key beyond the first 450 was silently dropped** — most of the F&O universe was never quoted, so scanner/watchlist coverage was a fraction of what it appeared | proper chunked batching + merge |
| **B16** | Read `q.prev_oi`; Upstox field is `previous_oi` | documented response | ΔOI always null | read `previous_oi` (fallback `prev_oi`) |
| **B17** | Quote-only / insufficient-data instruments could still be **ranked** if the user lowered thresholds | found by a test | missing inputs treated as positive evidence | hard data-eligibility gate applied *before* configurable filters |

### Files changed this round
`src/lib/market/upstox.ts` (endpoint + normalisation + batching, `__testables`),
`src/lib/market/engine.ts` (depth from sanitised levels, quote lookup by all ids),
`src/lib/market/futures.ts` (`previous_oi`, `prev_close_price`),
`src/lib/market/scanner.ts` (coverage accounting + eligibility gate),
`src/components/panels/ScannerPanel.tsx` (coverage chips),
`tests/upstox-adapter.test.ts`, `tests/integration.real-master.test.ts` (new).

### Verified against genuine provider data
`tests/integration.real-master.test.ts` downloads the **live** instrument master
and runs the real discovery code (skips automatically offline):
`registry=3522 · stocks=3516 · F&O=219 · indices=6`. TCS, RELIANCE, HDFCBANK,
INFY, SBIN, BAJFINANCE, KOTAKBANK each resolve to a **distinct** `NSE_EQ|INE…`
key with a current `NSE_FO|…` futures contract, non-expired expiry and correct
lot size / rupee tick. NIFTY → `NSE_INDEX|Nifty 50`, BANKNIFTY →
`NSE_INDEX|Nifty Bank`, SENSEX → `BSE_INDEX|SENSEX`.

**TATAMOTORS is genuinely absent** from the current master (post-demerger rename;
no `TATAMOT*` symbol, no F&O underlying). It reports `INSTRUMENT_UNAVAILABLE`
with suggestions instead of being faked.

## 0. Honesty contract (read first)

| Data class | How the platform treats it |
|---|---|
| **Observed** (live Upstox quote/depth/chain when configured) | Shown with timestamps & freshness. |
| **Calculated** (indicators, zones, FMPI, movement states) | Derived from observed/simulated candles via documented rules; rule text always visible. |
| **Estimates / approximations** (volume profile binning, offline sessions) | Explicitly labelled `approximation` / `OFFLINE_SIMULATION`. |
| **Unavailable** (order flow, footprint delta, futures OI offline, news when source unreachable) | Shown as disabled capability cards with the exact reason. **Nothing is fabricated.** |

Two engine modes:

- **`LIVE_UPSTOX`** — active when `UPSTOX_ACCESS_TOKEN` is configured. Quotes, intraday
  candles (v3), market depth, option chain and the instrument master come from
  official Upstox HTTP APIs. Failures surface as `STALE`/`UNAVAILABLE` quality states —
  offline data is **never silently substituted** in live mode.
- **`OFFLINE_SIMULATION`** — active without a token. Deterministic seeded sessions
  (trend/chop regimes, U-shaped volume, gaps) keep every analytic inspectable and every
  test reproducible. A permanent banner + per-panel badges mark **all** of it as
  simulated. It exists for interface validation, rule testing, and development.

---

## 1. Architecture

Monorepo-style Next.js (App Router) fullstack app:

```
┌────────────────────────────  BROWSER  ───────────────────────────┐
│ Terminal UI (React 19 client components, lightweight-charts)     │
│  12 panels · polling hooks (4–15s) · SSE channel (fallback)      │
└───────────────▲──────────────────────────────────────────────────┘
                │ JSON (Next.js Route Handlers, Node runtime)
┌───────────────┴────────────────  SERVER  ────────────────────────┐
│ src/lib/market (pure engines)                                    │
│  sim.ts (offline sessions)  upstox.ts (live adapter)             │
│  indicators.ts structure.ts zones.ts profile.ts movement.ts      │
│  fmpi.ts trades.ts scanner.ts alerts.ts news.ts backtest.ts      │
│  derivatives.ts engine.ts (orchestration + caching)              │
│ PostgreSQL (Drizzle): watchlists, alert rules/events, signal     │
│  events, trade scenarios, backtest runs, settings                │
└──────────────────────────────────────────────────────────────────┘
```

### File tree (key paths)

```
src/
  app/
    layout.tsx / page.tsx / globals.css
    api/ health, status, overview, instruments, snapshot, analysis,
        scanner, news, backtest, alerts, watchlists(+items), settings, stream (SSE)
  components/
    Terminal.tsx (shell: nav rail, header, instrument bar)
    PriceChart.tsx  ui.tsx
    panels/ Overview, Workspace(movement), Liquidity, Depth, Fmpi,
            Scanner, Derivatives, News, Trades, Alerts, Backtest, Settings
  db/ schema.ts index.ts
  lib/market/ (engines above)
  lib/client/ api.ts (polling, formatters)
tests/core.test.ts (27 automated tests)
.env.example  vitest.config.ts  drizzle.config.json  README.md
```

---

## 1b. Responsive/mobile support

The existing terminal UI is preserved on desktop and uses a dedicated mobile
layout below 1024px:

- **Phone:** compact wrapping header, viewport-safe Upstox login sheet,
  full-width instrument search, swipeable horizontal module navigation,
  two/three-column metric cards, single-column analytics and natural page
  scrolling. Touch targets are at least 44px for primary navigation.
- **Tablet:** stacked analysis panels with two-column scanner/result groups.
- **Desktop:** original fixed-height terminal workspace, left navigation rail,
  synchronized chart and right intelligence rail.
- Uses `100dvh`, safe-area insets and momentum scrolling for iOS/Android.
- Search, token login, panels, charts, rule cards and scanner controls never
  require horizontal page scrolling; dense rows retain local scrolling where
  appropriate.

## 1c. Deploy on Render (Blueprint — recommended)

The repository includes `render.yaml`. Deploy without creating services by hand:

1. Push the repository to GitHub/GitLab.
2. In Render: **New → Blueprint**.
3. Select the repository. Render creates:
   - `pulsegrid-market-intelligence` Node web service
   - `pulsegrid-db` managed PostgreSQL database
4. Enter `UPSTOX_ACCESS_TOKEN` when Render prompts for the secret.
5. Apply the Blueprint and wait for `/api/health` to pass.

The Blueprint runs:

```bash
# build
npm install --include=dev
npx drizzle-kit push --force     # DATABASE_URL comes from Render PostgreSQL
npm run build

# start (Render injects PORT; Next.js respects it)
npm run start
```

Important Render notes:

- `drizzle.config.ts` reads `DATABASE_URL`; no localhost/database password is
  hardcoded for deployment.
- Add `UPSTOX_ACCESS_TOKEN` as a **Secret Environment Variable** if the live
  connection must survive restarts and work across instances. Tokens entered
  through the UI remain server-memory-only by design and are lost on restart.
- Upstox access tokens expire; update the Render secret when required.
- Free web services may sleep when idle, causing a cold start. Use a paid
  instance for continuous 30-second scanners/alerts.
- Render free PostgreSQL retention/lifecycle policies can change. Use a paid
  database for production alert/watchlist/backtest persistence.
- Health check: `GET /api/health`.
- Region is set to Singapore in `render.yaml`; change both web and database
  regions together if another region is preferable.

Manual Render setup (without Blueprint): create a Node Web Service, attach a
PostgreSQL database, set the same build/start commands, and add `DATABASE_URL`
and `UPSTOX_ACCESS_TOKEN` as environment variables.

## 2. Setup & run

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env            # fill DATABASE_URL; optionally UPSTOX_ACCESS_TOKEN

# 3. Database schema
npx drizzle-kit push            # creates watchlists/alerts/settings/backtest tables

# 4. Develop
npm run dev                     # http://localhost:3000

# 5. Production
npm run build && npm run start

# 6. Tests
npx vitest run                  # 27 tests (see §13)

# 7. Type safety
npm run typecheck
```

Healthcheck: `GET /api/health → {"ok":true}`.

### Live Upstox activation
1. Create an app at the Upstox developer console, complete OAuth, obtain an access token.
2. Set `UPSTOX_ACCESS_TOKEN` in `.env` (server-side only; it is never logged,
   never sent to the browser, never persisted).
3. Restart. `GET /api/status` reports `mode: LIVE_UPSTOX` and the universe switches to
   `UPSTOX_INSTRUMENT_MASTER` (dynamically discovered — never a hardcoded list).

Known Upstox endpoints used (v2/v3): `/v2/market-quote/quotes`, `/v2/market-quote/full`,
`/v3/historical-candle/intraday/{key}/{unit}/{interval}`, `/v3/historical-candle/...`,
`/v2/option/contract`, `/v2/option/chain`, plus the public NSE instrument master
(`assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz`) for dynamic F&O
universe discovery with a 6-hour cache.

---

## 3. API & WebSocket documentation

| Route | Method | Description |
|---|---|---|
| `/api/health` | GET | health |
| `/api/status` | GET | engine mode, session clock, universe source, notes |
| `/api/overview` | GET | indices snapshots, breadth, sector table, movers |
| `/api/instruments?q=` | GET | universe search (dynamic discovery in live mode) |
| `/api/snapshot?symbol=` | GET | header/watchlist tick |
| `/api/analysis?symbol=&tf=` | GET | **full intelligence bundle** (candles, indicators, structure, zones, profile, movement, FMPI, scenario, depth, futures, options, footprint capability, events) |
| `/api/scanner?count=` | GET | momentum scan with documented ranking |
| `/api/news?symbol=|q=` | GET | Google News RSS, deduped, impact heuristics |
| `/api/backtest` | POST/GET | run documented backtest / list persisted runs |
| `/api/alerts` | POST/GET | evaluate rule set (dedupe+cooldown, persisted) / history |
| `/api/watchlists` `/api/watchlists/items` | GET/POST/DELETE | persisted watchlists |
| `/api/settings` | GET/PUT | runtime scanner/risk/alert thresholds (persisted, applied live) |
| `/api/stream?symbol=` | GET (SSE) | 4s server-push of status+snapshot |

**WebSocket note.** Upstox streams ticks as protobuf over WSS. This build implements
the officially-supported **controlled polling fallback** (quote API) plus an SSE channel
to the browser. Tick-perfect protobuf streaming is listed as a known limitation (§14).

---

## 4. Instrument universe & mapping

- NIFTY 50, SENSEX, BANKNIFTY + NSE F&O single stocks.
- Live mode: universe + futures/option contract keys resolved from the Upstox
  instrument master; offline mode: a **labelled fallback universe** (~57 instruments)
  of current well-known F&O constituents is used with `OFFLINE_*` keys — clearly
  identified by `universeSource: FALLBACK_OFFLINE`.
- Index spot is never shown with an executable order book; futures depth applies to
  the mapped futures contract only.

---

## 5. Candle engine

- 1m source candles aggregated to 1/2/3/5/15/30m; forming candle flagged `live`,
  indicators/signals run on **completed candles only** (no repaint).
- Session boundaries 09:15–15:30 IST; outside hours the engine replays the last
  completed session on a labelled replay clock.
- Gaps possible in offline mode by construction; live gaps flow through as-is.
- Every bundle carries `quality.lastCandleTs` and stale states suppress signals.

---

## 6. Market movement states (classification rules)

Ordered rule evaluation over structure (k=2 swings, HH/HL/LH/LL, BOS, CHOCH), indicator
context (EMA9/21/50/200, VWAP, RSI, Bollinger-width percentile, ATR-normalized ROC),
relative volume, range expansion, zone interactions and volume-profile position:

1. `INSUFFICIENT_DATA` (<30 completed candles) → everything suppressed.
2. `POTENTIAL_LIQUIDITY_SWEEP` — a zone in `POTENTIALLY_SWEPT` state (breach + close
   back inside). Always paired with the honesty sentence: *not proof of executed stops*.
3. `CONFIRMED_UPSIDE_BREAKOUT` / `CONFIRMED_DOWNSIDE_BREAKDOWN` — decisive close beyond
   an active zone **with** relVol ≥ 1.3 **and** range expansion (or a recent BOS with
   volume). A wick alone never confirms.
4. `CONFIRMED_STRUCTURAL_SHIFT` — CHOCH ≤ 8 candles ago followed by aligned structure.
5. Trend family (`BULLISH/BEARISH_CONTINUATION`, `*_MOMENTUM_STRENGTHENING`,
   `*_MOMENTUM_WEAKENING`) — structure trend + EMA/VWAP/ROC votes + acceleration sign.
6. Range family (`VOLATILITY_CONTRACTION` ≤25th pct BB-width, `VOLATILITY_EXPANSION`
   ≥85th with volume/range expansion, `CONSOLIDATION`, `RANGE_BOUND`,
   `BREAKOUT_DEVELOPING` when pressing a zone within 1 ATR without rejection).
7. `FAILED_BREAKOUT/DOWN`, `POTENTIAL_*_REVERSAL` overlays.
8. `CONFLICTING_SIGNALS` — ≥2 bullish and ≥2 bearish votes → bias forced NEUTRAL and
   trading disallowed by the capital-protection gate.

Every state is emitted with `supporting[]`, `contradicting[]`, `confirmNext[]`,
`invalidateBias[]`, `tradeJustified` and `waitReason` — **no unexplained BUY/SELL**.

---

## 7. Liquidity-zone engine

Sources: swings, equal highs/lows (≤0.1 ATR), PDH/PDL, PWH/PWL, opening range (15m),
consolidation boundaries, profile POC/VAH/VAL/HVN/LVN (approximation-labelled).

- **Merge rule:** midpoints within `0.45×ATR` merge; wider span kept, stronger base
  wins, confluence counted.
- **Strength (5–100):** source weight (PDH/L 18, PWH/L 16, OR 14, equal 16, swing 12,
  POC 12, VAH/VAL 10, consol 10, HVN 8, LVN 6) + 8/test (max 24) + 6/reaction
  (max 18) + 10 confluence − age decay, ×state multipliers (REJECTED +8, BROKEN ×0.55,
  INVALIDATED ×0.35).
- **State machine:** `NEW → APPROACHING (≤0.6 ATR) → TESTING (inside) → HOLDING/
  REJECTED (rejection closes) / BROKEN (close beyond 0.15×ATR) → RECLAIMED /
  POTENTIALLY_SWEPT (wick beyond + close back) / INVALIDATED (2 closes beyond)`.
- Zones are **historical price-structure references**, explicitly distinguished from
  live displayed depth liquidity.

---

## 8. Volume profile

`UNIFORM_ALLOCATION_FROM_OHLCV` — each candle's volume spread evenly across the bins
its range touches (documented approximation; true per-price executed volume is unknown
from OHLCV). POC = max-volume bin; Value Area = greedy expansion from POC to 70%
(configurable); HVN ≥1.5× mean, LVN ≤0.5× mean (local extrema). Position states:
inside value / testing VAH-VAL (0.12 ATR) / accepting above-below (4 closes) /
rotating around POC (≥3 crosses, tight range). Profile levels are contextual, never
guaranteed S/R.

---

## 9. FMPI — Full Momentum (Pulse) Intelligence

**Component weights (default, configurable):**

| component | weight | content |
|---|---|---|
| Directional momentum | 0.22 | ROC(3)/ROC(8) in ATR units, EMA9–21 spread, Bollinger position |
| Price-structure quality | 0.16 | trend purity, BOS/CHOCH alignment |
| Participation & relative volume | 0.16 | relVol (capped 2×) + volume acceleration |
| Momentum persistence | 0.08 | 6-candle sign consistency + body ratio |
| Volatility & continuation | 0.10 | ATR% regime + ATR trend |
| Liquidity & breakout context | 0.10 | acceptance beyond value, held retests, sweeps |
| Order-flow confirmation | 0.08 | **live feed only** — offline: unavailable, weight redistributed |
| Futures confirmation | 0.08 | **live feed only** — same rule |

`base = Σwᵢvᵢ / Σwᵢ(available)`; `score = clamp(base − penalties, 0..1) × 100 × dq`.
Penalties (cap 0.15): price/participation divergence, conflicting votes, unconfirmed
sweep, ≥3 contradicting items. Data-quality multiplier 1.0 / 0.92 / 0.85.
Direction = net weighted signed votes (|net|<0.12 → NEUTRAL). Bands:
<20 very weak · 20–35 weak · 35–50 neutral · 50–65 developing · 65–80 strong · >80
very strong (thresholds configurable; **no win-rate is claimed for any band**).
History values are recomputed from truncated candles — fully reproducible.
Completed-candle-only calculation, correlated-feature caps, and explicit
insufficient-data suppression act as anti-noise controls.

---

## 10. Order flow, depth & footprint — capability doctrine

- **OBI** = `(BidQty − AskQty) / (BidQty + AskQty)` across displayed levels, computed
  only from valid contemporaneous depth with zero-guards; thresholds configurable.
  OBI never implies guaranteed direction.
- Displayed vs executed liquidity are strictly separated; disappeared displayed size
  is never reported as executed; nothing is labelled institutional.
- **True footprint** requires trade-level aggressor classification. Neither the
  Upstox quote/depth API nor the offline engine provides it, so the footprint panel
  shows a capability gate + a *labelled* candle-based volume-at-price approximation
  (no delta, no buy/sell split). No invented footprint numbers ever exist.

---

## 11. Scanner, buyer/seller dominance, trade scenarios

**Rank** = `0.34·FMPI + 0.22·participation + 0.16·momentum + 0.12·structure
+ 0.08·liquidity + 0.08·dataQuality` (weights shown in UI). Default 5+5 output,
never padded. **Dominance label** requires FMPI ≥ 60 **and** relVol ≥ 1.3 **and**
aligned non-range structure — otherwise "displayed pressure" wording is used; offline
mode can never claim confirmed executed aggressive flow.

**Trade scenarios** (breakout/breakdown, continuation, pullback, rejection,
sweep-reversal families): structure-based entry triggers, invalidation = structure
level ± 0.35×ATR (never fixed distances), T1 = opposing zone or 1.5R, T2 likewise,
RR filters, lifecycle states, FMPI/evidence/counter-evidence lists. Mandatory
**Part-24 no-trade gates**: stale/missing data · structure-momentum conflict ·
unconfirmed setup · RR < min · unclear invalidation (<0.2 ATR) · unsuitable spread/
volatility · mapping uncertainty · closed market without historical framing.
Position sizing uses real lot sizes with the arithmetic displayed (user-configured
capital only). **Execution is disabled — analysis-only.**

---

## 12. Alerts, news, replay & backtesting

- **Alerts:** FMPI thresholds, momentum transitions, movement-state events, zone
  machine events, scenario confirmations, feed health; dedupe by key with per-rule
  cooldowns (unchanged conditions never re-fire); persisted to Postgres.
- **News:** Google News RSS (server-side cached 5 min, dedup by normalized headline,
  conservative instrument linking, keyword impact heuristic labelled *unverified*,
  source/timestamp always shown; unreachable source → explicit empty state, zero
  fabricated headlines).
- **Backtest** (documented): 5m breakout/breakdown of first-cross PDH/PDL/OR/swing
  levels with relVol ≥ 1.3, body ≥ 0.5, FMPI-lite ≥ 55; next-bar-open fills,
  conservative stop-first intrabar resolution, configurable costs/slippage,
  15:20 forced exits, EOD/STOP/TARGET reasons, regime split, **chronological 60/40
  in-sample/out-of-sample**, no engine-side tuning. Metrics: setups, win rate,
  expectancy, profit factor, max drawdown, avg R, exit histogram, false-break count.
  All results state that offline sessions validate the **logic**, not real-world
  performance, and that history never guarantees future results.

---

## 13. Automated tests — actual results

`npx vitest run` → **27 passed / 27** (deterministic; no live credentials needed).
Coverage: indicators (EMA/RSI/ATR/BB/VWAP/relVol), candle construction & aggregation
(volume conservation), weekend handling, swing/BOS/CHOCH structure, zone build +
sweep semantics, volume-profile invariants (POC∈[VAL,VAH], volume conservation),
movement classifier (insufficient-data, bullish staircase), FMPI (bounds,
reproducibility, trend>chop, insufficient-data suppression, order-flow unavailability),
scanner ranking bounds, scenario suppression gates, position sizing with lot sizes,
alert cooldown logic, backtest determinism + metric integrity.

**Not covered (documented):** live Upstox authentication, real-time quote streaming and
option-chain payloads — no live credentials exist in this environment; those code paths
are isolated behind `upstoxConfigured()` and are marked `unverified in sandbox`.

---

## 14. Known limitations & unsupported data

1. Upstox protobuf WebSocket tick stream → replaced by controlled quote polling + SSE.
2. Live instrument master is large; discovery is cached 6h (restart-safe).
3. Offline mode cannot provide: real depth, executed order flow, aggressor delta,
   true footprint, futures OI, option Greeks — all shown as capability cards instead.
4. ΔOI requires previous-OI references from the feed; absent values are excluded from
   any computation rather than estimated.
5. News impact labels are keyword heuristics (marked unverified); event time vs
   publication time is distinguished but not always known.
6. Index instruments have no order book; futures mapping must be verified once against
   live contract keys when a token is configured.
7. Replay/backtest in offline mode uses synthetic sessions — logic validation only.
8. No live verification of live-only paths in this sandbox (no credentials) — see §13.

## 15. Security & reliability

- Secrets only via `process.env` server-side; `.env.example` contains placeholders.
- Optional `APP_API_KEY` guard for mutating routes (X-API-Key header).
- DB access wrapped in best-effort guards — analytics never crash on persistence
  failure; input validation on all route params; rate-friendly server caching
  (2.5–15s per bundle/snapshot/scan); candles cached per (symbol,date); alerts
  deduped; SSE cleans up on abort.
- Graceful degradation: feed failure → STALE/UNAVAILABLE quality + signal suppression
  (never silent stale substitution).

## 16. Troubleshooting

| Symptom | Fix |
|---|---|
| “database not reachable” notes | Check `DATABASE_URL`; run `npx drizzle-kit push`. |
| All badges warn OFFLINE | Expected without a token — set `UPSTOX_ACCESS_TOKEN` and restart. |
| News empty with “unavailable” | Outbound network blocked; source honesty card explains; retry later. |
| Depth/options panels unavailable | Live token required; index spot shows no book by design. |
| `INSUFFICIENT_DATA` states | Early in session/replay — wait for ≥30 completed candles of that TF. |
| Port already in use | `PORT=3001 npm run dev`. |

© PulseGrid — decision support, not investment advice.
