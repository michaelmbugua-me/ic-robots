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

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw.split(",").map(v => v.trim()).filter(Boolean);
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
  london_only: [
    { name: "london_open", start: 7.0, end: 10.0 },
  ],
  all_windows: [
    { name: "london_open", start: 7.0, end: 10.0 },
    { name: "ny_overlap", start: 12.5, end: 16.0 },
  ],
};

const sessionWindowMode = process.env.SESSION_WINDOW_MODE || "all_windows";
const selectedSessionWindowsUTC = sessionWindowPresetsUTC[sessionWindowMode] || sessionWindowPresetsUTC.ny_only;

export const config = {

  // ─── cTrader Credentials ─────────────────────────────────────────────
  ctraderClientId:     process.env.CTRADER_CLIENT_ID     || "",
  ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET || "",
  ctraderAccessToken:  process.env.CTRADER_ACCESS_TOKEN  || "",
  ctraderAccountId:    Number(process.env.CTRADER_ACCOUNT_ID) || 0,
  ctraderEnv:          process.env.CTRADER_ENV || "demo",

  ctraderSymbolIds: {
    "EUR_USD": 1,
    "AUD_USD": 5,
    "GBP_USD": 2,
    "USD_CAD": 8,
    "USD_CHF": 6,
    "USD_JPY": 4,
    "EUR_GBP": 9,
    "EUR_JPY": 3,
    "GBP_JPY": 7,
    "NZD_USD": 12,
  },

  // ─── Strategy Scope ─────────────────────────────────────────────────────────
  defaultInstrument:   "EUR_USD",
  tradingPairs:        envList("TRADING_PAIRS", ["EUR_USD"]),
  granularity:         "M5",
  higherTimeframe:     "H1",
  pollIntervalSeconds: 10,
  connectionTimeoutSeconds: 60,

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
    riskPerTradePercent:  envNumber("RISK_PER_TRADE_PERCENT", 0.5),
    enforceDailyStopLoss: envBool("ENFORCE_DAILY_STOP_LOSS", true),
    dailyStopLossKES:     envNumber("DAILY_STOP_LOSS_KES", 300),
    dailyProfitTargetKES: envNumber("DAILY_PROFIT_TARGET_KES", 300),
    maxLeverage:          100,
    usdKesRate:           129.0,
  },

  // ─── Trade Limits ───────────────────────────────────────────────────────
  maxTotalTrades:   1, // Focus on one quality trade at a time
  maxTradesPerPair: 1,
  maxPositionSizeUnits: 100_000,

  strategy: {
    mode: process.env.STRATEGY_MODE || "ny_asian_continuation",

    // 5-10-20 EMA Scalping
    pipBuffer: 0.00005,  // 0.5-pip buffer beyond trigger candle edge for SL
    rrRatio:   1.5,      // Reward-to-risk ratio for TP calculation
    minRiskPips: envNumber("MIN_RISK_PIPS", 2),
    maxRiskPips: envNumber("MAX_RISK_PIPS", 15),
    cooldownCandlesAfterLoss: envNumber("COOLDOWN_CANDLES_AFTER_LOSS", 1),
    emaSeparationMinPips: envNumber("EMA_SEPARATION_MIN_PIPS", 0),
    higherTimeframeTrend: {
      enabled: true,
      granularity: "H1",
      emaPeriod: 200,
      lookbackCandles: 250,
      requireSlope: true,
    },
    smashSell: {
      enabled: true,
      trendLookbackBars: envNumber("SMASH_TREND_LOOKBACK_BARS", 30),
      atrPeriod: envNumber("SMASH_ATR_PERIOD", 20),
      atrStopMultiplier: envNumber("SMASH_ATR_STOP_MULTIPLIER", 2.0),
      minSmashAtr: envNumber("SMASH_MIN_ATR", 1.4),
      maxSmashAtr: envNumber("SMASH_MAX_ATR", 2.0),
      entryBufferPips: envNumber("SMASH_ENTRY_BUFFER_PIPS", 1.0),
      stopBufferPips: envNumber("SMASH_STOP_BUFFER_PIPS", 1.0),
      minRiskPips: envNumber("SMASH_MIN_RISK_PIPS", 4),
      maxRiskPips: envNumber("SMASH_MAX_RISK_PIPS", 15),
      rrRatio: envNumber("SMASH_RR_RATIO", 1.5),
      pendingExpiryBars: envNumber("SMASH_PENDING_EXPIRY_BARS", 3),
      timeExitBars: envNumber("SMASH_TIME_EXIT_BARS", 10),
    },
    smashBuy: {
      enabled: true,
      trendLookbackBars: envNumber("SMASH_TREND_LOOKBACK_BARS", 30),
      atrPeriod: envNumber("SMASH_ATR_PERIOD", 20),
      atrStopMultiplier: envNumber("SMASH_ATR_STOP_MULTIPLIER", 2.0),
      minSmashAtr: envNumber("SMASH_MIN_ATR", 1.4),
      maxSmashAtr: envNumber("SMASH_MAX_ATR", 2.0),
      entryBufferPips: envNumber("SMASH_ENTRY_BUFFER_PIPS", 1.0),
      stopBufferPips: envNumber("SMASH_STOP_BUFFER_PIPS", 1.0),
      minRiskPips: envNumber("SMASH_MIN_RISK_PIPS", 4),
      maxRiskPips: envNumber("SMASH_MAX_RISK_PIPS", 15),
      rrRatio: envNumber("SMASH_RR_RATIO", 1.5),
      pendingExpiryBars: envNumber("SMASH_PENDING_EXPIRY_BARS", 3),
      timeExitBars: envNumber("SMASH_TIME_EXIT_BARS", 10),
    },
    sessionSweep: {
      enabled: true,
      allowedSessionNames: envList("SWEEP_ALLOWED_SESSIONS", ["ny_overlap"]),
      allowedDirections: envList("SWEEP_ALLOWED_DIRECTIONS", ["SELL"]),
      atrPeriod: envNumber("SWEEP_ATR_PERIOD", 20),
      minAtrPips: envNumber("SWEEP_MIN_ATR_PIPS", 2.5),
      maxAtrPips: envNumber("SWEEP_MAX_ATR_PIPS", 8.0),
      minCandleAtr: envNumber("SWEEP_MIN_CANDLE_ATR", 1.0),
      maxCandleAtr: envNumber("SWEEP_MAX_CANDLE_ATR", 2.5),
      minSweepPips: envNumber("SWEEP_MIN_SWEEP_PIPS", 2.0),
      entryBufferPips: envNumber("SWEEP_ENTRY_BUFFER_PIPS", 0.5),
      stopBufferPips: envNumber("SWEEP_STOP_BUFFER_PIPS", 0.5),
      minWickRatio: envNumber("SWEEP_MIN_WICK_RATIO", 0.6),
      minRiskPips: envNumber("SWEEP_MIN_RISK_PIPS", 4),
      maxRiskPips: envNumber("SWEEP_MAX_RISK_PIPS", 15),
      rrRatio: envNumber("SWEEP_RR_RATIO", 1.0),
      pendingExpiryBars: envNumber("SWEEP_PENDING_EXPIRY_BARS", 2),
      timeExitBars: envNumber("SWEEP_TIME_EXIT_BARS", 10),
      maxTradesPerSession: envNumber("SWEEP_MAX_TRADES_PER_SESSION", 1),
      noNewTradeMinutesBeforeSessionEnd: envNumber("SWEEP_NO_NEW_TRADE_MINUTES_BEFORE_SESSION_END", 15),
      useAsianLevels: envBool("SWEEP_USE_ASIAN_LEVELS", true),
      usePreviousDayLevels: envBool("SWEEP_USE_PREVIOUS_DAY_LEVELS", false),
    },
    nyOrb: {
      enabled: true,
      allowedSessionNames: envList("ORB_ALLOWED_SESSIONS", ["ny_overlap"]),
      allowedDirections: envList("ORB_ALLOWED_DIRECTIONS", ["BUY", "SELL"]),
      openingRangeStartUTC: envNumber("ORB_RANGE_START_UTC", 12.5),
      openingRangeEndUTC: envNumber("ORB_RANGE_END_UTC", 13.0),
      noNewTradeAfterUTC: envNumber("ORB_NO_NEW_TRADE_AFTER_UTC", 15.5),
      atrPeriod: envNumber("ORB_ATR_PERIOD", 20),
      minAtrPips: envNumber("ORB_MIN_ATR_PIPS", 2.5),
      maxAtrPips: envNumber("ORB_MAX_ATR_PIPS", 8.0),
      minOpeningRangePips: envNumber("ORB_MIN_RANGE_PIPS", 3.0),
      maxOpeningRangePips: envNumber("ORB_MAX_RANGE_PIPS", 18.0),
      minBreakoutClosePips: envNumber("ORB_MIN_BREAKOUT_CLOSE_PIPS", 0.5),
      minBodyRatio: envNumber("ORB_MIN_BODY_RATIO", 0.55),
      minCloseLocation: envNumber("ORB_MIN_CLOSE_LOCATION", 0.65),
      entryBufferPips: envNumber("ORB_ENTRY_BUFFER_PIPS", 0.5),
      stopBufferPips: envNumber("ORB_STOP_BUFFER_PIPS", 0.5),
      minRiskPips: envNumber("ORB_MIN_RISK_PIPS", 4),
      maxRiskPips: envNumber("ORB_MAX_RISK_PIPS", 15),
      rrRatio: envNumber("ORB_RR_RATIO", 1.2),
      pendingExpiryBars: envNumber("ORB_PENDING_EXPIRY_BARS", 2),
      timeExitBars: envNumber("ORB_TIME_EXIT_BARS", 10),
      maxTradesPerSession: envNumber("ORB_MAX_TRADES_PER_SESSION", 1),
    },
    nyAsianContinuation: {
      enabled: true,
      allowedSessionNames: envList("NY_ASIAN_ALLOWED_SESSIONS", ["ny_overlap"]),
      asianStartUTC: envNumber("NY_ASIAN_START_UTC", 0),
      asianEndUTC: envNumber("NY_ASIAN_END_UTC", 7),
      tradeStartUTC: envNumber("NY_ASIAN_TRADE_START_UTC", 12.5),
      tradeEndUTC: envNumber("NY_ASIAN_TRADE_END_UTC", 15.5),
      preferAfterUTC: envNumber("NY_ASIAN_PREFER_AFTER_UTC", 13.0),
      forceExitUTC: envNumber("NY_ASIAN_FORCE_EXIT_UTC", 16.0),
      requireH1Alignment: envBool("NY_ASIAN_REQUIRE_H1_ALIGNMENT", true),
      entryBufferPips: envNumber("NY_ASIAN_ENTRY_BUFFER_PIPS", 0.5),
      stopBufferPips: envNumber("NY_ASIAN_STOP_BUFFER_PIPS", 0.5),
      minBreakPips: envNumber("NY_ASIAN_MIN_BREAK_PIPS", 1.0),
      minRiskPips: envNumber("NY_ASIAN_MIN_RISK_PIPS", 5),
      maxRiskPips: envNumber("NY_ASIAN_MAX_RISK_PIPS", 10),
      rrRatio: envNumber("NY_ASIAN_RR_RATIO", 1.2),
      pendingExpiryBars: envNumber("NY_ASIAN_PENDING_EXPIRY_BARS", 3),
      timeExitBars: envNumber("NY_ASIAN_TIME_EXIT_BARS", 12),
      maxTradesPerSession: envNumber("NY_ASIAN_MAX_TRADES_PER_SESSION", 1),
      lookbackCandles: envNumber("NY_ASIAN_LOOKBACK_CANDLES", 220),
    },
  },

};
