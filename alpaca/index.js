#!/usr/bin/env node

/**
 * Scalping Bot — Alpaca Edition
 * Supports both US Stocks and Crypto
 * AI: Ollama (local) or Anthropic Claude (cloud)
 *
 * Usage:
 *   node index.js                          → monitor only (default symbol)
 *   node index.js --auto-execute           → auto-execute signals
 *   node index.js --symbol TSLA            → trade a specific stock
 *   node index.js --symbol BTC/USD         → trade crypto (24/7)
 *   node index.js --symbol ETH/USD --auto-execute
 *
 * AI provider is set via AI_PROVIDER env var or config.js:
 *   AI_PROVIDER=ollama     (default — local, free)
 *   AI_PROVIDER=anthropic  (cloud — requires API key)
 */

import fs from "fs";
import { AlpacaClient, isCrypto } from "./alpaca.js";
import { calculateIndicators } from "./indicators.js";
import { formatSignalAlert, formatTradeResult } from "./formatter.js";
import { createAIClient, getSystemPrompt, getUserPrompt } from "./ai.js";
import { config } from "./config.js";

// ─── CLI Args ─────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const AUTO_EXECUTE = args.includes("--auto-execute");
const symIdx       = args.indexOf("--symbol");
const SYMBOL       = symIdx !== -1 ? args[symIdx + 1] : config.defaultInstrument;
const IS_CRYPTO    = isCrypto(SYMBOL);

// ─── Clients ──────────────────────────────────────────────────────────────────

const ai     = createAIClient();
const alpaca = new AlpacaClient();

// ─── State ────────────────────────────────────────────────────────────────────

let lastSignal    = null;
let activeTradeId = null;
let isProcessing  = false;

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function runScalpingLoop() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖 SCALPING BOT — ${config.aiProvider === "ollama" ? `Ollama (${config.ollama.model})` : "Claude AI"} + Alpaca`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Symbol     : ${SYMBOL}`);
  console.log(`  Type       : ${IS_CRYPTO ? "Crypto (24/7)" : "US Stock"}`);
  console.log(`  Timeframe  : ${config.granularity}`);
  console.log(`  Mode       : ${AUTO_EXECUTE ? "🔴 AUTO-EXECUTE" : "🟡 MONITOR ONLY"}`);
  console.log(`  Interval   : Event-driven (WebSocket)`);
  console.log(`  Account    : ${config.alpacaEnv.toUpperCase()}`);
  console.log(`  AI         : ${config.aiProvider === "ollama" ? `Ollama → ${config.ollama.model}` : "Anthropic Claude"}`);
  console.log(`${"═".repeat(60)}\n`);

  if (AUTO_EXECUTE) {
    console.log("⚠️  AUTO-EXECUTE is ON. Trades will be placed automatically.\n");
  }

  // ─── Health check AI provider ─────────────────────────────────────────────
  process.stdout.write(`  🔌 Connecting to ${config.aiProvider}...`);
  try {
    await ai.healthCheck();
    console.log(" ✓\n");
  } catch (err) {
    console.log(" ✗\n");
    console.error(`  ❌ ${err.message}\n`);
    process.exit(1);
  }

  // ─── Sync existing positions ───────────────────────────────────────────────
  try {
    const positions = await alpaca.getOpenPositions();
    const existing  = positions.find((p) => p.symbol === SYMBOL);
    if (existing) {
      console.log(`  🔗 Found existing position: ${existing.qty} units of ${SYMBOL}.`);
      activeTradeId = existing.id || SYMBOL;
    }
  } catch (err) {
    console.warn("  ⚠️  Could not sync existing positions:", err.message);
  }

  console.log(`  📡 Starting WebSocket streams for ${SYMBOL}...`);

  // ─── Start Streams ────────────────────────────────────────────────────────

  // Trading stream for order/position updates
  alpaca.connectTradingStream((update) => {
    if (update.event === "fill") {
      const { side, qty, filled_avg_price } = update.order;
      console.log(`\n  🔔 Trade filled: ${side.toUpperCase()} ${qty} @ ${filled_avg_price}`);
    }
    if (update.event === "terminated" || update.event === "fill") {
      // If it was our active trade being closed or filled
      if (update.order.symbol === SYMBOL) {
         // Reset activeTradeId if it's a closing side or if we want to allow new trades
         // For scalping, we usually wait for the position to be flat.
      }
    }
  });

  // Market data stream for bar updates (Trigger)
  alpaca.connectDataStream(SYMBOL, (bar) => {
    tick().catch(err => console.error("❌ Tick error:", err.message));
  });

  console.log(`  🚀 Bot is live and event-driven. Waiting for market data...\n`);

  // Trigger initial tick immediately so we don't wait 60s for the first bar
  tick().catch(err => console.error("❌ Initial tick error:", err.message));

  // Keep process alive
  setInterval(() => {}, 60000);
}

