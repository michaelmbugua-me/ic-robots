/**
 * AI Client
 * Unified interface for Ollama (local) and Anthropic (cloud)
 *
 * Ollama docs:     https://github.com/ollama/ollama/blob/main/docs/api.md
 * OpenAI-compat:   http://localhost:11434/v1/chat/completions
 */

import { config } from "./config.js";

// ─── Shared prompt builder ────────────────────────────────────────────────────

/**
 * Split prompt into System (Instructions) and User (Data) to leverage 
 * prompt caching in Ollama and Anthropic.
 */

export function getSystemPrompt(isCrypto) {
  const assetType = isCrypto ? "crypto" : "stock";

  return `Expert scalper for ${assetType}.
Rules:
- Conf >= 72 to trade (Wait if low conviction)
- Trend: Aligned 3-EMA (8 > 21 > 50 for BUY, 8 < 21 < 50 for SELL)
- VWAP: Price above VWAP = Bullish bias, Below VWAP = Bearish bias
- RR: SL 1.5x ATR | TP 2x ATR min (1:1.5 min)
- FEES: Round-trip fee is 0.6% (approx). Profit targets MUST be > 0.6% of price.
- RSI(7): > 80 no BUY (overextended) | < 20 no SELL
- Reasoning: reference indicators and VWAP interaction

CRITICAL: stopLoss and takeProfit MUST be calculated based on entry +/- ATR distance. 
They MUST NEVER be equal to the entry price. 
For BUY: takeProfit > entry + (ATR * 1.5), stopLoss < entry - (ATR * 1.5).
For SELL: takeProfit < entry - (ATR * 1.5), stopLoss > entry + (ATR * 1.5).
The profit target MUST cover the round-trip fees and provide a real gain.
Volatility is high: avoid extremely tight levels that will be rejected by the exchange.

Respond ONLY JSON:
{
  "action": "BUY"|"SELL"|"WAIT",
  "confidence": <0-100>,
  "entry": <number>,
  "stopLoss": <number>,
  "takeProfit": <number>,
  "reasoning": "<concise evidence>"
}`;
}

export function getUserPrompt(symbol, granularity, isCrypto, indicators, recentBars) {
  const session = isCrypto ? "24/7" : getStockSession();

  return `SYMBOL: ${symbol} | TF: ${granularity} | SESS: ${session}
IND: EMA8:${indicators.ema8.toFixed(4)}, EMA21:${indicators.ema21.toFixed(4)}, EMA50:${indicators.ema50.toFixed(4)}, RSI:${indicators.rsi.toFixed(1)}, ATR:${indicators.atr.toFixed(4)}, VWAP:${indicators.vwap.toFixed(4)}, PX:${indicators.currentPrice.toFixed(4)}
TREND: EMA8 vs 21: ${indicators.ema8 > indicators.ema21 ? "UP" : "DOWN"} | Major (50): ${indicators.currentPrice > indicators.ema50 ? "Above" : "Below"}
BARS (newest last): ${JSON.stringify(recentBars.map(b => [b.time.split('T')[1].slice(0,5), b.open, b.high, b.low, b.close, b.volume]))}`;
}

function getStockSession() {
  const now = new Date();
  const et  = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h   = et.getHours();
  const m   = et.getMinutes();
  const t   = h * 60 + m;

  if (t >= 570 && t < 600) return "Market Open — first 30 min (high noise, be cautious)";
  if (t >= 600 && t < 690) return "Morning Session (good for scalping)";
  if (t >= 690 && t < 840) return "Midday (low volume — be cautious)";
  if (t >= 840 && t < 960) return "Afternoon Session (good for scalping)";
  return "After Hours";
}

// ─── Response parser (shared) ─────────────────────────────────────────────────

