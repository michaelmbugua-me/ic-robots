/**
 * Configuration — IC Markets cTrader Edition
 *
 * Fill in your credentials after running:
 *   1. node auth.js       → gets your access token
 *   2. node get-symbols.js → gets correct symbol IDs
 */

import "dotenv/config";

export const config = {

  // ─── AI Provider ───────────────────────────────────────────────────────
  // "ollama"    → Llama 3 / Qwen / Mistral (Local)
  // "anthropic" → Claude 3.5 Sonnet (Cloud)
  aiProvider: process.env.AI_PROVIDER || "ollama",

  // ─── AI Mode ───────────────────────────────────────────────────────────
  // "ALWAYS" → AI sees every tick and decides (Most overhead)
  // "HYBRID" → Technical rules trigger, AI confirms (Recommended)
  // "OFF"    → Pure technical rules (Mock logic), no AI overhead
  aiMode: process.env.AI_MODE || "HYBRID",

  // ─── Anthropic ─────────────────────────────────────────────────────────
  // anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // anthropicModel:  "claude-3-5-sonnet-latest",
  // anthropicMaxTokens: 300,

  // ─── Ollama (Local AI) ─────────────────────────────────────────────────
  // Best models for scalping: 
  //   1. llama3.2:3b     (sub-second on M1 Mac)
  //   2. deepseek-r1:8b  (strong reasoning, ~2-4s)
  //   3. mistral:latest  (balanced)
  ollama: {
    baseUrl:    process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    model:      process.env.OLLAMA_MODEL    || "llama3.2:3b",
    timeout:    parseInt(process.env.OLLAMA_TIMEOUT) || 45000, // 45s timeout
    numCtx:     parseInt(process.env.OLLAMA_NUM_CTX) || 2048,
    numPredict: parseInt(process.env.OLLAMA_NUM_PREDICT) || 150,
    keepAlive:  process.env.OLLAMA_KEEP_ALIVE || "10m",
  },

  // ─── cTrader Open API App Credentials ──────────────────────────────────
  // From: https://openapi.ctrader.com/apps → Credentials
  ctraderClientId:     process.env.CTRADER_CLIENT_ID     || "",
  ctraderClientSecret: process.env.CTRADER_CLIENT_SECRET || "",

  // From: running `node auth.js` (expires every ~30 days)
  ctraderAccessToken:  process.env.CTRADER_ACCESS_TOKEN  || "",

  // Your IC Markets cTrader account number
  // Visible top-left in the cTrader desktop/web platform
  ctraderAccountId: Number(process.env.CTRADER_ACCOUNT_ID) || 0,

  // ─── Environment ───────────────────────────────────────────────────────
  // "demo" → IC Markets demo account  ← START HERE
  // "live" → real money (only after proven demo results)
  ctraderEnv: "demo",

  // ─── Symbol IDs ────────────────────────────────────────────────────────
  // Run `node get-symbols.js` after authenticating to get the real IDs.
  // These defaults are typical for IC Markets but MUST be verified.
  ctraderSymbolIds: {
    "EUR_USD": 1,
    "GBP_USD": 2,
    "USD_JPY": 3,
    "USD_CHF": 4,
    "AUD_USD": 5,
    "USD_CAD": 6,
    "NZD_USD": 7,
    "EUR_GBP": 8,
    "EUR_JPY": 9,
    "GBP_JPY": 10,
  },

  // ─── Trading ───────────────────────────────────────────────────────────
  // Best forex pairs for scalping: EUR_USD, GBP_USD, USD_JPY
  defaultInstrument:   "EUR_USD",

  // Candle timeframe: M1, M5, M15, M30, H1
  // M5 is the sweet spot for scalping — fast enough, not too noisy
  granularity:         "M5",

  // How often to poll for a new signal (seconds)
  // Should roughly match your granularity: M1=60, M5=300
  pollIntervalSeconds: 60,

  // ─── Risk Management ───────────────────────────────────────────────────
  // % of account balance to risk per trade — never go above 2%
  riskPercentPerTrade: 1.0,

  // Max allowed position size (in units) to prevent huge lot sizes if SL is tight
  // 10,000 = 0.1 lots. 100,000 = 1.0 lot.
  maxPositionSizeUnits: 50000,

  // Max allowed price deviation (%) between AI entry and current market price
  // (Prevents execution on AI hallucinations or old data)
  maxPriceDeviationPercent: 0.1,

  // Min Claude confidence (0–100) required to auto-execute a trade
  // Raise this to be more selective (recommended: 70+)
  minConfidenceToExecute: 80,

  // ─── Safety & Circuit Breakers ──────────────────────────────────────────
  // Max daily loss (%) to stop trading for the day
  maxDailyLossPercent: 5.0,

  // Wait time (minutes) after a STOP LOSS before taking another trade
  lossCooldownMinutes: 15,

  // Max allowed spread (in pips) to prevent entry during high volatility
  maxSpreadPips: 1.5,

  // Minimum ATR (in pips) required to ensure enough price movement for scalping
  minAtrPips: 0.8,

  // ─── Profit Protection ──────────────────────────────────────────────────
  // Move Stop Loss to Entry (Breakeven) after profit reaches X * ATR
  useBreakeven: true,
  breakevenTriggerATR: 2.0, // Activate trailing at 2x ATR profit

  // Trailing stop: once breakeven triggers, trail SL at this ATR distance from price
  useTrailingStop: true,
  trailingStopATR: 1.5, // Trail 1.5x ATR behind current price

  // ─── Multi-Trade Management ────────────────────────────────────────────
  // Max concurrent trades allowed for the same pair
  maxConcurrentTrades: 1,

  // Total account risk (%) for all combined trades (e.g. 3 * 1% = 3%)
  maxTotalRiskPercent: 3.0,

  // Min price distance (in pips) required between new and existing trades
  // (Prevents "stacking" multiple trades at the exact same entry)
  minTradeDistancePips: 5,

  // ─── Safety Checks ─────────────────────────────────────────────────────
  // Minimum SL/TP distance in pips to prevent trades too close to entry
  // (Protects from spread-outs and noise)
  minStopDistancePips: 2,

  // Minimum SL/TP as a fraction of current ATR (e.g., 0.3 means 30% of ATR)
  atrMultiplierFloor: 0.3,

  // ─── Strategy Settings (Finetuning) ────────────────────────────────────
  strategy: {
    // ATR Multipliers for targets (Higher = wider, better for spread)
    // 2.5x SL / 5.0x TP is a 1:2 RR ratio — wider SL avoids M5 noise
    atrMultiplierSL: 2.5,
    atrMultiplierTP: 5.0,

    // RSI Thresholds (Strict — only trade genuine oversold/overbought)
    rsiThresholdLow:  30,
    rsiThresholdHigh: 70,

    // EMA Periods
    emaFast: 8,
    emaSlow: 21,

    // ADX minimum — filters out choppy/ranging markets (no directional conviction)
    minAdx: 18,

    // Volume confirmation — require at least this multiple of avg volume for entries
    // Set to 0 to disable. 1.0 = average, 1.2 = 20% above average
    minVolumeRatio: 0.8,

    // ─── News & Sentiment Filters ──────────────────────────────────────────
    // Block trading during high-impact news events (USD/EUR for EUR_USD)
    newsBlocker: true,
    newsBlockMinutesBefore: 30, // Block trades X minutes before news
    newsBlockMinutesAfter:  30, // Block trades X minutes after news
    
    // AI Sentiment Check: Minimum AI confidence required for trading
    // (A confidence level above 80% usually indicates strong sentiment alignment)
    minSentimentConfidence: 75, 

    // ─── News API ────────────────────────────────────────────────────────
    // "finnhub"      → Real automated API (Requires API Key from finnhub.io)
    newsProvider: process.env.NEWS_PROVIDER || "finnhub",
    newsApiKey:   process.env.NEWS_API_KEY   || "",
  },

  // ─── Backtest Specific ──────────────────────────────────────────────────
  // Replicate IC Markets Raw Spread environment as closely as possible
  backtest: {
    // Typical Raw Spread for major pairs (0.0 to 0.3 pips)
    // EUR_USD average is 0.1 pips.
    spreadPips: 0.1,

    // Simulated slippage (pips) for market orders.
    // 0.2 pips is a realistic average for fast execution.
    slippagePips: 0.2,

    // cTrader Commission: $3.00 USD per 100,000 USD volume traded (per side).
    // This is $6.00 per standard lot if price is 1.0000.
    commissionPerSideUSD: 3.00,

    // Initial virtual balance
    initialBalance: 200,
  },
};