// ─── One Tick ────────────────────────────────────────────────────────────────

async function tick() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const timestamp = new Date().toLocaleTimeString();

    // For stocks: skip outside market hours
    if (!IS_CRYPTO) {
      const open = alpaca.isMarketOpenLocal();
      if (!open) {
        isProcessing = false;
        return;
      }
    }

  process.stdout.write(`[${timestamp}] Fetching bars...`);

  // Parallelize fetching bars, refreshing account balance, and syncing positions
  const [candles, _account, posData] = await Promise.all([
    alpaca.getCandles(SYMBOL, config.granularity, 200),
    alpaca.getAccount(), // Refresh cache if needed while we wait for network bars
    alpaca.getOpenPositions()
  ]);

  // Sync position state (ground truth)
  const existing = posData.find(p => p.symbol === SYMBOL);
  activeTradeId = existing ? SYMBOL : null;

  if (!candles || candles.length < 50) {
    console.log(" ⚠️  Not enough bar data.");
    return;
  }

  const indicators = calculateIndicators(candles);
  process.stdout.write(` ✓ | Asking AI...`);

  const signal = await getAISignal(SYMBOL, candles, indicators);
  console.log(` ✓`);

  // Basic sanity check on signal values
  if (signal.action !== "WAIT") {
    const slDistance = Math.abs(signal.entry - signal.stopLoss);
    const tpDistance = Math.abs(signal.entry - signal.takeProfit);

    // Minimum distance based on ATR or hard floor
    const minDistance = Math.max(0.1, (indicators.atr || 0) * 0.3);

    if (slDistance < minDistance || tpDistance < minDistance) {
      console.log(`  ⚠️  AI returned invalid SL/TP distances (SL: ${slDistance.toFixed(4)}, TP: ${tpDistance.toFixed(4)}, min req: ${minDistance.toFixed(4)}). Skipping.`);
      signal.action = "WAIT";
      signal.reasoning = "Invalid SL/TP distances from AI (too close to entry)";
    }
    
    // Direction check
    if (signal.action === "BUY" && (signal.takeProfit <= signal.entry + minDistance || signal.stopLoss >= signal.entry - minDistance)) {
        console.log(`  ⚠️  AI returned invalid BUY levels (TP: ${signal.takeProfit}, SL: ${signal.stopLoss}, Entry: ${signal.entry}, min dist: ${minDistance.toFixed(4)}). Skipping.`);
        signal.action = "WAIT";
    }
    if (signal.action === "SELL" && (signal.takeProfit >= signal.entry - minDistance || signal.stopLoss <= signal.entry + minDistance)) {
        console.log(`  ⚠️  AI returned invalid SELL levels (TP: ${signal.takeProfit}, SL: ${signal.stopLoss}, Entry: ${signal.entry}, min dist: ${minDistance.toFixed(4)}). Skipping.`);
        signal.action = "WAIT";
    }

    // Profitability check (Fee awareness)
    const feeRate = IS_CRYPTO ? config.cryptoFeeRate : config.stockFeeRate;
    if (feeRate > 0 && signal.action !== "WAIT") {
      const roundTripFee = signal.entry * feeRate * 2;
      const expectedProfit = Math.abs(signal.takeProfit - signal.entry);
      
      if (expectedProfit <= roundTripFee * 1.2) { // Must be at least 20% more than fees to be worth it
        console.log(`  ⚠️  Expected profit ($${expectedProfit.toFixed(4)}) barely covers round-trip fees ($${roundTripFee.toFixed(4)}). Skipping.`);
        signal.action = "WAIT";
        signal.reasoning = `Profit target too small relative to exchange fees (${(feeRate*200).toFixed(2)}% round-trip)`;
      }
    }
  }

  console.log(formatSignalAlert(signal, indicators, timestamp));
  logActivity("signal", { symbol: SYMBOL, ...signal });

  if (signal.action === "WAIT") {
    // If we are in a Crypto position and AI says WAIT, we must exit manually
    // because Alpaca does not support bracket orders for Crypto.
    if (IS_CRYPTO && activeTradeId) {
       console.log(`  ⏹  AI says WAIT (Crypto). Closing position...`);
       try { await alpaca.closeTrade(activeTradeId); } catch (e) {}
       activeTradeId = null;
    }
    lastSignal = null;
    return;
  }

  if (lastSignal === signal.action) {
    // For Crypto: Since we don't have bracket orders, we check SL/TP hit manually on every bar.
    if (IS_CRYPTO && activeTradeId) {
      const px = indicators.currentPrice;
      const sl = signal.stopLoss;
      const tp = signal.takeProfit;
      const isBuy = signal.action === "BUY";

      // Check if price has touched or crossed our SL/TP levels
      const hitSL = isBuy ? (px <= sl) : (px >= sl);
      const hitTP = isBuy ? (px >= tp) : (px <= tp);

      if (hitSL || hitTP) {
        console.log(`  🎯 Crypto ${hitSL ? "SL" : "TP"} Hit! (${px} vs SL:${sl}, TP:${tp}). Closing position...`);
        try { await alpaca.closeTrade(activeTradeId); } catch (e) {}
        activeTradeId = null;
        lastSignal = null;
        return;
      }
    }
    console.log(`  ↩️  Same signal as before — skipping.\n`);
    return;
  }

  lastSignal = signal.action;

  // Dry run calculation
  if (!AUTO_EXECUTE) {
    try {
      const accountInfo = await alpaca.getAccount();
      const balance     = accountInfo.balance;
      const riskAmount  = balance * (config.riskPercentPerTrade / 100);
      const slDistance  = Math.max(0.1, Math.abs(signal.entry - signal.stopLoss));
      let units = IS_CRYPTO
        ? parseFloat((riskAmount / slDistance).toFixed(6))
        : Math.max(1, Math.floor(riskAmount / slDistance));
      
      // Cap units to available balance (with 5% buffer)
      const maxNotional = balance * 0.95;
      const maxUnits = IS_CRYPTO 
        ? parseFloat((maxNotional / signal.entry).toFixed(6))
        : Math.floor(maxNotional / signal.entry);
      
      if (units > maxUnits) {
        units = maxUnits;
      }

      const feeRate = IS_CRYPTO ? config.cryptoFeeRate : config.stockFeeRate;
      const estFee  = signal.entry * units * feeRate;

      console.log(`  🔍 DRY RUN: Would trade ${units} units (Risk: $${riskAmount.toFixed(2)}, Est. Fee: $${estFee.toFixed(2)})\n`);
    } catch {
      // Ignore account errors in dry-run
    }
    return;
  }

    if (signal.confidence >= config.minConfidenceToExecute) {
      await executeTrade(signal, indicators);
    } else {
      console.log(
        `  ⏸  Confidence ${signal.confidence}% below threshold (${config.minConfidenceToExecute}%) — skipping.\n`
      );
    }
  } finally {
    isProcessing = false;
  }
}