export function parseSignalResponse(text) {
  // Remove thinking blocks common in reasoning models (Qwen2.5, DeepSeek-R1, etc)
  const content = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const jsonText = match[0];
        // Remove trailing commas and single-line comments that confuse JSON.parse
        const cleaned = jsonText
          .replace(/,\s*([}\]])/g, "$1")
          .replace(/\/\/.*$/gm, "")
          .trim();
        return JSON.parse(cleaned);
      } catch {
        // fall through
      }
    }
    console.warn("  ⚠️  Could not parse AI response:", content.slice(0, 200));
    return { action: "WAIT", confidence: 0, reasoning: "Parse error" };
  }
}

// ─── Ollama client ────────────────────────────────────────────────────────────

export class OllamaClient {
  constructor() {
    this.baseUrl = config.ollama.baseUrl;
    this.model   = config.ollama.model;
  }

  /**
   * Call via Ollama's /api/chat endpoint to leverage prompt caching.
   * Uses format:"json" to constrain output.
   */
  async getSignal(systemPrompt, userPrompt) {
    const url  = `${this.baseUrl}/api/chat`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ollama.timeout || 45000);

    const body = {
      model:  this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   }
      ],
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_ctx:     config.ollama.numCtx || 2048,
        num_predict: config.ollama.numPredict || 300,
        mirostat:    0,  // Off for consistent results
      },
      keep_alive: config.ollama.keepAlive || "10m",
    };

    let res;
    try {
      res = await fetch(url, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`Ollama request timed out after ${config.ollama.timeout}ms. Try a smaller model like llama3.2:3b.`);
      }
      throw new Error(
        `Ollama connection failed — is Ollama running? Start it with: ollama serve\n  (${err.message})`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Model "${this.model}" not found. Pull it first:\n  ollama pull ${this.model}`
        );
      }
      throw new Error(`Ollama error ${res.status}: ${detail}`);
    }

    const data = await res.json();
    const content = data.message?.content ?? "";
    
    if (!content) {
      console.warn("  ⚠️  Ollama returned empty content.");
      return { action: "WAIT", confidence: 0, reasoning: "Empty AI response" };
    }

    return parseSignalResponse(content);
  }

  /** Quick connectivity check — called once at startup */
  async healthCheck() {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const models = (data.models ?? []).map((m) => m.name);
      const hasModel = models.some((m) => m.startsWith(this.model.split(":")[0]));

      if (!hasModel) {
        console.warn(`  ⚠️  Model "${this.model}" not found locally.`);
        console.warn(`      Available: ${models.join(", ") || "none"}`);
        console.warn(`      Run: ollama pull ${this.model}\n`);
      }
      return true;
    } catch (err) {
      throw new Error(
        `Cannot reach Ollama at ${this.baseUrl}.\n` +
        `  Make sure Ollama is installed and running:\n` +
        `    brew install ollama   (if not installed)\n` +
        `    ollama serve          (start the server)\n` +
        `    ollama pull ${this.model}   (download model)\n`
      );
    }
  }
}

// ─── Anthropic client ─────────────────────────────────────────────────────────

export class AnthropicAIClient {
  constructor() {
    // Lazy import so Anthropic SDK is only needed when actually used
    this._client = null;
  }

  async _init() {
    if (!this._client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      this._client = new Anthropic({ apiKey: config.anthropicApiKey });
    }
    return this._client;
  }

  async getSignal(systemPrompt, userPrompt) {
    const client = await this._init();
    const response = await client.messages.create({
      model:      config.anthropicModel,
      max_tokens: config.anthropicMaxTokens || 300,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    const content = response.content[0]?.text ?? "";
    if (!content) {
      return { action: "WAIT", confidence: 0, reasoning: "Empty Claude response" };
    }

    return parseSignalResponse(content);
  }

  async healthCheck() {
    if (!config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set in your .env file.");
    }
    return true;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createAIClient() {
  if (config.aiProvider === "anthropic") {
    return new AnthropicAIClient();
  }
  return new OllamaClient();
}
