/**
 * Configuration — 5-10-20 EMA Scalping Strategy
 * EURUSD M5 — IC Markets cTrader
 */

import "dotenv/config";

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

  // ─── Session Hours (8am-12pm EST is approx 13:00-17:00 UTC) ─────────────
  sessionStartUTC: 12,
  sessionEndUTC:   16,

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
  },

  backtest: {
    spreadPips: 0.2,
    slippagePips: 0.3,
    commissionPerSideUSD: 3.00,
    initialBalance: 385, // ~$50,000 KES
  }
};