// ─── AI Signal ───────────────────────────────────────────────────────────────

async function getAISignal(symbol, candles, indicators) {
  const recentBars = candles.slice(-5).map((c) => ({
    time:   c.time,
    open:   c.mid.o,
    high:   c.mid.h,
    low:    c.mid.l,
    close:  c.mid.c,
    volume: c.volume,
  }));

  const systemPrompt = getSystemPrompt(IS_CRYPTO);
  const userPrompt   = getUserPrompt(symbol, config.granularity, IS_CRYPTO, indicators, recentBars);

  try {
    return await ai.getSignal(systemPrompt, userPrompt);
  } catch (err) {
    console.error(`\n  ❌ AI error: ${err.message}`);
    return { action: "WAIT", confidence: 0, reasoning: `AI error: ${err.message}` };
  }
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(signal, indicators) {
  console.log(`\n  🚀 Executing ${signal.action} trade on ${SYMBOL}...`);

  try {
    const side = signal.action === "BUY" ? "buy" : "sell";
    
    // 1. Get current market price right before placing order
    const currentPrice = await alpaca.getLatestPrice(SYMBOL, side);
    if (!currentPrice) {
      console.log(`  ⚠️  Could not fetch current price. Aborting.`);
      return;
    }
    
    // 2. Calculate a "Safe Limit Price"
    //    For a bracket order to be accepted, TP/SL must be on the correct side 
    //    of the entry price. We use a limit order to ensure our entry price 
    //    guarantees this, even if the market moves.
    const buffer = 0.05; 
    let limitPrice;

    if (signal.action === "BUY") {
      // Limit price must be at least 0.01 BELOW TP and 0.01 ABOVE SL.
      // We also want it to be close to the current market price so it fills.
      limitPrice = Math.min(currentPrice + buffer, signal.takeProfit - 0.02);
      
      if (limitPrice <= signal.stopLoss + 0.02) {
        console.log(`  ⚠️  Market moved too far! BUY TP/SL range is now invalid. Aborting.`);
        return;
      }
    } else {
      // SELL: Limit price must be at least 0.01 ABOVE TP and 0.01 BELOW SL.
      limitPrice = Math.max(currentPrice - buffer, signal.takeProfit + 0.02);
      
      if (limitPrice >= signal.stopLoss - 0.02) {
        console.log(`  ⚠️  Market moved too far! SELL TP/SL range is now invalid. Aborting.`);
        return;
      }
    }

    // 3. Close any existing position first
    if (activeTradeId) {
      try {
        await alpaca.closeTrade(activeTradeId);
      } catch (err) {
        // If it's a 404, the position is already closed (manual or by bracket)
        if (!err.message.includes("404")) {
          console.warn(`  ⚠️  Error closing previous position: ${err.message}`);
        }
      }
    }
    
    // 4. Get account info (likely cached from tick())
    const accountInfo = await alpaca.getAccount();

    const balance    = accountInfo.balance;
    const riskAmount = balance * (config.riskPercentPerTrade / 100);
    const slDistance = Math.max(0.1, Math.abs(limitPrice - signal.stopLoss));

    let units = IS_CRYPTO
      ? parseFloat((riskAmount / slDistance).toFixed(6))
      : Math.max(1, Math.floor(riskAmount / slDistance));

    // Cap units to available balance (with 5% buffer)
    const maxNotional = balance * 0.95;
    const maxUnits = IS_CRYPTO 
      ? parseFloat((maxNotional / limitPrice).toFixed(6))
      : Math.floor(maxNotional / limitPrice);
    
    if (units > maxUnits) {
      console.log(`  ⚠️  Risk units (${units}) exceed available balance. Capping to ${maxUnits} units.`);
      units = maxUnits;
    }

    if (units <= 0) {
      console.log(`  ⚠️  Not enough balance to place even the smallest trade. Aborting.`);
      return;
    }

    const finalUnits = signal.action === "SELL" ? -units : units;

    const trade = await alpaca.createOrder({
      symbol:     SYMBOL,
      units:      finalUnits,
      stopLoss:   signal.stopLoss.toFixed(IS_CRYPTO ? 6 : 2),
      takeProfit: signal.takeProfit.toFixed(IS_CRYPTO ? 6 : 2),
      type:       "limit",
      price:      limitPrice,
    });

    activeTradeId = trade.id;
    const feeRate = IS_CRYPTO ? config.cryptoFeeRate : config.stockFeeRate;

    console.log(formatTradeResult(trade, signal, balance, units, feeRate));

    logActivity("trade", {
      symbol:     SYMBOL,
      action:     signal.action,
      units,
      price:      signal.entry,
      stopLoss:   signal.stopLoss,
      takeProfit: signal.takeProfit,
    });

  } catch (err) {
    console.error(`  ❌ Trade execution failed: ${err.message}\n`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logActivity(type, data) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), type, ...data }) + "\n";
  fs.appendFileSync("activity.log", entry);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

runScalpingLoop().catch(console.error);
