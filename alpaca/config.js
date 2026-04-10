/**
 * Bot Configuration — Alpaca Edition
 * Supports both US Stocks and Crypto
 */

import "dotenv/config";

export const config = {

  // ─── AI Provider ─────────────────────────────────────────────────────────
  // "ollama"    → local model via Ollama (free, private, runs on your Mac)
  // "anthropic" → Claude API (requires API key + costs money)
  aiProvider: process.env.AI_PROVIDER || "ollama",

  // ─── Ollama Settings (used when aiProvider = "ollama") ───────────────────
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
    // Recommended models for your M1 MacBook Air 16GB:
    //   "llama3.2:3b"   → Extremely fast (50+ tok/s), solid reasoning   ✅ Best for Speed
    //   "qwen2.5:7b"    → Great at following JSON instructions           ✅ Reliable
    //   "deepseek-r1:8b"→ Reasoning (outputs <think> block), very smart  ✅ Best for Quality
    model: process.env.OLLAMA_MODEL || "llama3.2:3b",

    // Performance tuning (leverages prompt caching in Ollama)
    numCtx:     parseInt(process.env.OLLAMA_NUM_CTX) || 2048,
    numPredict: parseInt(process.env.OLLAMA_NUM_PREDICT) || 300,
    keepAlive:  process.env.OLLAMA_KEEP_ALIVE || "10m",
    timeout:    parseInt(process.env.OLLAMA_TIMEOUT) || 45000, // 45s timeout
  },

  // ─── Anthropic (used when aiProvider = "anthropic") ──────────────────────
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // Use "claude-3-5-haiku-latest" for speed and cost-efficiency
  // Use "claude-3-5-sonnet-latest" for maximum reasoning quality
  anthropicModel:  process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
  anthropicMaxTokens: 300,

  // ─── Alpaca API Keys ──────────────────────────────────────────────────────
  alpacaApiKey:    process.env.APCA_API_KEY_ID     || "",
  alpacaSecretKey: process.env.APCA_API_SECRET_KEY || "",
  
  // ─── WebSocket Settings ──────────────────────────────────────────────────
  websocket: {
    stockData:  "wss://stream.data.alpaca.markets/v2/iex",
    cryptoData: "wss://stream.data.alpaca.markets/v1beta3/crypto/us",
    trading:    process.env.ALPACA_ENV === "live"
      ? "wss://api.alpaca.markets/stream"
      : "wss://paper-api.alpaca.markets/stream",
  },

  // ─── Environment ─────────────────────────────────────────────────────────
  // "paper" = free paper trading (START HERE — no real money)
  // "live"  = real money (only after proven paper results)
  alpacaEnv: process.env.ALPACA_ENV || "paper",

  // ─── What to Trade ───────────────────────────────────────────────────────
  //
  // STOCKS  (US market hours only: 9:30am–4pm ET, Mon–Fri)
  //   "SPY"   → S&P 500 ETF — safest, most liquid, tight spreads
  //   "QQQ"   → Nasdaq 100 ETF — tech-heavy, more volatile
  //   "AAPL"  → Apple — very liquid, good for scalping
  //   "TSLA"  → Tesla — high volatility, higher risk/reward
  //   "NVDA"  → Nvidia — volatile, popular for scalping
  //
  // CRYPTO  (24/7, even weekends)
  //   "BTC/USD"   → Bitcoin — most liquid crypto
  //   "ETH/USD"   → Ethereum — second most liquid
  //   "SOL/USD"   → Solana — higher volatility
  //
  defaultInstrument: process.env.DEFAULT_SYMBOL || "ETH/USD",

  // ─── Timeframe ───────────────────────────────────────────────────────────
  // Stocks:  M1 or M5 recommended during market hours
  // Crypto:  M5 or M15 recommended (24/7 so less need for speed)
  granularity: "M5",

  // ─── Poll Interval ───────────────────────────────────────────────────────
  // How often to check for a signal (in seconds)
  // Match your granularity: M1=60, M5=300, M15=900
  // Note: Ollama on M1 is slower — don't go below 60s
  pollIntervalSeconds: 60,

  // ─── Risk Management ─────────────────────────────────────────────────────
  riskPercentPerTrade: 1,
  minConfidenceToExecute: 72,

  // ─── Fees & Spreads ──────────────────────────────────────────────────────
  // Alpaca Crypto taker fee is typically 0.15% - 0.30%
  // US Stocks are usually 0 fee on Alpaca
  cryptoFeeRate: 0.003, // 0.3% per side
  stockFeeRate:  0.0,
};
