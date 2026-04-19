/**
 * Configuration — IC Markets cTrader Edition (Balanced Scalper)
 * 
 * CLEANED & CONSOLIDATED
 */

import "dotenv/config";

export const config = {
  // ─── AI Provider ───────────────────────────────────────────────────────
  aiProvider: process.env.AI_PROVIDER || "ollama",
  aiMode: process.env.AI_MODE || "OFF",

  ollama: {
    baseUrl:    process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model:      process.env.OLLAMA_MODEL    || "llama3.2:3b",
    timeout:    45000,
  },

  // ─── cTrader Open API App Credentials ──────────────────────────────────
  ctraderClientId:     process.env.CTRADER_CLIENT_ID     || "",
  ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET || "",
  ctraderAccessToken:  process.env.CTRADER_ACCESS_TOKEN  || "",
  ctraderAccountId:    Number(process.env.CTRADER_ACCOUNT_ID) || 0,
  ctraderEnv:          "demo", // "demo" or "live"

  ctraderSymbolIds: {
    "EUR_USD": 1, "GBP_USD": 2, "USD_JPY": 3, "USD_CHF": 4, "AUD_USD": 5,
    "USD_CAD": 6, "NZD_USD": 7, "EUR_GBP": 8, "EUR_JPY": 9, "GBP_JPY": 10,
  },

  // ─── Trading Scope ─────────────────────────────────────────────────────
  defaultInstrument:   "EUR_USD",
  tradingPairs: (process.env.TRADING_PAIRS || "EUR_USD").split(",").map(s => s.trim()),
  granularity:         "M5",
  pollIntervalSeconds: 5,
  connectionTimeoutSeconds: 10,

  // ─── Session Hours (UTC) ────────────────────────────────────────────────
  sessionStartUTC: 8,
  sessionEndUTC:   18,

  // ─── Risk Management (KES Denominated) ──────────────────────────────────
  risk: {
    accountCapitalKES:    50_000,
    dailyStopLossKES:     1_000,
    dailyProfitTargetKES: 1_000,
    maxLeverage:          100,
    usdKesRate:           129.0,
    minRiskReward:        1.5,
  },

  // ─── Trade Limits ───────────────────────────────────────────────────────
  maxTotalTrades:      2, // Global cap (shared across all pairs)
  maxTradesPerPair:    2, // Local cap (per individual pair)
  minTradeDistancePips: 4, // Distance between overlapping entries
  riskPercentPerTrade: 1.0, // Used for backtesting and volume calc

  // ─── Safety & Circuit Breakers ──────────────────────────────────────────
  lossCooldownMinutes: 15,
  maxSpreadPips: 1.5,
  minAtrPips: 0.7, 
  maxSlippagePips: 0.2,
  minStopDistancePips: 2,
  atrMultiplierFloor: 0.3,

  // ─── Profit Protection ──────────────────────────────────────────────────
  useBreakeven: true,
  breakevenTriggerATR: 1.5, 
  useTrailingStop: true,
  trailingStopATR: 1.0, 

  // ─── Strategy Settings (Base Pullback) ──────────────────────────────────
  strategy: {
    atrMultiplierSL: 2.5, 
    atrMultiplierTP: 4.5, 
    rsiThresholdLow:  30, 
    rsiThresholdHigh: 70, 
    emaFast: 8,
    emaSlow: 21,
    minAdx: 16, 
    minVolumeRatio: 1.0,
    minConfirmations: 1,
    ema200Period: 200,
    atrAveragePeriod: 20,   
    usePriceActionTrigger: false, 
    srLookbackPeriods: 50,   
  },

  // ─── Pair-Specific Overrides ────────────────────────────────────────────
  pairOverrides: {
    "EUR_USD": {
      // Inherits base strategy (Balanced Scalper)
    },
    "EUR_GBP": {
      minAdx: 15,
      atrMultiplierSL: 2.0,
      atrMultiplierTP: 3.5,
    }
  },

  // ─── Backtest Specific ──────────────────────────────────────────────────
  backtest: {
    spreadPips: 0.1,
    slippagePips: 0.2,
    commissionPerSideUSD: 3.00,
    initialBalance: 500,
  }
};
