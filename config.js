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
    { name: "london_open", start: 7.0, end: 12.5 },
    { name: "ny_overlap", start: 12.5, end: 16.0 },
  ],
};

const sessionWindowMode = process.env.SESSION_WINDOW_MODE || "all_windows";
const selectedSessionWindowsUTC = sessionWindowPresetsUTC[sessionWindowMode] || sessionWindowPresetsUTC.ny_only;
const supportedStrategyModes = ["ny_asian_continuation", "london_asian_fake_break_reversal", "combined_ny_london"];
const strategyMode = process.env.STRATEGY_MODE || "ny_asian_continuation";
if (!supportedStrategyModes.includes(strategyMode)) {
  throw new Error(`Unsupported STRATEGY_MODE="${strategyMode}". Supported modes: ${supportedStrategyModes.join(", ")}`);
}

const londonFakeBreakProfile = process.env.LONDON_FAKE_BREAK_PROFILE || "candidate_b";
const londonFakeBreakProfiles = {
  candidate_b: {
    description: "Candidate B — opposite Asian range target, 4p break, 2-bar confirmation",
    minBreakPips: 4.0,
    confirmBars: 2,
    minRiskPips: 5,
    maxRiskPips: 10,
    targetMode: "asian_opposite",
    h1Filter: "all",
  },
  candidate_a_time_exit: {
    description: "Candidate A — strongest cross-pair research row, H1 reversal-aligned time exit",
    minBreakPips: 2.0,
    confirmBars: 3,
    minRiskPips: 5,
    maxRiskPips: 10,
    targetMode: "time_exit",
    h1Filter: "reversal_with_h1",
  },
};
const selectedLondonFakeBreakProfile = londonFakeBreakProfiles[londonFakeBreakProfile] || londonFakeBreakProfiles.candidate_b;

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
    "XAU_USD": 41,
    "XAG_USD": 42,
    "BTC_USD": 10026,
    "ETH_USD": 10029,
    "US30": 10015,
    "UK100": 10011,
  },

  // ─── Strategy Scope ─────────────────────────────────────────────────────────
  defaultInstrument:   "EUR_USD",
  tradingPairs: envList("TRADING_PAIRS", ["EUR_USD", "GBP_USD", "USD_JPY"]),
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
    accountCapitalKES:    151_205,
    riskPerTradePercent:  envNumber("RISK_PER_TRADE_PERCENT", 1.0),
    enforceDailyStopLoss: envBool("ENFORCE_DAILY_STOP_LOSS", true),
      dailyStopLossKES: envNumber("DAILY_STOP_LOSS_KES", 12000),
      dailyProfitTargetKES: envNumber("DAILY_PROFIT_TARGET_KES", 20000),
    maxLeverage:          100,
    usdKesRate:           129.0,
  },

  // ─── Trade Limits ───────────────────────────────────────────────────────
  maxTotalTrades:   envNumber("MAX_TOTAL_TRADES", 3), // Allow up to one active/pending setup per configured pair by default
  maxTradesPerPair: envNumber("MAX_TRADES_PER_PAIR", 1),
  maxPositionSizeUnits: 100_000,
  maxSlippagePips: envNumber("MAX_SLIPPAGE_PIPS", 0.5),
  execution: {
    useBrokerStopOrders: envBool("USE_BROKER_STOP_ORDERS", true),
    fallbackToLocalStops: envBool("FALLBACK_TO_LOCAL_STOPS", false),
    maxSpreadPips: envNumber("MAX_SPREAD_PIPS", 1.5),
    maxQuoteAgeMs: envNumber("MAX_QUOTE_AGE_MS", 5_000),
    debugOrderPayload: envBool("DEBUG_ORDER_PAYLOAD", false),
    // How often (ms) the watchdog re-checks open positions still carry their
    // expected SL/TP on the broker, restoring it automatically if it's missing.
    protectionCheckIntervalMs: envNumber("PROTECTION_CHECK_INTERVAL_MS", 30_000),
  },
  backtest: {
    spreadPips: envNumber("BACKTEST_SPREAD_PIPS", 0.7),
    slippagePips: envNumber("BACKTEST_SLIPPAGE_PIPS", 0.3),
    fixedBalanceUSD: envNumber("BACKTEST_FIXED_BALANCE_USD", null),
    intrabarMode: process.env.BACKTEST_INTRABAR_MODE || "conservative",
  },

  strategy: {
    mode: strategyMode,
    supportedModes: supportedStrategyModes,

    cooldownCandlesAfterLoss: envNumber("COOLDOWN_CANDLES_AFTER_LOSS", 1),
    higherTimeframeTrend: {
      enabled: true,
      granularity: "H1",
      emaPeriod: 200,
      lookbackCandles: 250,
      requireSlope: envBool("HTF_REQUIRE_SLOPE", true),
    },
    nyAsianContinuation: {
      enabled: true,
      blockOnPriorBreak: envBool("NY_ASIAN_BLOCK_ON_PRIOR_BREAK", true),
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
      minBreakPips: envNumber("NY_ASIAN_MIN_BREAK_PIPS", 3.0),
      minRiskPips: envNumber("NY_ASIAN_MIN_RISK_PIPS", 5),
      maxRiskPips: envNumber("NY_ASIAN_MAX_RISK_PIPS", 15),
      rrRatio: envNumber("NY_ASIAN_RR_RATIO", 1.5),
      pendingExpiryBars: envNumber("NY_ASIAN_PENDING_EXPIRY_BARS", 3),
      timeExitBars: envNumber("NY_ASIAN_TIME_EXIT_BARS", 12),
      maxTradesPerSession: envNumber("NY_ASIAN_MAX_TRADES_PER_SESSION", 1),
      lookbackCandles: envNumber("NY_ASIAN_LOOKBACK_CANDLES", 220),
      partialTpEnabled: envBool("NY_ASIAN_PARTIAL_TP_ENABLED", false),
      partialTpFraction: envNumber("NY_ASIAN_PARTIAL_TP_FRACTION", 0.5),
      partialTpTriggerRr: envNumber("NY_ASIAN_PARTIAL_TP_TRIGGER_RR", 1.0),
      partialTpMoveSlToEntry: envBool("NY_ASIAN_PARTIAL_TP_MOVE_SL_TO_ENTRY", true),
    },
    londonAsianFakeBreakReversal: {
      enabled: true,
      monitorEnabled: envBool("LONDON_MONITOR_ENABLED", false),
      liveExecutionEnabled: envBool("LONDON_LIVE_EXECUTION_ENABLED", false),
      profile: londonFakeBreakProfile,
      profileDescription: selectedLondonFakeBreakProfile.description,
      availableProfiles: Object.keys(londonFakeBreakProfiles),
      allowedSessionNames: envList("LONDON_FAKE_BREAK_ALLOWED_SESSIONS", ["london_open"]),
      allowedPairs: envList("LONDON_FAKE_BREAK_ALLOWED_PAIRS", []),
      allowedWeekdays: envList("LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS", ["Wed"]),
      excludedPairWeekdays: Object.fromEntries(envList("LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS", []).map(item => {
        const [pair, day] = item.split(":").map(v => v?.trim()).filter(Boolean);
        return pair && day ? [pair, day] : null;
      }).filter(Boolean)),
      asianStartUTC: envNumber("LONDON_FAKE_BREAK_ASIAN_START_UTC", 0),
      asianEndUTC: envNumber("LONDON_FAKE_BREAK_ASIAN_END_UTC", 7),
      tradeStartUTC: envNumber("LONDON_FAKE_BREAK_TRADE_START_UTC", 7.0),
      tradeEndUTC: envNumber("LONDON_FAKE_BREAK_TRADE_END_UTC", 10.0),
      minBreakPips: envNumber("LONDON_FAKE_BREAK_MIN_BREAK_PIPS", selectedLondonFakeBreakProfile.minBreakPips),
      confirmBars: envNumber("LONDON_FAKE_BREAK_CONFIRM_BARS", selectedLondonFakeBreakProfile.confirmBars),
      stopBufferPips: envNumber("LONDON_FAKE_BREAK_STOP_BUFFER_PIPS", 0.5),
      minRiskPips: envNumber("LONDON_FAKE_BREAK_MIN_RISK_PIPS", selectedLondonFakeBreakProfile.minRiskPips),
      maxRiskPips: envNumber("LONDON_FAKE_BREAK_MAX_RISK_PIPS", selectedLondonFakeBreakProfile.maxRiskPips),
      targetMode: process.env.LONDON_FAKE_BREAK_TARGET_MODE || "time_exit",
      tpRrMultiplier: envNumber("LONDON_FAKE_BREAK_TP_RR_MULTIPLIER", 0),
      h1Filter: process.env.LONDON_FAKE_BREAK_H1_FILTER || selectedLondonFakeBreakProfile.h1Filter,
      noFadeH1AlignedBreak: envBool("LONDON_FAKE_BREAK_NO_FADE_H1_ALIGNED", false),
      minAsianRangePips: envNumber("LONDON_FAKE_BREAK_MIN_ASIAN_RANGE_PIPS", 0),
      maxAsianRangePips: envNumber("LONDON_FAKE_BREAK_MAX_ASIAN_RANGE_PIPS", 60),
      minConfirmationBarsAfterBreak: envNumber("LONDON_FAKE_BREAK_MIN_CONFIRMATION_BARS_AFTER_BREAK", 0),
      timeExitBars: envNumber("LONDON_FAKE_BREAK_TIME_EXIT_BARS", 12),
      maxTradesPerSession: envNumber("LONDON_FAKE_BREAK_MAX_TRADES_PER_SESSION", 1),
      maxLossesPerDay: envNumber("LONDON_MAX_LOSSES_PER_DAY", 1),
      maxDailyLossUSD: envNumber("LONDON_MAX_DAILY_LOSS_USD", 0),
      lookbackCandles: envNumber("LONDON_FAKE_BREAK_LOOKBACK_CANDLES", 220),
    },
  },

};
