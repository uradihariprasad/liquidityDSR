import {
  pgTable,
  serial,
  integer,
  text,
  doublePrecision,
  bigint,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Persistent storage for the intelligence platform.
 * Market candles themselves are NOT stored here — they are fetched live from
 * Upstox on demand. This schema stores configuration, watchlists, alerts,
 * signal events, trade-scenario lifecycle, scanner snapshots and backtest runs.
 */

export const watchlists = pgTable("watchlist", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const watchlistItems = pgTable(
  "watchlist_item",
  {
    id: serial("id").primaryKey(),
    watchlistId: integer("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull().default("stock"), // index | stock | future
    instrumentKey: text("instrument_key").notNull().default(""),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("watchlist_item_uniq").on(t.watchlistId, t.symbol)],
);

export const alertRules = pgTable("alert_rule", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // fmpi_cross | state_change | zone_event | scenario | depth_imbalance | feed
  symbol: text("symbol").notNull().default("*"), // * = all
  params: jsonb("params").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  cooldownSec: integer("cooldown_sec").notNull().default(900),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertEvents = pgTable(
  "alert_event",
  {
    id: serial("id").primaryKey(),
    ts: bigint("ts", { mode: "number" }).notNull(), // epoch ms of the triggering condition
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    severity: text("severity").notNull().default("info"), // info | warning | critical
    message: text("message").notNull(),
    price: doublePrecision("price"),
    detail: jsonb("detail").notNull().default({}),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("alert_event_ts_idx").on(t.ts), index("alert_event_symbol_idx").on(t.symbol)],
);

export const signalEvents = pgTable(
  "signal_event",
  {
    id: serial("id").primaryKey(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    symbol: text("symbol").notNull(),
    tf: text("tf").notNull(),
    kind: text("kind").notNull(), // movement_state | zone_event | scenario_event | sweep | breakout
    state: text("state").notNull(),
    price: doublePrecision("price"),
    detail: jsonb("detail").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signal_event_ts_idx").on(t.ts)],
);

export const tradeScenarios = pgTable(
  "trade_scenario",
  {
    id: serial("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ts: bigint("ts", { mode: "number" }).notNull(),
    symbol: text("symbol").notNull(),
    tf: text("tf").notNull(),
    direction: text("direction").notNull(), // long | short
    setup: text("setup").notNull(),
    status: text("status").notNull(), // developing | waiting_confirmation | entry_condition_met | invalidated | target_reached | stop_reached | expired | no_trade
    entry: doublePrecision("entry"),
    stop: doublePrecision("stop"),
    t1: doublePrecision("t1"),
    t2: doublePrecision("t2"),
    rr: doublePrecision("rr"),
    fmpi: doublePrecision("fmpi"),
    evidence: jsonb("evidence").notNull().default({}),
  },
  (t) => [index("trade_scenario_symbol_idx").on(t.symbol, t.tf)],
);

export const backtestRuns = pgTable("backtest_run", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  params: jsonb("params").notNull(),
  metrics: jsonb("metrics").notNull(),
  note: text("note").notNull().default(""),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
