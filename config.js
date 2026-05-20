/**
 * Configuration — Scalping Strategy
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
const supportedStrategyModes = ["ny_asian_continuation"];
const strategyMode = process.env.STRATEGY_MODE || "ny_asian_continuation";
if (!supportedStrategyModes.includes(strategyMode)) {
  throw new Error(`Unsupported STRATEGY_MODE="${strategyMode}". Supported modes: ${supportedStrategyModes.join(", ")}`);
}

export const config = {

  // ─── cTrader Credentials ─────────────────────────────────────────────
  ctraderClientId:     process.env.CTRADER_CLIENT_ID     || "",
  ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET || "",
  ctraderAccessToken:  process.env.CTRADER_ACCESS_TOKEN  || "",
  ctraderAccountId:    Number(process.env.CTRADER_ACCOUNT_ID) || 0,
  ctraderEnv:          process.env.CTRADER_ENV || "demo",
  ctraderRateLimit: {
    // Throttle only non-trade API calls (candles/symbol/account lookups).
    // Order placement/close/amend requests bypass this queue so execution is not delayed.
    nonTradeMinIntervalMs: envNumber("CTRADER_NON_TRADE_MIN_INTERVAL_MS", 750),
    maxNonTradeRequestsPerMinute: envNumber("CTRADER_MAX_NON_TRADE_REQUESTS_PER_MINUTE", 40),
    rateLimitBackoffMs: envNumber("CTRADER_RATE_LIMIT_BACKOFF_MS", 30_000),
  },

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
  tradingPairs:        envList("TRADING_PAIRS", ["EUR_USD", "GBP_USD", "USD_JPY"]),
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
    accountCapitalKES:    250_000,
    riskPerTradePercent:  envNumber("RISK_PER_TRADE_PERCENT", 1),
    enforceDailyStopLoss: envBool("ENFORCE_DAILY_STOP_LOSS", true),
    dailyStopLossKES:     envNumber("DAILY_STOP_LOSS_KES", 3000),
    dailyProfitTargetKES: envNumber("DAILY_PROFIT_TARGET_KES", 5000),
    maxLeverage:          100,
    usdKesRate:           129.0,
  },

  // ─── Trade Limits ───────────────────────────────────────────────────────
  maxTotalTrades:   1, // Focus on one quality trade at a time
  maxTradesPerPair: 1,
  maxPositionSizeUnits: 100_000,
  maxSlippagePips: envNumber("MAX_SLIPPAGE_PIPS", 0.5),

  strategy: {
    mode: strategyMode,
    supportedModes: supportedStrategyModes,

    cooldownCandlesAfterLoss: envNumber("COOLDOWN_CANDLES_AFTER_LOSS", 1),
    higherTimeframeTrend: {
      enabled: true,
      granularity: "H1",
      emaPeriod: 200,
      lookbackCandles: 250,
      requireSlope: true,
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
