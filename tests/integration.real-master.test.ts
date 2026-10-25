/**
 * OPTIONAL INTEGRATION TEST — runs the REAL discovery code against the LIVE
 * Upstox instrument master (network required).
 *
 * Skips automatically when the master cannot be downloaded (offline CI), so
 * the deterministic suite never depends on network access.
 *
 * This is the closest verification to production available without a valid
 * Upstox access token: it proves the registry parsing/resolution logic works
 * against genuine provider data.
 */
import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { parseMasterRows } from "@/lib/market/discovery";
import { getInstrument, foUniverse, setUniverse } from "@/lib/market/universe";
import type { Instrument } from "@/lib/market/types";

const MASTER = "/tmp/upstox-nse-master.json";
const BSE_MASTER = "/tmp/upstox-bse-master.json";

/**
 * Download the gzipped official master and decompress it with zcat.
 * (gunzip refuses files without a .gz suffix, so we stage to .gz first.)
 */
function ensureMaster(path: string, exchange: string): any[] | null {
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf8")); } catch { /* refetch */ }
  }
  const gz = `${path}.gz`;
  try {
    execSync(
      `curl -sL --max-time 120 -o "${gz}" "https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz" && zcat "${gz}" > "${path}"`,
      { stdio: "ignore" },
    );
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed) || !parsed.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

const nse = ensureMaster(MASTER, "NSE");
const bse = ensureMaster(BSE_MASTER, "BSE");

const d = nse ? describe.skipIf(!nse) : describe.skip;

d("real Upstox instrument master (integration)", () => {
  let items: Instrument[] = [];

  it("parses the live master into a usable registry", () => {
    items = parseMasterRows([...nse!, ...(bse ?? [])]);
    expect(items.length).toBeGreaterThan(1000);
    setUniverse(items, "UPSTOX_INSTRUMENT_MASTER");
    console.log(
      `[real-master] registry=${items.length} stocks=${items.filter((i) => i.kind === "stock").length}` +
      ` f&o=${foUniverse().length} indices=${items.filter((i) => i.kind === "index").length}`,
    );
  });

  it("resolves the reported stock symbols to genuine, distinct instruments", () => {
    const wanted = ["TCS", "RELIANCE", "HDFCBANK", "INFY", "SBIN", "BAJFINANCE", "KOTAKBANK"];
    const keys = new Set<string>();
    for (const s of wanted) {
      const i = getInstrument(s);
      expect(i, `${s} must resolve from the live master`).toBeTruthy();
      expect(i!.instrumentKey).toMatch(/^NSE_EQ\|INE/);
      keys.add(i!.instrumentKey);
    }
    expect(keys.size).toBe(wanted.length); // no cross-contamination
  });

  it("maps a current futures contract for F&O-eligible underlyings", () => {
    const tcs = getInstrument("TCS")!;
    if (!tcs.foEligible) return; // genuinely not F&O eligible right now
    expect(tcs.futuresKey).toMatch(/^NSE_FO\|\d+$/);
    expect(tcs.futuresExpiry!).toBeGreaterThan(Date.now());
    expect(tcs.lotSize).toBeGreaterThan(0);
    expect(tcs.tickSize).toBeLessThan(1); // paise converted to rupees
  });

  it("resolves Nifty, Bank Nifty and Sensex from their own masters", () => {
    expect(getInstrument("NIFTY")!.instrumentKey).toBe("NSE_INDEX|Nifty 50");
    expect(getInstrument("BANKNIFTY")!.instrumentKey).toBe("NSE_INDEX|Nifty Bank");
    if (bse) expect(getInstrument("SENSEX")!.instrumentKey).toBe("BSE_INDEX|SENSEX");
  });

  it("supports cash-only scrips without F&O eligibility", () => {
    const cashOnly = items.filter((i) => i.kind === "stock" && !i.foEligible);
    expect(cashOnly.length).toBeGreaterThan(500);
    expect(foUniverse().every((i) => i.foEligible)).toBe(true);
  });

  it("never constructs an instrument key from a symbol string", () => {
    for (const i of items.slice(0, 3000)) {
      expect(i.instrumentKey).toMatch(/^(NSE|BSE)_(EQ|FO|INDEX)\|/);
      expect(i.instrumentKey).not.toBe(i.symbol);
    }
  });
});

afterAll(() => {
  for (const p of [MASTER, BSE_MASTER, `${MASTER}.gz`, `${BSE_MASTER}.gz`]) {
    try { rmSync(p, { force: true }); } catch { /* best-effort cleanup */ }
  }
});
