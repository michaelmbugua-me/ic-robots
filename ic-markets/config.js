/**
 * Configuration — IC Markets cTrader Edition (Balanced Scalper)
 */

import "dotenv/config";

export const config = {
  aiProvider: process.env.AI_PROVIDER || "ollama",
  aiMode: process.env.AI_MODE || "OFF",

  ollama: {
    baseUrl:    process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model:      process.env.OLLAMA_MODEL    || "llama3.2:3b",
    timeout:    45000,
  },

  ctraderEnv: "demo",
  ctraderSymbolIds: {
    "EUR_USD": 1,
    "GBP_USD": 2,
  },

  defaultInstrument:   "EUR_USD",
  tradingPairs: (process.env.TRADING_PAIRS || "EUR_USD").split(",").map(s => s.trim()),

  granularity:         "M5",
  pollIntervalSeconds: 5,

  sessionStartUTC: 8,
  sessionEndUTC:   18,

  risk: {
    accountCapitalKES:    50_000,
    dailyStopLossKES:     1_000,
    dailyProfitTargetKES: 1_000,
    maxLeverage:          100,
    maxOpenTrades:        2, 
    minRiskReward:        1.5,   
    usdKesRate:           129.0, 
  },

  riskPercentPerTrade: 1.0,
  lossCooldownMinutes: 15,
  maxSpreadPips: 1.5,
  minAtrPips: 0.7, // Balanced volatility floor
  maxSlippagePips: 2,

  useBreakeven: true,
  breakevenTriggerATR: 1.5, // Standard trigger to allow trade room to breathe
  useTrailingStop: true,
  trailingStopATR: 1.0, 

  maxConcurrentTrades: 2, 
  maxTotalTrades: 2, 
  minTradeDistancePips: 4, // Balanced distance
  minStopDistancePips: 2,
  atrMultiplierFloor: 0.3,

  strategy: {
    atrMultiplierSL: 2.5, // Standard SL for win rate protection
    atrMultiplierTP: 4.5, // Larger TP to improve Profit Factor
    rsiThresholdLow:  30, // Reverted to strict oversold
    rsiThresholdHigh: 70, // Reverted to strict overbought
    emaFast: 8,
    emaSlow: 21,
    minAdx: 16, // Middle ground between 15 and 18
    minVolumeRatio: 1.0, // Reverted to 1.0 (Quality filter)
    minConfirmations: 1,
    ema200Period: 200,
    atrAveragePeriod: 20,   
    usePriceActionTrigger: false, 
    srLookbackPeriods: 50,   
    minSentimentConfidence: 75, 
  },

  pairOverrides: {
    "EUR_USD": {
      strategyMode: "pullback",
      minAdx: 16,
      minVolumeRatio: 1.0,
    },
  },

  backtest: {
    spreadPips: 0.1,
    slippagePips: 0.2,
    commissionPerSideUSD: 3.00,
    initialBalance: 500,
  },
  connectionTimeoutSeconds: 10
};
