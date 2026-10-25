/**
 * News & Event Intelligence.
 *
 * Source: Google News public RSS search feeds (legitimate, rate-limit
 * friendly, no key required). No headlines are ever fabricated — if the
 * source cannot be reached, the module reports status UNAVAILABLE with the
 * underlying error, and the UI shows an explicit empty state.
 *
 * Impact classification is a documented keyword heuristic over the headline
 * + summary. It is the system's INTERPRETATION of possible relevance, not a
 * verified market-impact fact; verified=false means "unverified heuristic".
 */

import type { NewsItem } from "./types";
import { hashString } from "./prng";
import { currentUniverse } from "./universe";

export interface NewsFeedResult {
  status: "OK" | "UNAVAILABLE";
  source: string;
  fetchedAt: number;
  query: string;
  items: NewsItem[];
  error: string | null;
  freshnessNote: string;
}

const BULLISH = ["surge", "beat", "beats", "upgrade", "record", "profit jumps", "profit rises", "order win", "wins order", "raises", "buyback", "expansion", "growth", "rally", "soars", "jumps", "climbs", "outperform", "dividend", "all-time high", "approval", "partnership", "acquisition", "stake buy", "rate cut", "inflow", "strong q", "robust"];
const BEARISH = ["falls", "fell", "miss", "misses", "downgrade", "fraud", "penalty", "fine", "fined", "loss", "decline", "plunges", "drops", "slumps", "tumbles", "crash", "downgrade", "probe", "investigation", "sebi", "default", "downgrade", "weak q", "profit falls", "warning", "recall", "ban", "sell-off", "selloff", "outflow", "rate hike", "layoff", "resigns", "resignation"];
const HIGH_IMPACT = ["rbi", "reserve bank", "fed", "fomc", "inflation", "cpi", "gdp", "budget", "policy", "repo", "earnings", "results", "q1", "q2", "q3", "q4", "merger", "acquisition", "default", "war", "sanction", "election", "downgrade", "crash", "ban", "insolvency", "block deal"];

function classify(text: string): { tone: NewsItem["tone"]; impact: NewsItem["impact"]; reason: string } {
  const t = text.toLowerCase();
  const bullHits = BULLISH.filter((k) => t.includes(k));
  const bearHits = BEARISH.filter((k) => t.includes(k));
  const highHits = HIGH_IMPACT.filter((k) => t.includes(k));
  let tone: NewsItem["tone"] = "NEUTRAL";
  if (bullHits.length > bearHits.length) tone = "BULLISH";
  else if (bearHits.length > bullHits.length) tone = "BEARISH";
  else if (bullHits.length === 0 && bearHits.length === 0) tone = "UNCERTAIN";
  const impact: NewsItem["impact"] = highHits.length >= 1 ? "HIGH" : bullHits.length + bearHits.length >= 2 ? "MEDIUM" : "LOW";
  const reason =
    tone === "UNCERTAIN"
      ? "No directional keywords matched — impact uncertain."
      : `Keyword heuristic: ${[...bullHits.slice(0, 3).map((k) => `+${k}`), ...bearHits.slice(0, 3).map((k) => `−${k}`)].join(" ")}${highHits.length ? ` | high-impact terms: ${highHits.slice(0, 3).join(", ")}` : ""}`;
  return { tone, impact, reason };
}

function relateTo(text: string): string | null {
  const t = text.toLowerCase();
  for (const inst of currentUniverse()) {
    const name = inst.name.toLowerCase();
    const sym = inst.symbol.toLowerCase();
    if (name.length > 4 && t.includes(name)) return inst.symbol;
    // conservative symbol matching to avoid false positives
    if (sym.length >= 5 && t.includes(sym)) return inst.symbol;
  }
  if (t.includes("nifty")) return "NIFTY";
  if (t.includes("sensex")) return "SENSEX";
  return null;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const cache = new Map<string, { at: number; result: NewsFeedResult }>();

export async function fetchNews(query: string, limit = 30): Promise<NewsFeedResult> {
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.result;

  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "MarketIntelPlatform/1.0 (+news-intelligence)" },
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 0 },
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const xml = await res.text();
    const rawItems = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 60);
    const seen = new Set<string>();
    const items: NewsItem[] = [];
    for (const m of rawItems) {
      const it = m[1];
      const title = decodeXml(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      const link = it.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
      const pub = Date.parse(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "") || Date.now();
      const source = decodeXml(it.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "Google News");
      const desc = decodeXml(it.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? "");
      if (!title) continue;
      const norm = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      const cls = classify(`${title} ${desc}`);
      items.push({
        id: hashString(norm).toString(36),
        headline: title,
        source,
        link,
        publishedTs: pub,
        summary: desc.slice(0, 220) || title,
        related: relateTo(`${title} ${desc}`),
        tone: cls.tone,
        impact: cls.impact,
        impactReason: cls.reason,
        verified: false,
      });
      if (items.length >= limit) break;
    }
    items.sort((a, b) => b.publishedTs - a.publishedTs);
    const result: NewsFeedResult = {
      status: "OK",
      source: "GOOGLE_NEWS_RSS",
      fetchedAt: Date.now(),
      query,
      items,
      error: null,
      freshnessNote: "Publication timestamps are as reported by the source; deduplicated by normalized headline. Impact classification is a keyword heuristic — not verified market-impact analysis.",
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  } catch (err) {
    const result: NewsFeedResult = {
      status: "UNAVAILABLE",
      source: "GOOGLE_NEWS_RSS",
      fetchedAt: Date.now(),
      query,
      items: [],
      error: err instanceof Error ? err.message : String(err),
      freshnessNote: "News source unreachable from this environment. No headlines are fabricated; retry later or check outbound connectivity.",
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  }
}

export const DEFAULT_NEWS_QUERY = "indian stock market OR nifty OR sensex OR RBI OR NSE";
