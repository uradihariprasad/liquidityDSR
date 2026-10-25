/**
 * Runtime configuration (scanner filters, risk limits, alert thresholds).
 * Defaults are documented; the settings API persists overrides to Postgres
 * and applies them here so behaviour changes take effect immediately.
 */

export interface RuntimeConfig {
  scanner: {
    count: number;
    minFMPI: number;
    minRelVol: number;
    minChangePct: number;
    /** how many instruments receive full analysis per scan cycle (rate-limit aware) */
    analysisBudget: number;
    /** how long a stored full analysis is considered fresh, in seconds */
    freshnessSec: number;
  };
  risk: { minRR: number; minFMPI: number; maxActiveScenarios: number; riskPerTradePct: number; dailyLossLimitPct: number; cooldownAfterLosses: number };
  alerts: { fmpiHigh: number; fmpiLow: number; cooldownSec: number };
}

let config: RuntimeConfig = {
  scanner: { count: 5, minFMPI: 45, minRelVol: 1.0, minChangePct: 0.25, analysisBudget: 30, freshnessSec: 300 },
  risk: { minRR: 1.5, minFMPI: 55, maxActiveScenarios: 4, riskPerTradePct: 0.5, dailyLossLimitPct: 2, cooldownAfterLosses: 3 },
  alerts: { fmpiHigh: 70, fmpiLow: 30, cooldownSec: 900 },
};

export function getRuntimeConfig(): RuntimeConfig {
  return config;
}

export function applyRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
  config = {
    scanner: { ...config.scanner, ...(patch.scanner ?? {}) },
    risk: { ...config.risk, ...(patch.risk ?? {}) },
    alerts: { ...config.alerts, ...(patch.alerts ?? {}) },
  };
  return config;
}
