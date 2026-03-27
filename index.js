#!/usr/bin/env node

/**
 * Forex Scalping Bot
 * OANDA + Claude AI Signal Pipeline
 *
 * Usage:
 *   node index.js                  → monitor only (manual trading)
 *   node index.js --auto-execute   → auto-execute signals
 *   node index.js --pair GBP_USD   → change pair (default EUR_USD)
 */

import Anthropic from "@anthropic-ai/sdk";
import { OandaClient } from "./oanda.js";
import { calculateIndicators } from "./indicators.js";
import { formatSignalAlert, formatTradeResult } from "./formatter.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const AUTO_EXECUTE = args.includes("--auto-execute");
const PAIR_ARG = args.indexOf("--pair");
const INSTRUMENT =
  PAIR_ARG !== -1 ? args[PAIR_ARG + 1] : config.defaultInstrument;

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const oanda = new OandaClient(config.oandaApiKey, config.oandaAccountId, config.oandaEnv);

let lastSignal = null;
let activeTradeId = null;

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function runScalpingLoop() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖 FOREX SCALPING BOT — Powered by Claude AI`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pair       : ${INSTRUMENT}`);
  console.log(`  Timeframe  : ${config.granularity}`);
  console.log(`  Mode       : ${AUTO_EXECUTE ? "🔴 AUTO-EXECUTE" : "🟡 MONITOR ONLY"}`);
  console.log(`  Interval   : every ${config.pollIntervalSeconds}s`);
  console.log(`${"═".repeat(60)}\n`);

  if (AUTO_EXECUTE) {
    console.log(
      "⚠️  AUTO-EXECUTE is ON. Trades will be placed automatically.\n"
    );
  }

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("❌ Error during tick:", err.message);
    }
    await sleep(config.pollIntervalSeconds * 1000);
  }
}

// ─── One Tick ────────────────────────────────────────────────────────────────

async function tick() {
  const timestamp = new Date().toLocaleTimeString();
  process.stdout.write(`[${timestamp}] Fetching candles...`);

  // 1. Fetch candle data
  const candles = await oanda.getCandles(INSTRUMENT, config.granularity, 100);
  if (!candles || candles.length < 50) {
    console.log(" ⚠️  Not enough candle data.");
    return;
  }

  // 2. Calculate indicators
  const indicators = calculateIndicators(candles);
  process.stdout.write(` ✓ | Asking Claude...`);

  // 3. Get Claude's signal
  const signal = await getClaudeSignal(INSTRUMENT, candles, indicators);
  console.log(` ✓`);

  // 4. Print the signal
  console.log(formatSignalAlert(signal, indicators, timestamp));

  // 5. Skip if same signal repeated or WAIT
  if (signal.action === "WAIT") {
    lastSignal = null;
    return;
  }

  if (lastSignal === signal.action) {
    console.log(`  ↩️  Same signal as before — skipping.\n`);
    return;
  }

  lastSignal = signal.action;

  // 6. Auto-execute if enabled
  if (AUTO_EXECUTE && signal.confidence >= config.minConfidenceToExecute) {
    await executeTrade(signal, indicators);
  } else if (AUTO_EXECUTE) {
    console.log(
      `  ⏸  Confidence ${signal.confidence}% below threshold (${config.minConfidenceToExecute}%) — skipping execution.\n`
    );
  }
}

// ─── Claude Signal ───────────────────────────────────────────────────────────

async function getClaudeSignal(instrument, candles, indicators) {
  const recent = candles.slice(-5).map((c) => ({
    time: c.time,
    open: c.mid.o,
    high: c.mid.h,
    low: c.mid.l,
    close: c.mid.c,
    volume: c.volume,
  }));

  const prompt = `You are an expert forex scalping analyst. Analyze the following data and provide a trading signal.

INSTRUMENT: ${instrument}
TIMEFRAME: ${config.granularity}
SESSION: ${getSession()}

INDICATORS:
- EMA 9:  ${indicators.ema9.toFixed(5)}
- EMA 21: ${indicators.ema21.toFixed(5)}
- RSI(14): ${indicators.rsi.toFixed(2)}
- ATR(14): ${indicators.atr.toFixed(5)}
- Current Price: ${indicators.currentPrice.toFixed(5)}
- EMA Trend: ${indicators.ema9 > indicators.ema21 ? "BULLISH (9 above 21)" : "BEARISH (9 below 21)"}

RECENT 5 CANDLES (newest last):
${JSON.stringify(recent, null, 2)}

Based on this data, respond with ONLY a valid JSON object (no markdown, no explanation) in this exact format:
{
  "action": "BUY" | "SELL" | "WAIT",
  "confidence": <number 0-100>,
  "entry": <price as number>,
  "stopLoss": <price as number>,
  "takeProfit": <price as number>,
  "reasoning": "<one concise sentence>"
}

Rules:
- Only signal BUY or SELL if confidence >= 60
- Stop loss should be 1.5x ATR from entry
- Take profit should be 2x ATR from entry (minimum 1:1.3 R:R)
- If RSI > 75 avoid BUY; if RSI < 25 avoid SELL
- If not in London or New York session, be more conservative`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text.trim();

  try {
    return JSON.parse(text);
  } catch {
    // Fallback if Claude adds any extra text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { action: "WAIT", confidence: 0, reasoning: "Parse error" };
  }
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(signal, indicators) {
  console.log(`\n  🚀 Executing ${signal.action} trade...`);

  try {
    // Close any existing trade first
    if (activeTradeId) {
      await oanda.closeTrade(activeTradeId);
      console.log(`  ✓ Closed previous trade #${activeTradeId}`);
      activeTradeId = null;
    }

    // Calculate position size based on risk config
    const accountInfo = await oanda.getAccount();
    const balance = parseFloat(accountInfo.balance);
    const riskAmount = balance * (config.riskPercentPerTrade / 100);
    const stopLossPips = Math.abs(signal.entry - signal.stopLoss) * 10000;
    const units = Math.floor(riskAmount / (stopLossPips * 0.0001));
    const finalUnits = signal.action === "SELL" ? -units : units;

    const trade = await oanda.createOrder({
      instrument: INSTRUMENT,
      units: finalUnits,
      stopLoss: signal.stopLoss.toFixed(5),
      takeProfit: signal.takeProfit.toFixed(5),
    });

    activeTradeId = trade.id;
    console.log(formatTradeResult(trade, signal, balance, units));
  } catch (err) {
    console.error(`  ❌ Trade execution failed: ${err.message}\n`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getSession() {
  const hour = new Date().getUTCHours();
  if (hour >= 7 && hour < 16) return "London";
  if (hour >= 13 && hour < 22) return "New York";
  if (hour >= 0 && hour < 8) return "Tokyo/Sydney";
  return "Off-hours";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Run ─────────────────────────────────────────────────────────────────────
runScalpingLoop().catch(console.error);
