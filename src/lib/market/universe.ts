import type { Instrument } from "./types";

/**
 * Canonical instrument registry — LIVE-DATA-ONLY.
 *
 * Populated exclusively by discovery.ts from the official Upstox instrument
 * masters. Resolution is case-insensitive and alias-aware, but the stored
 * `instrumentKey` is always the verbatim key from the master.
 */

interface Registry {
  items: Instrument[];
  bySymbol: Map<string, Instrument>;
  byKey: Map<string, Instrument>;
  source: "UPSTOX_INSTRUMENT_MASTER" | "NONE";
  discoveredAt: number | null;
  error: string | null;
}

const g = globalThis as typeof globalThis & { __pulsegridRegistry?: Registry };
export const registry: Registry = (g.__pulsegridRegistry ??= {
  items: [],
  bySymbol: new Map(),
  byKey: new Map(),
  source: "NONE",
  discoveredAt: null,
  error: null,
});

/**
 * Common user-entered aliases → canonical master symbols. These only affect
 * LOOKUP; they never fabricate an instrument. If the canonical symbol is not
 * in the master, resolution still fails honestly.
 */
const ALIASES: Record<string, string> = {
  "NIFTY50": "NIFTY",
  "NIFTY 50": "NIFTY",
  "NIFTY-50": "NIFTY",
  "NSEI": "NIFTY",
  "BANK NIFTY": "BANKNIFTY",
  "NIFTYBANK": "BANKNIFTY",
  "NIFTY BANK": "BANKNIFTY",
  "BSESENSEX": "SENSEX",
  "BSE SENSEX": "SENSEX",
  "NIFTY FIN SERVICE": "FINNIFTY",
  "NIFTYFINSERVICE": "FINNIFTY",
  // widely used colloquial equity tickers
  "M&M": "M&M",
  "MM": "M&M",
  "L&T": "LT",
  "LT": "LT",
  "HDFC BANK": "HDFCBANK",
  "ICICI BANK": "ICICIBANK",
  "SBI": "SBIN",
  "STATE BANK": "SBIN",
  "INFOSYS": "INFY",
  "TATA MOTORS": "TATAMOTORS",
  "TATAMOTOR": "TATAMOTORS",
  "RELIANCE INDUSTRIES": "RELIANCE",
  "BAJAJ FINANCE": "BAJFINANCE",
  "KOTAK BANK": "KOTAKBANK",
  "KOTAK": "KOTAKBANK",
};

function norm(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, " ");
}

export function setUniverse(items: Instrument[], source: Registry["source"], error: string | null = null): void {
  registry.items = items;
  registry.bySymbol = new Map(items.map((i) => [i.symbol.toUpperCase(), i]));
  registry.byKey = new Map(items.map((i) => [i.instrumentKey, i]));
  registry.source = source;
  registry.discoveredAt = items.length ? Date.now() : null;
  registry.error = error;
}

export function currentUniverse(): Instrument[] {
  return registry.items;
}

export function foUniverse(): Instrument[] {
  return registry.items.filter((i) => i.foEligible);
}

/** Case-insensitive, alias-aware, punctuation-tolerant resolution. */
export function getInstrument(symbol: string): Instrument | null {
  if (!symbol) return null;
  const raw = norm(symbol);
  const direct = registry.bySymbol.get(raw);
  if (direct) return direct;
  const alias = ALIASES[raw];
  if (alias) {
    const viaAlias = registry.bySymbol.get(alias.toUpperCase());
    if (viaAlias) return viaAlias;
  }
  // tolerate punctuation/space differences, e.g. "M & M" -> "M&M"
  const squashed = raw.replace(/[^A-Z0-9&]/g, "");
  for (const [sym, inst] of registry.bySymbol) {
    if (sym.replace(/[^A-Z0-9&]/g, "") === squashed) return inst;
  }
  // allow lookup by full instrument key
  return registry.byKey.get(symbol) ?? null;
}

export function getByKey(instrumentKey: string): Instrument | null {
  return registry.byKey.get(instrumentKey) ?? null;
}

export interface SearchOpts {
  limit?: number;
  foOnly?: boolean;
}

export function searchUniverse(q: string, opts: SearchOpts = {}): Instrument[] {
  const limit = opts.limit ?? 25;
  const pool = opts.foOnly ? foUniverse() : registry.items;
  const query = norm(q);
  if (!query) {
    // default view: indices first, then the most relevant F&O names
    return pool.slice(0, limit);
  }
  const aliased = ALIASES[query];
  const scored = pool
    .map((i) => {
      const sym = i.symbol.toUpperCase();
      const name = i.name.toUpperCase();
      let score = 0;
      if (sym === query || (aliased && sym === aliased.toUpperCase())) score = 1000;
      else if (sym.startsWith(query)) score = 600 - sym.length;
      else if (sym.includes(query)) score = 400 - sym.length;
      else if (name.startsWith(query)) score = 300;
      else if (name.includes(query)) score = 200;
      if (score > 0) {
        if (i.kind === "index") score += 120;   // indices surface first
        if (i.foEligible) score += 60;          // then F&O names
      }
      return { i, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.i);
}

/** "Did you mean …" suggestions when a symbol cannot be resolved. */
export function suggestSymbols(symbol: string, limit = 5): string[] {
  const q = norm(symbol).replace(/[^A-Z0-9&]/g, "");
  if (!q || !registry.items.length) return [];
  const scored = registry.items.map((i) => {
    const s = i.symbol.toUpperCase();
    let score = 0;
    if (s.startsWith(q.slice(0, 4))) score += 50;
    if (s.includes(q.slice(0, 5))) score += 40;
    if (q.includes(s.slice(0, 4))) score += 25;
    const common = [...new Set(q)].filter((ch) => s.includes(ch)).length;
    score += common * 2;
    return { s, score };
  });
  return scored.filter((x) => x.score >= 40).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.s);
}
