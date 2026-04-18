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
  // "OFF"    → Pure technical indicators, zero latency (Recommended for scalping)
  // "HYBRID" → Technical rules trigger, AI confirms (adds 2-15s latency)
  // "ALWAYS" → AI sees every tick and decides (Most overhead)
  aiMode: process.env.AI_MODE || "OFF",

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
  // Dual-strategy approach:
  //   EUR_USD → Pullback (buy oversold dips in uptrend) — proven profitable
  //   GBP_USD → Momentum (buy breakouts with trend) — GBP's volatility suits breakouts
  defaultInstrument:   "EUR_USD",

  // Pairs to scan when no --pair flag is provided (multi-pair mode)
  // Each pair is evaluated independently every tick cycle
  // NOTE: GBP_USD tested unprofitable on M5 in both momentum (PF 0.72) and pullback (PF 0.38).
  // EUR_USD pullback is the only strategy with a proven edge (PF 2.0, 72% WR).
  // Add pairs back only after positive backtest results.
  tradingPairs: (process.env.TRADING_PAIRS || "EUR_USD").split(",").map(s => s.trim()),

  // Candle timeframe: M1, M5, M15, M30, H1
  // M5 is the sweet spot for scalping — fast enough, not too noisy
  granularity:         "M5",

  // How often to poll for a new signal (seconds)
  // Should roughly match your granularity: M1=60, M5=300
  pollIntervalSeconds: 60,

  // ─── Session Hours (UTC) ────────────────────────────────────────────────
  // London Open through NY Afternoon: 08:00–18:00 UTC (11:00–21:00 EAT)
  // Covers London, London/NY Overlap, and most of New York session.
  // Avoids low-liquidity Asian session and dead NY close.
  sessionStartUTC: 8,
  sessionEndUTC:   18,

  // ─── KES Risk Management (Primary) ─────────────────────────────────────
  // 50,000 KES account targeting 500–1,000 KES daily profit
  risk: {
    accountCapitalKES:    parseFloat(process.env.ACCOUNT_CAPITAL_KES) || 50_000,
    dailyStopLossKES:     parseFloat(process.env.DAILY_STOP_LOSS_KES) || 1_000,
    dailyProfitTargetKES: parseFloat(process.env.DAILY_PROFIT_TARGET_KES) || 1_000,
    maxLeverage:          100,
    maxOpenTrades:        1,
    minRiskReward:        1.5,   
    usdKesRate:           parseFloat(process.env.USD_KES_RATE) || 129.0, 
  },

  // Fallback risk percentage (used by backtester)
  riskPercentPerTrade: 2.0,

  // ─── Safety & Circuit Breakers ──────────────────────────────────────────
  lossCooldownMinutes: 15,
  maxSpreadPips: 1.5,
  minAtrPips: 0.8,
  maxSlippagePips: 2,

  // ─── Profit Protection ──────────────────────────────────────────────────
  useBreakeven: true,
  breakevenTriggerATR: 1.5, 
  useTrailingStop: true,
  trailingStopATR: 1.0, 

  // ─── Multi-Trade Management ────────────────────────────────────────────
  maxConcurrentTrades: 1,
  maxTotalTrades: 1, // Global cap across all pairs
  minTradeDistancePips: 5,
  minStopDistancePips: 2,
  atrMultiplierFloor: 0.3,

  // ─── Strategy Settings ────────────────────────────────────
  strategy: {
    atrMultiplierSL: 2.5,
    atrMultiplierTP: 4.5,
    rsiThresholdLow:  30,
    rsiThresholdHigh: 70,
    emaFast: 8,
    emaSlow: 21,
    minAdx: 18, // Lowered from 22 to allow more trades
    minVolumeRatio: 1.0,
    minConfirmations: 1,
    ema200Period: 200,
    atrAveragePeriod: 20,   
    usePriceActionTrigger: true,
    srLookbackPeriods: 50,   
    minSentimentConfidence: 75, 
  },

  // ─── Pair-Specific Overrides ────────────────────────────────────────────
  // Override any strategy.* key per pair.
  // strategyMode: "pullback" (default) = buy oversold, sell overbought (EUR_USD)
  //               "momentum" = buy breakouts above BB, sell breakdowns below BB (GBP_USD)
  pairOverrides: {
    // ⚠️  GBP_USD: TESTED UNPROFITABLE on M5 in both modes.
    //     - Momentum: PF 0.72, 40.5% WR, -$14.53 (false breakouts, tight SL clipped by noise)
    //     - Pullback: PF 0.38, 33.3% WR, -$44.36 (wider spreads + whippy action on M5)
    //     Consider M15/H1 timeframe if re-enabling. Keep for manual --pair GBP_USD testing.
    "GBP_USD": {
      strategyMode: "pullback",
      minAdx: 20,
      atrMultiplierSL: 2.5,
      atrMultiplierTP: 4.5,
      minVolumeRatio: 1.0,
      breakevenTriggerATR: 1.5,
      trailingStopATR: 1.0,
    },
    "AUD_USD": {
      // AUD/USD: Low volatility, clean mean-reversion, tight IC Markets spreads (~0.1 pip)
      // Download history and backtest before adding to tradingPairs:
      //   npm run download -- --pair AUD_USD --days 270
      //   npm run backtest-mock -- --pair AUD_USD
      strategyMode: "pullback",
      minAdx: 18,
      atrMultiplierSL: 2.5,
      atrMultiplierTP: 4.0,
      minVolumeRatio: 1.0,
      breakevenTriggerATR: 1.5,
      trailingStopATR: 1.0,
    },
    "EUR_GBP": {
      // EUR/GBP: Very range-bound, ideal for pullback/mean-reversion
      // Download history and backtest before adding to tradingPairs:
      //   npm run download -- --pair EUR_GBP --days 270
      //   npm run backtest-mock -- --pair EUR_GBP
      strategyMode: "pullback",
      minAdx: 15,
      atrMultiplierSL: 2.0,
      atrMultiplierTP: 3.5,
      minVolumeRatio: 0.8,
      breakevenTriggerATR: 1.3,
      trailingStopATR: 0.8,
    },
    "USD_JPY": {
      minAdx: 22,
      atrMultiplierSL: 3.0,
      atrMultiplierTP: 4.0,
    },
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
    initialBalance: 500,
  },
  connectionTimeoutSeconds: 10
};
