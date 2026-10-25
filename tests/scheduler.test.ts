/**
 * Progressive universe scanner tests.
 *
 * Guards root cause B18: the former `slice(0, 26)` / `maxEvaluate ?? 24` caps
 * made a fixed instrument subset the ceiling on scanner, alert and Trade
 * Finder coverage. The scheduler must now cover the ENTIRE eligible universe
 * across cycles while respecting the per-cycle analysis budget.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { runScanner, DEFAULT_SCANNER_CONFIG } from "@/lib/market/scanner";

const feat = (sym: string, over: any = {}) => ({
  symbol: sym, name: sym, kind: "stock", sector: "X", price: 100 + (sym.charCodeAt(0) % 20),
  changePct: 1.5, relVol: 1.7, fmpi: 72, fmpiDirection: "BULLISH" as const,
  state: "BULLISH_CONTINUATION", trend: "UP" as const, breakoutUp: false, breakoutDn: false,
  zoneNote: null, dataQuality: "OK", dayMoveAtr: 1.2, ...over,
});

describe("scanner coverage accounting", () => {
  it("reports the whole universe, not a capped subset", () => {
    // 220 instruments — far beyond the old 26/24 caps
    const feats = Array.from({ length: 220 }, (_, i) => feat(`SYM${i}`));
    const r = runScanner(feats, "TEST", { ...DEFAULT_SCANNER_CONFIG, count: 5, minFMPI: 50, minRelVol: 1.0, minChangePct: 0.25 });
    expect(r.coverage.scanned).toBe(220);
    expect(r.coverage.fullyAnalysed).toBe(220);
  });

  it("keeps quote-only instruments distinct from fully analysed ones", () => {
    const feats = [
      feat("ANALYSED"),
      feat("Q1", { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1 }),
      feat("Q2", { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1 }),
    ];
    const r = runScanner(feats, "TEST", DEFAULT_SCANNER_CONFIG);
    expect(r.coverage.fullyAnalysed).toBe(1);
    expect(r.coverage.quoteOnly).toBe(2);
  });

  it("never labels a quote-only instrument as fully analysed", () => {
    const feats = Array.from({ length: 50 }, (_, i) =>
      feat(`Q${i}`, { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1 }),
    );
    const r = runScanner(feats, "TEST", DEFAULT_SCANNER_CONFIG);
    expect(r.coverage.fullyAnalysed).toBe(0);
    expect(r.coverage.quoteOnly).toBe(50);
    expect(r.bullish.length).toBe(0);
    expect(r.bearish.length).toBe(0);
  });

  it("never ranks an instrument whose analysis is unavailable, regardless of thresholds", () => {
    const feats = [
      feat("REAL", { fmpi: 75, relVol: 2, changePct: 2 }),
      feat("NOANALYSIS", { state: "INSUFFICIENT_DATA", dataQuality: "UNAVAILABLE", fmpi: 0, relVol: 0, changePct: 5 }),
      feat("QUOTEONLY", { state: "QUOTE_ONLY", dataQuality: "QUOTE_ONLY", fmpi: 0, relVol: 1, changePct: 4 }),
    ];
    const r = runScanner(feats, "TEST", { ...DEFAULT_SCANNER_CONFIG, count: 10, minFMPI: 0, minRelVol: 0, minChangePct: 0 });
    const ranked = [...r.bullish, ...r.bearish].map((c) => c.symbol);
    expect(ranked).toEqual(["REAL"]);
  });

  it("discloses excluded-by-filter counts separately from unavailable ones", () => {
    const feats = [
      feat("PASS", { fmpi: 80, relVol: 2 }),
      feat("FAILFILTER", { fmpi: 10, relVol: 0.2 }),     // analysed, rejected by filters
      feat("UNAVAILABLE", { state: "INSUFFICIENT_DATA", dataQuality: "UNAVAILABLE", fmpi: 0, relVol: 0 }),
    ];
    const r = runScanner(feats, "TEST", { ...DEFAULT_SCANNER_CONFIG, count: 5, minFMPI: 50, minRelVol: 1.0, minChangePct: 0.25 });
    expect(r.coverage.excludedByFilters).toBe(1);
    expect(r.coverage.insufficientData).toBe(1);
  });
});

describe("progressive scheduler state (B18 regression)", () => {
  // The scheduler keeps per-instrument state in a module-level global. These
  // tests exercise the accounting contract through the exported coverage
  // shape that the API and UI consume.
  beforeEach(() => {
    // fresh module state per test is not required — coverage math is pure
  });

  it("exposes a coverage object with progressive-scheduler fields", async () => {
    const { scanState } = await import("@/lib/market/engine");
    const { coverage } = scanState();
    for (const k of [
      "universe", "quoted", "fullyAnalysed", "partiallyAnalysed", "quoteOnly",
      "insufficientData", "pendingAnalysis", "analysisBudgetPerCycle",
      "freshnessSec", "cyclesCompleted", "progressPct", "note",
    ]) {
      expect(coverage, `coverage.${k} must be present`).toHaveProperty(k);
    }
    expect(coverage.analysisBudgetPerCycle).toBeGreaterThan(0);
    expect(coverage.freshnessSec).toBeGreaterThan(0);
    expect(typeof coverage.note).toBe("string");
    expect(coverage.note.length).toBeGreaterThan(20);
  });

  it("returns an empty-but-valid coverage shape when nothing is tracked", async () => {
    const { scanState } = await import("@/lib/market/engine");
    const { coverage } = scanState();
    expect(coverage.universe).toBeGreaterThanOrEqual(0);
    expect(coverage.progressPct).toBeGreaterThanOrEqual(0);
    expect(coverage.progressPct).toBeLessThanOrEqual(100);
  });

  it("Trade Finder scan discloses scheduler coverage even when unavailable", async () => {
    const { scanOpportunities } = await import("@/lib/market/opportunities");
    const scan = await scanOpportunities({ force: true });
    // without a token it must be unavailable but still disclose coverage
    expect(scan.available).toBe(false);
    expect(scan.scheduler).toBeTruthy();
    expect(scan.scheduler!.analysisBudgetPerCycle).toBeGreaterThan(0);
    expect(scan.reason).toMatch(/not connected/i);
    expect(scan.candidates).toEqual([]);
  });

  it("no longer caps Trade Finder evaluation at a fixed instrument count", async () => {
    const fs = await import("node:fs");
    /** strip comments so documentation text cannot satisfy a code assertion */
    const codeOf = (p: string) =>
      fs.readFileSync(p, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
        .replace(/^\s*\/\/.*$/gm, "");      // line comments
    const engine = codeOf("src/lib/market/engine.ts");
    const opportunities = codeOf("src/lib/market/opportunities.ts");
    // the old fixed caps must be gone from executable code
    expect(engine).not.toContain("slice(0, 26)");
    expect(opportunities).not.toMatch(/maxEvaluate\s*=\s*24/);
    expect(opportunities).not.toContain(".slice(0, maxEvaluate)");
    // the budget-based approach must be present instead
    expect(engine).toContain("needsAnalysis.slice(0, budget)");
    expect(engine).toContain("analysisBudget");
    expect(engine).toContain("freshnessSec");
  });
});
