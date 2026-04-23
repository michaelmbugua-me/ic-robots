/**
 * Configuration — 5-10-20 EMA Scalping Strategy
 * EURUSD M5 — IC Markets cTrader
 */

import "dotenv/config";

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const sessionWindowPresetsUTC = {
  ny_only: [
    { name: "ny_overlap", start: 12.5, end: 16.0 },
  ],
  ny_quality: [
    { name: "ny_overlap", start: 12.5, end: 16.0 },
  ],
  ny_trimmed: [
    { name: "ny_overlap", start: 12.75, end: 15.75 },
  ],
  all_windows: [
    { name: "london_open", start: 7.0, end: 10.0 },
    { name: "ny_overlap", start: 12.5, end: 16.0 },
  ],
};

const sessionWindowMode = process.env.SESSION_WINDOW_MODE || "ny_only";
const selectedSessionWindowsUTC = sessionWindowPresetsUTC[sessionWindowMode] || sessionWindowPresetsUTC.ny_only;

export const config = {
  // ─── AI Settings (Optional for this strategy) ───────────────────────
  aiProvider: process.env.AI_PROVIDER || "ollama",
  aiMode:     process.env.AI_MODE || "OFF",

  // ─── cTrader Credentials ─────────────────────────────────────────────
  ctraderClientId:     process.env.CTRADER_CLIENT_ID     || "",
  ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET || "",
  ctraderAccessToken:  process.env.CTRADER_ACCESS_TOKEN  || "",
  ctraderAccountId:    Number(process.env.CTRADER_ACCOUNT_ID) || 0,
  ctraderEnv:          "demo", 

  ctraderSymbolIds: { "EUR_USD": 1 },

  // ─── Strategy Scope ─────────────────────────────────────────────────────────
  defaultInstrument:   "EUR_USD",
  tradingPairs:        ["EUR_USD"],
  granularity:         "M5",
  pollIntervalSeconds: 10,

  // ─── Session Hours (EURUSD M5 windows, UTC) ──────────────────────────────
  // A/B switch: SESSION_WINDOW_MODE=ny_only|ny_quality|ny_trimmed|all_windows
  sessionWindowMode,
  sessionWindowsPresetUTC: sessionWindowPresetsUTC,
  sessionWindowsUTC: selectedSessionWindowsUTC,

  // Backward-compatible fallback window for older scripts
  sessionStartUTC: 12.5,
  sessionEndUTC:   16.0,

  // ─── Financial Plan & Risk Management ──────────────────────────────────
  risk: {
    accountCapitalKES:    50_000,
    dailyStopLossKES:     1_000, // 2% Total cap
    dailyProfitTargetKES: 500,   // 1% Goal
    maxLeverage:          100,
    usdKesRate:           129.0,
    riskPerTradeKES:      1_000, // 2% Risk per trade
    minRiskReward:        1.5,
  },

  // ─── Trade Limits ───────────────────────────────────────────────────────
  maxTotalTrades:      1, // Focus on one quality trade at a time
  maxTradesPerPair:    1,
  minTradeDistancePips: 10,

  // ─── Safety & Indicators ───────────────────────────────────────────────
  maxSpreadPips: 1.2,
  minStopDistancePips: 5,
  
  strategy: {
    // 5-10-20 EMA Scalping
    pipBuffer: 0.00005,  // 0.5-pip buffer beyond trigger candle edge for SL
    rrRatio:   1.5,      // Reward-to-risk ratio for TP calculation
    minRiskPips: envNumber("MIN_RISK_PIPS", 2),
    maxRiskPips: envNumber("MAX_RISK_PIPS", 15),
    cooldownCandlesAfterLoss: envNumber("COOLDOWN_CANDLES_AFTER_LOSS", 1),
    emaSeparationMinPips: envNumber("EMA_SEPARATION_MIN_PIPS", 0),
  },

  backtest: {
    spreadPips: 0.2,
    slippagePips: 0.3,
    commissionPerSideUSD: 3.00,
    initialBalance: 385, // ~$50,000 KES
  }
};
