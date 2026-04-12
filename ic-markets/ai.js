/**
 * AI Client for IC Markets
 * Unified interface for Ollama (local) and Anthropic (cloud)
 */

import { config } from "./config.js";

// ─── Shared prompt builder ────────────────────────────────────────────────────

/**
 * Split prompt into System (Instructions) and User (Data) to leverage 
 * prompt caching in Ollama and Anthropic.
 */

export function getSystemPrompt(instrument) {
  const { minConfidenceToExecute } = config;
  const { emaFast, emaSlow } = config.strategy;
  return `Forex ${instrument} Institutional Scalper & Risk Gatekeeper. JSON ONLY.
Role: Your task is to provide FINAL confirmation for a technical trigger.
Strategy: Value Area Convergence (Institutional Mean Reversion).
Priority Rules:
1. STRUCTURE: Must be Bullish (EMA${emaFast} > EMA${emaSlow}) for BUY, Bearish for SELL.
2. VALUE: Only BUY in 'Discount' (Price < VWAP or Lower BB). Only SELL in 'Premium' (Price > VWAP or Upper BB).
3. MOMENTUM: Reject 'Falling Knives'. If momentum is strong against you, WAIT for rejection wicks.
4. NEWS: If news context is negative or highly uncertain, stay on the sidelines.
5. QUALITY: You are a professional trader. "WAIT" is your most frequent and safest action.
6. DATA: Analyze the last 30 candles for trend health and rejection patterns.
Format:
{
  "action": "BUY"|"SELL"|"WAIT",
  "confidence": 0-100,
  "sentiment": "Bullish"|"Bearish"|"Neutral",
  "sentimentScore": 0-100,
  "entry": 1.XXXXX,
  "stopLoss": 1.XXXXX,
  "takeProfit": 1.XXXXX,
  "reasoning": "brief"
}`;
}

export function getUserPrompt(symbol, granularity, indicators, recentBars, htfIndicators = null, allowedActions = ["BUY", "SELL", "WAIT"], newsHeadlines = "") {
  // Pass more candles for better pattern recognition (up to 30)
  const bars = recentBars.map(b => [b.time.split('T')[1].slice(0,5), b.mid.o, b.mid.h, b.mid.l, b.mid.c]);
  const px = indicators.currentPrice;
  const atr = indicators.atr;
  const { atrMultiplierSL, atrMultiplierTP } = config.strategy;

  const buySL = px - (atrMultiplierSL * atr);
  const buyTP = px + (atrMultiplierTP * atr);
  const sellSL = px + (atrMultiplierSL * atr);
  const sellTP = px - (atrMultiplierTP * atr);

  const { emaFast, emaSlow } = config.strategy;
  let htfContext = htfIndicators ? 
    `HTF (M15) TREND: EMA${emaFast}:${htfIndicators[`ema${emaFast}`].toFixed(5)}, EMA${emaSlow}:${htfIndicators[`ema${emaSlow}`].toFixed(5)}, Direction:${htfIndicators[`ema${emaFast}`] > htfIndicators[`ema${emaSlow}`] ? "UP" : "DOWN"}` : 
    "HTF TREND: Not Available";

  const macdHist = indicators.macd.hist !== null ? indicators.macd.hist.toFixed(5) : "N/A";
  const macdSignal = indicators.macd.signal !== null ? indicators.macd.signal.toFixed(5) : "N/A";

  const newsContext = newsHeadlines ? `--- FUNDAMENTAL CONTEXT ---\n${newsHeadlines}\n---------------------------` : "";
  const momPips = (indicators.momentum / (symbol.includes("JPY") ? 0.01 : 0.0001)).toFixed(1);
  const slopePips = (indicators.emaSlope / (symbol.includes("JPY") ? 0.01 : 0.0001)).toFixed(2);
  const lWickPips = (indicators.lowerWick / (symbol.includes("JPY") ? 0.01 : 0.0001)).toFixed(1);
  const uWickPips = (indicators.upperWick / (symbol.includes("JPY") ? 0.01 : 0.0001)).toFixed(1);
  const bodyPips = (indicators.body / (symbol.includes("JPY") ? 0.01 : 0.0001)).toFixed(1);

  return `ALLOWED: ${allowedActions.join(", ")}
SYM: ${symbol} | TF: ${granularity} | SESS: ${getForexSession()}
${htfContext}
${newsContext}
IND: EMA${emaFast}:${indicators[`ema${emaFast}`].toFixed(5)}, EMA${emaSlow}:${indicators[`ema${emaSlow}`].toFixed(5)}, RSI:${indicators.rsi.toFixed(1)}, ATR:${indicators.atr.toFixed(5)}, VWAP:${indicators.vwap.toFixed(5)}, PX:${px.toFixed(5)}
SLOPE: ${slopePips} pips, MOMENTUM: ${momPips} pips
BB: ${indicators.bbands.upper?.toFixed(5)}/${indicators.bbands.lower?.toFixed(5)}
WICKS: Lower:${lWickPips}, Upper:${uWickPips}, Body:${bodyPips} (pips)
MACD: Hist:${macdHist}, Signal:${macdSignal}
MANDATORY TARGETS:
- BUY: SL:${buySL.toFixed(5)}, TP:${buyTP.toFixed(5)}
- SELL: SL:${sellSL.toFixed(5)}, TP:${sellTP.toFixed(5)}
BARS: ${JSON.stringify(bars)}`;
}

function getForexSession() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  
  if (utcHour >= 8 && utcHour < 12) return "London Session (High Liquidity)";
  if (utcHour >= 12 && utcHour < 16) return "London/NY Overlap (Peak Volatility)";
  if (utcHour >= 16 && utcHour < 21) return "NY Session (High Volatility)";
  if (utcHour >= 21 || utcHour < 0) return "Asian Session (Lower Volatility)";
  if (utcHour >= 0 && utcHour < 8) return "Asian/Tokyo Session";
  return "Unknown";
}

// ─── Response parser (shared) ─────────────────────────────────────────────────

export function parseSignalResponse(text) {
  const content = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const jsonText = match[0];
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
        mirostat:    0,
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
        throw new Error(`Ollama request timed out after ${config.ollama.timeout}ms.`);
      }
      throw new Error(`Ollama connection failed — is Ollama running? (${err.message})`);
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
      system:     [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }
        }
      ],
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
      throw new Error("ANTHROPIC_API_KEY is not set.");
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
