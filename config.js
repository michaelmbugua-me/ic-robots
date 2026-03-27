/**
 * Bot Configuration
 * Edit these values to customize behavior
 */

export const config = {
  // ─── API Keys ────────────────────────────────────────────────────────────
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  oandaApiKey: process.env.OANDA_API_KEY || "",
  oandaAccountId: process.env.OANDA_ACCOUNT_ID || "",

  // ─── OANDA Environment ───────────────────────────────────────────────────
  // "practice" = paper trading (recommended to start)
  // "live"     = real money (use with caution!)
  oandaEnv: "practice",

  // ─── Trading Pair ────────────────────────────────────────────────────────
  defaultInstrument: "EUR_USD",

  // ─── Timeframe ───────────────────────────────────────────────────────────
  // M1=1min, M5=5min, M15=15min (M1 or M5 recommended for scalping)
  granularity: "M5",

  // ─── Poll Interval ───────────────────────────────────────────────────────
  // How often to check for signals (in seconds)
  // Should match your granularity (e.g. 60s for M1, 300s for M5)
  pollIntervalSeconds: 60,

  // ─── Risk Management ─────────────────────────────────────────────────────
  // Max % of account balance to risk per trade
  riskPercentPerTrade: 1,

  // Minimum Claude confidence score (0-100) required to auto-execute
  // Higher = more conservative (recommended: 70+)
  minConfidenceToExecute: 72,
};
