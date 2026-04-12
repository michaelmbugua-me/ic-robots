#!/usr/bin/env node

/**
 * Forex Scalping Bot — IC Markets Edition
 * Local Ollama AI + IC Markets cTrader Open API
 *
 * Usage:
 *   node index.js                        → monitor only (EUR_USD default)
 *   node index.js --auto-execute         → auto-execute trades
 *   node index.js --pair GBP_USD         → trade a different pair (if enabled in config)
 *   node index.js --pair USD_JPY --auto-execute
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { calculateIndicators } from "./indicators.js";
import { formatSignalAlert, formatTradeResult } from "./formatter.js";
import { createAIClient, getSystemPrompt, getUserPrompt } from "./ai.js";
import { isNearHighImpactNews, getMarketNewsContext, FinnhubWSClient } from "./news.js";
import { config }          from "./config.js";

const args         = process.argv.slice(2);
const AUTO_EXECUTE = args.includes("--auto-execute");
const pairArg      = args.find(a => a.startsWith('--pair='))?.split('=')[1]
                   || (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null);
const PAIR         = pairArg || config.defaultInstrument;

const STATE_FILE = "state.json";
const icmarkets  = new ICMarketsClient();
const ai         = createAIClient();

let lastSignal    = null;
let activeTrades  = [];
let startingBalance = null;
let startingDay     = null;
let lastDailyPnL    = 0;
let lastLossTime    = 0; 

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  FOREX SCALPING BOT — Local AI + IC Markets`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pair       : ${PAIR}`);
  console.log(`  Timeframe  : ${config.granularity}`);
  console.log(`  Mode       : ${AUTO_EXECUTE ? "🔴 AUTO-EXECUTE" : "🟡 MONITOR ONLY"}`);
  console.log(`  Interval   : every ${config.pollIntervalSeconds}s`);
  console.log(`  Account    : ${config.ctraderEnv.toUpperCase()}`);
  console.log(`${"═".repeat(60)}\n`);

  if (AUTO_EXECUTE) {
    console.log("⚠️  AUTO-EXECUTE ON — trades will be placed automatically.\n");
  }

  // Connect and authenticate
  process.stdout.write("Connecting to IC Markets...");
  await icmarkets.connect();
  process.stdout.write(" ✓\nAuthenticating...");
  await icmarkets.authenticate();
  process.stdout.write(" ✓\nConnecting to AI...");
  await ai.healthCheck();
  process.stdout.write(" ✓\nConnecting to Finnhub News (WS)...");
  
  if (config.strategy.newsApiKey) {
    global.finnhubWsClient = new FinnhubWSClient(config.strategy.newsApiKey);
    global.finnhubWsClient.connect();
    process.stdout.write(" ✓\n\n");
  } else {
    process.stdout.write(" ⚠️  (Skipped - no API key)\n\n");
  }

  // Sync state and account
  loadState();
  await reconcileAccount();

  const account = await icmarkets.getAccount();
  startingBalance = parseFloat(account.balance);
  startingDay     = new Date().getUTCDate();

  // Main polling loop
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("❌ Tick error:", err.message);
    }
    await sleep(config.pollIntervalSeconds * 1_000);
  }
}

// ─── One Tick ────────────────────────────────────────────────────────────────

async function tick() {
  const timestamp = new Date().toLocaleTimeString();
  const now = new Date();

  // Reset starting balance if it's a new day (UTC)
  if (startingDay !== now.getUTCDate()) {
    const account = await icmarkets.getAccount();
    startingBalance = parseFloat(account.balance);
    startingDay = now.getUTCDate();
    console.log(`[${timestamp}] 🌅 New day — starting balance reset to $${startingBalance.toFixed(2)}`);
  }

  // Skip low-liquidity periods (outside London/NY sessions)
  const session = currentSession();
  if (session === "off") {
    console.log(`[${timestamp}] ⏸  Off-hours — waiting...`);
    return;
  }

  // 0. Daily Circuit Breaker
  const account = await icmarkets.getAccount();
  const currentBalance = parseFloat(account.balance);
  const dailyPnL = ((currentBalance - startingBalance) / startingBalance) * 100;

  if (dailyPnL <= -config.maxDailyLossPercent) {
    console.log(`[${timestamp}] 🛑 CIRCUIT BREAKER: Daily loss ${Math.abs(dailyPnL).toFixed(1)}% exceeded limit. Skipping trades.`);
    return;
  }

  // Cooldown check
  if (dailyPnL < lastDailyPnL) {
    lastLossTime = Date.now();
    console.log(`[${timestamp}] ⚠️  Loss detected ($${(currentBalance - (startingBalance * (1 + lastDailyPnL/100))).toFixed(2)}). Entering cooldown for ${config.lossCooldownMinutes} mins.`);
  }
  lastDailyPnL = dailyPnL;

  if (lastLossTime > 0) {
    const minsSinceLoss = (Date.now() - lastLossTime) / (60 * 1000);
    if (minsSinceLoss < config.lossCooldownMinutes) {
      console.log(`[${timestamp}] ⏸  COOLDOWN: Waiting ${Math.ceil(config.lossCooldownMinutes - minsSinceLoss)} more mins after loss.`);
      return;
    }
  }

  // 1. News Blocker Check
  if (config.strategy.newsBlocker) {
    const isNewsWindow = await isNearHighImpactNews(PAIR, config.strategy.newsBlockMinutesBefore, config.strategy.newsBlockMinutesAfter);
    if (isNewsWindow) {
      console.log(`[${timestamp}] ⏸  HIGH-IMPACT NEWS WINDOW — skipping trades.`);
      return;
    }
  }

  // 2. Spread Check
  try {
    const spread = await icmarkets.getSpread(PAIR);
    if (spread > config.maxSpreadPips) {
      console.log(`[${timestamp}] ⏸  HIGH SPREAD (${spread.toFixed(1)} pips) — skipping.`);
      return;
    }
  } catch (err) {
    console.warn(`[${timestamp}] ⚠️  Could not fetch spread: ${err.message}. Continuing...`);
  }

  process.stdout.write(`[${timestamp}] Fetching candles...`);
  
  // Multi-Timeframe Fetch
  const baseGranularity = config.granularity;
  const htfGranularity  = getHTFGranularity(baseGranularity);
  
  const [baseCandles, htfCandles] = await Promise.all([
    icmarkets.getCandles(PAIR, baseGranularity, 200),
    icmarkets.getCandles(PAIR, htfGranularity, 50).catch(() => null)
  ]);

  if (!baseCandles || baseCandles.length < 50) {
    console.log(" ⚠️  Not enough data.");
    return;
  }

  const indicators = calculateIndicators(baseCandles);
  const htfIndicators = htfCandles ? calculateIndicators(htfCandles) : null;

  const isJPY = PAIR.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;

  // Manage existing trades (Breakeven, etc.)
  await manageActiveTrades(indicators);

  // --- HARD FILTERS (Save AI tokens/latency) ---
  let possibleActions = ["BUY", "SELL", "WAIT"];

  // 0. ATR Volatility Floor
  const atrPips = indicators.atr / pipSize;
  if (atrPips < config.minAtrPips) {
    console.log(` ✓ | Skipping AI (Low Volatility: ${atrPips.toFixed(1)} pips)`);
    const signal = { action: "WAIT", confidence: 100, reasoning: "ATR below minimum floor" };
    processSignal(signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
    return;
  }

  // 0b. ADX Trend Strength Floor (filter choppy/ranging markets)
  if (indicators.adx !== null && indicators.adx < config.strategy.minAdx) {
    console.log(` ✓ | Skipping AI (Low ADX: ${indicators.adx.toFixed(1)} — choppy market)`);
    const signal = { action: "WAIT", confidence: 100, reasoning: "ADX below minimum — no trend conviction" };
    processSignal(signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
    return;
  }

  // 1. RSI Extreme filter
  const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;
  if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

  // 2. MTF Trend Filter
  if (htfIndicators) {
    const htfTrend = htfIndicators[`ema${emaFast}`] > htfIndicators[`ema${emaSlow}`] ? "UP" : "DOWN";
    if (htfTrend === "DOWN") possibleActions = possibleActions.filter(a => a !== "BUY");
    if (htfTrend === "UP")   possibleActions = possibleActions.filter(a => a !== "SELL");
  }

  // 3. Technical setup check (EMA Fast vs EMA Slow)
  if (indicators[`ema${emaFast}`] <= indicators[`ema${emaSlow}`]) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (indicators[`ema${emaFast}`] >= indicators[`ema${emaSlow}`]) possibleActions = possibleActions.filter(a => a !== "SELL");

  // 4. Falling Knife Filter (High Momentum against the trend)
  const momentumPips = Math.abs(indicators.momentum) / pipSize;
  const atrPipsForMom = indicators.atr / pipSize;
  const isSharpDrop = indicators.momentum < -1.2 * indicators.atr;
  const isSharpRise = indicators.momentum > 1.2 * indicators.atr;
  
  if (isSharpDrop) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (isSharpRise) possibleActions = possibleActions.filter(a => a !== "SELL");

  // 5. Distance check (Move up to skip AI if already too close to a trade)
  if (activeTrades.length > 0 && activeTrades.length < config.maxConcurrentTrades) {
      const tooClose = activeTrades.some(t => {
          const distPips = Math.abs(indicators.currentPrice - t.entryPrice) / pipSize;
          return distPips < config.minTradeDistancePips;
      });
      if (tooClose) {
          console.log(` ✓ | Skipping (Price too close to existing entry)`);
          const signal = { action: "WAIT", confidence: 100, reasoning: "Price distance too close" };
          processSignal(signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
          return;
      }
  }

  // --- TRIGGER LOGIC (Hybrid Mode) ---
  // RSI + BB zone check
  const isOverbought = indicators.rsi > rsiThresholdHigh && indicators.currentPrice > (indicators.bbands.upper - (0.5 * indicators.atr));
  const isOversold   = indicators.rsi < rsiThresholdLow  && indicators.currentPrice < (indicators.bbands.lower + (0.5 * indicators.atr));

  // Momentum confirmation: MACD histogram turning in entry direction
  const macdHist = indicators.macd.hist;
  const prevHist = indicators.prevMacdHist;
  const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
  const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

  // Confirmation gate: need at least ONE of: rejection candle, volume spike, or MACD turning
  const hasBuyConfirmation  = indicators.isBullishRejection || macdTurningBullish || indicators.volumeRatio >= (config.strategy.minVolumeRatio || 0.8);
  const hasSellConfirmation = indicators.isBearishRejection || macdTurningBearish || indicators.volumeRatio >= (config.strategy.minVolumeRatio || 0.8);

  const technicalAction = (isOversold  && hasBuyConfirmation  && possibleActions.includes("BUY"))  ? "BUY" :
                          (isOverbought && hasSellConfirmation && possibleActions.includes("SELL")) ? "SELL" : "WAIT";

  // Logic decision based on config.aiMode
  if (config.aiMode === "OFF") {
    console.log(` ✓ | Pure Technical Mode (Mock)... ${technicalAction}`);
    const signal = {
      action: technicalAction,
      confidence: 100,
      reasoning: "Pure technical trigger (AI OFF)"
    };
    processSignal(signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
    return;
  }

  if (config.aiMode === "HYBRID" && technicalAction === "WAIT") {
    console.log(` ✓ | Skipping AI (No technical trigger in HYBRID mode)`);
    const signal = { action: "WAIT", confidence: 100, reasoning: "No technical trigger" };
    processSignal(signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
    return;
  }

  // If we got here, we are either in ALWAYS mode OR HYBRID mode with a trigger
  process.stdout.write(` ✓ | Asking AI (${htfGranularity} Trend)...`);
  const startTime = Date.now();
  
  // Fetch news context if using Finnhub
  let newsContext = "";
  if (config.strategy.newsProvider === "finnhub" && config.strategy.newsApiKey) {
    newsContext = await getMarketNewsContext(5);
  }

  const signal = await getAISignal(PAIR, baseCandles, indicators, htfIndicators, possibleActions, newsContext);
  const latency = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(` ✓ (${latency}s)`);

  processSignal(signal, indicators, timestamp, htfIndicators, latency, possibleActions);
}

/**
 * Manage active trades (Trailing Stop / Breakeven)
 */
async function manageActiveTrades(indicators) {
  if (activeTrades.length === 0 || !config.useBreakeven || !AUTO_EXECUTE) return;

  const currentPX = indicators.currentPrice;
  const isJPY = PAIR.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const atr = indicators.atr;

  for (const trade of activeTrades) {
    const profitPips = trade.direction === "BUY"
      ? (currentPX - trade.entryPrice) / pipSize
      : (trade.entryPrice - currentPX) / pipSize;
    
    const triggerPips = (atr * config.breakevenTriggerATR) / pipSize;

    if (profitPips >= triggerPips) {
      let newSL;

      if (config.useTrailingStop) {
        // Trailing stop: trail at X * ATR behind the current price
        const trailDist = atr * (config.trailingStopATR || 1.5);
        newSL = trade.direction === "BUY" ? currentPX - trailDist : currentPX + trailDist;

        // Ensure trailing SL is at least at entry + buffer (commission cover)
        const buffer = 1.0 * pipSize;
        const minSL = trade.direction === "BUY" ? trade.entryPrice + buffer : trade.entryPrice - buffer;
        if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
        if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;

        // Only move SL forward, never backward
        const currentSL = trade.currentSL || (trade.direction === "BUY" ? 0 : Infinity);
        const shouldUpdate = trade.direction === "BUY" ? newSL > currentSL : newSL < currentSL;
        if (!shouldUpdate) continue;
      } else {
        // Flat breakeven: move SL to entry + 1 pip buffer
        if (trade.isBreakeven) continue;
        const buffer = 1.0 * pipSize;
        newSL = trade.direction === "BUY" ? trade.entryPrice + buffer : trade.entryPrice - buffer;
      }

      const logAction = trade.isBreakeven ? "Trailing SL" : "Moving SL to breakeven+trail";
      console.log(`  🛡️  Trade ${trade.id}: ${logAction} (profit: ${profitPips.toFixed(1)} pips, new SL: ${newSL.toFixed(5)})`);

      try {
        await icmarkets.amendPositionSLTP(trade.id, newSL, undefined);
        trade.isBreakeven = true;
        trade.currentSL = newSL;
        saveState();
      } catch (err) {
        console.error(`  ❌ Failed to move SL for ${trade.id}:`, err.message);
      }
    }
  }
}

/**
 * Process the signal (validation + execution)
 */
async function processSignal(signal, indicators, timestamp, htfIndicators = null, latency = "0.0", allowedActions = ["BUY", "SELL", "WAIT"]) {
  // 1. Hard Verification (Prevent AI Hallucinations)
  if (signal.action !== "WAIT") {
    let failedRule = null;
    
    // Check if action was even allowed
    if (!allowedActions.includes(signal.action)) {
      failedRule = `Action ${signal.action} not allowed by hard filters`;
    }
    
    const { emaFast, emaSlow, atrMultiplierSL, atrMultiplierTP } = config.strategy;
    
    // Check basic EMA rules
    if (signal.action === "BUY") {
      if (indicators[`ema${emaFast}`] <= indicators[`ema${emaSlow}`]) failedRule = `EMA${emaFast} <= EMA${emaSlow} (Bearish Cross)`;
    } else if (signal.action === "SELL") {
      if (indicators[`ema${emaFast}`] >= indicators[`ema${emaSlow}`]) failedRule = `EMA${emaFast} >= EMA${emaSlow} (Bullish Cross)`;
    }

    if (failedRule) {
      const originalAction = signal.action;
      console.log(`  🔧  AI ${originalAction} REJECTED: ${failedRule}. Forcing WAIT.`);
      signal.action = "WAIT";
      signal.confidence = 0;
      signal.reasoning = `Rejected by bot safety verification: ${failedRule}. AI suggested ${originalAction} despite rules.`;
    }
  }

  // 2. Price Sanity Check (Prevent Hallucinations)
  const currentPX = indicators.currentPrice;
  const isJPY = PAIR.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const atr = indicators.atr || 0;

  // Pre-calculate safe SL/TP based on ATR
  const minDistance = Math.max(
    pipSize * config.minStopDistancePips,
    atr * config.atrMultiplierFloor
  );
  
  // Calculate our "ideal" levels
  const { atrMultiplierSL, atrMultiplierTP } = config.strategy;
  const idealSLDist = Math.max(minDistance, atr * atrMultiplierSL);
  const idealTPDist = Math.max(minDistance, atr * atrMultiplierTP);

  if (signal.action !== "WAIT") {
    // Check entry price hallucination
    const MAX_ENTRY_DEV = config.maxPriceDeviationPercent / 100;
    const deviation = Math.abs(signal.entry - currentPX) / currentPX;
    if (deviation > MAX_ENTRY_DEV) {
      console.log(`  ⚠️  AI entry price (${signal.entry}) deviates too much from market (${currentPX.toFixed(5)}). Correction applied.`);
      signal.entry = currentPX; // Force current price
    }

    // Force-Correct SL/TP levels to ensure safety and logic
    // We already have ideal distances from ATR calculated above.
    // We only force-correct if the AI's levels are non-existent or clearly illogical (e.g. SL on wrong side)
    const slDist = Math.abs(signal.stopLoss - signal.entry);
    const tpDist = Math.abs(signal.takeProfit - signal.entry);
    
    const isIllogical = (signal.action === "BUY" && (signal.stopLoss >= signal.entry || signal.takeProfit <= signal.entry)) ||
                        (signal.action === "SELL" && (signal.stopLoss <= signal.entry || signal.takeProfit >= signal.entry));
    
    const isTooFar = slDist > (currentPX * 0.05) || tpDist > (currentPX * 0.05); // 5% away is crazy for a scalper
    const isTooClose = slDist < minDistance || tpDist < minDistance;
    const oldSL = signal.stopLoss;
    const oldTP = signal.takeProfit;

    if (!signal.stopLoss || !signal.takeProfit || isIllogical || isTooFar || isTooClose) {
      console.log(`  🔧  AI SL/TP levels were missing or illogical. Using ATR-based targets.`);
      if (signal.action === "BUY") {
        signal.stopLoss = parseFloat((signal.entry - idealSLDist).toFixed(5));
        signal.takeProfit = parseFloat((signal.entry + idealTPDist).toFixed(5));
      } else if (signal.action === "SELL") {
        signal.stopLoss = parseFloat((signal.entry + idealSLDist).toFixed(5));
        signal.takeProfit = parseFloat((signal.entry - idealTPDist).toFixed(5));
      }
    }

    // Log correction if it was significant
    const wasCorrected = !oldSL || !oldTP || 
                         Math.abs(oldSL - signal.stopLoss) > 0.00001 || 
                         Math.abs(oldTP - signal.takeProfit) > 0.00001;

    if (wasCorrected) {
      console.log(`  🔧  SL/TP auto-corrected to ATR-safe levels (ATR: ${atr.toFixed(5)}).`);
    }
  }

  console.log(formatSignalAlert(PAIR, signal, indicators, timestamp, latency));
  
  // Distinguish AI parse errors or empty responses in logs
  if (signal.reasoning === "Parse error" || signal.reasoning === "Empty AI response") {
    logActivity("error", { type: "ai_failure", reason: signal.reasoning, model: config.ollama.model });
  } else {
    logActivity("signal", { pair: PAIR, ...signal, indicators });
  }

  if (signal.action === "WAIT") return;

  const isFlip = lastSignal && lastSignal !== signal.action;
  lastSignal = signal.action;

  // 1. If signal flips (e.g. BUY -> SELL), we must act immediately (close all opposite)
  if (isFlip) {
      console.log(`  🔄  Signal FLIPPED to ${signal.action}. Closing all existing positions.`);
      await reconcileAccount(); // Run reconcile on every flip to ensure fresh state
  } else {
      // 2. If same signal, check if we have room for more trades
      if (activeTrades.length >= config.maxConcurrentTrades) {
          console.log(`  ⏸  Max concurrent trades (${config.maxConcurrentTrades}) reached. Holding.`);
          logActivity("skip", { pair: PAIR, action: signal.action, reason: "Max concurrent trades reached", count: activeTrades.length });
          return;
      }
      // Note: Price distance check moved to tick() to save AI latency
  }

  // Dry run calculation
  if (!AUTO_EXECUTE) {
    try {
      const units = await calculateUnits(signal, indicators);
      const account    = await icmarkets.getAccount();
      const balance    = parseFloat(account.balance) / 100;
      const riskAmount = balance * (config.riskPercentPerTrade / 100);

      console.log(`  🔍 DRY RUN: Would trade ${units} units (Risk: $${riskAmount.toFixed(2)})\n`);
    } catch (err) {
      console.log(`  ⚠️  DRY RUN calc failed: ${err.message}`);
    }
    return;
  }

  if (AUTO_EXECUTE && signal.confidence >= config.minConfidenceToExecute) {
    // 3. Sentiment Filter
    if (signal.sentimentScore !== undefined && signal.sentimentScore < config.strategy.minSentimentConfidence) {
      console.log(`  ⏸  Sentiment ${signal.sentimentScore}% < threshold ${config.strategy.minSentimentConfidence}% — skipping.\n`);
      return;
    }
    await executeTrade(signal, indicators);
  } else if (AUTO_EXECUTE) {
    console.log(
      `  ⏸  Confidence ${signal.confidence}% < threshold ${config.minConfidenceToExecute}% — skipping.\n`
    );
  }
}

// ─── AI Signal (Ollama/Claude) ───────────────────────────────────────────────

async function getAISignal(pair, candles, indicators, htfIndicators = null, allowedActions = ["BUY", "SELL", "WAIT"], newsHeadlines = "") {
  const systemPrompt = getSystemPrompt(pair);
  const userPrompt = getUserPrompt(pair, config.granularity, indicators, candles.slice(-30), htfIndicators, allowedActions, newsHeadlines);
  return await ai.getSignal(systemPrompt, userPrompt);
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(signal, indicators) {
  console.log(`\n  🚀  Executing ${signal.action} on ${PAIR}...`);

  try {
    // 1. Check for signal flip — close all opposite positions
    const oppositeDirection = signal.action === "BUY" ? "SELL" : "BUY";
    const tradesToClose = activeTrades.filter(t => t.direction === oppositeDirection);

    if (tradesToClose.length > 0) {
      console.log(`  ⏳  Closing ${tradesToClose.length} opposite position(s)...`);
      for (const t of tradesToClose) {
        try {
          await icmarkets.closeTrade(t.id);
          activeTrades = activeTrades.filter(at => at.id !== t.id);
          console.log(`     ✓ Closed ${t.id}`);
        } catch (err) {
          const errMsg = err.message.toLowerCase();
          if (errMsg.includes("not found") || errMsg.includes("already closed") || errMsg.includes("invalid position id")) {
             activeTrades = activeTrades.filter(at => at.id !== t.id);
             console.log(`     ✓ Closed ${t.id} (already gone)`);
          } else {
             console.error(`     ❌ Could not close ${t.id}: ${err.message}`);
             console.error(`  ⚠️  Aborting new trade to prevent hedging.`);
             saveState();
             return;
          }
        }
      }
      saveState();
    }

    // 2. Final capacity check
    if (activeTrades.length >= config.maxConcurrentTrades) {
      console.log(`  ⏸  Max concurrent trades reached (${activeTrades.length}). Skipping.`);
      return;
    }

    const units = await calculateUnits(signal, indicators);
    if (!units) return;

    const account    = await icmarkets.getAccount();
    const balance    = parseFloat(account.balance) / 100;
    const finalUnits = signal.action === "SELL" ? -units : units;

    const trade = await icmarkets.createOrder({
      instrument: PAIR,
      units:      finalUnits,
      stopLoss:   signal.stopLoss.toFixed(5),
      takeProfit: signal.takeProfit.toFixed(5),
      entryPrice: signal.entry,
    });

    activeTrades.push({
        id: String(trade.id),
        entryPrice: parseFloat(trade.price),
        direction: signal.action,
        isBreakeven: false
    });
    saveState();
    
    console.log(formatTradeResult(trade, signal, balance, units));
    console.log(`  ℹ️  Initial P&L may be negative due to spread & commission.\n`);

    logActivity("trade", {
      pair:       PAIR,
      action:     signal.action,
      units,
      price:      trade.price,
      stopLoss:   signal.stopLoss,
      takeProfit: signal.takeProfit,
      indicators,
    });

  } catch (err) {
    console.error(`  ❌  Trade failed: ${err.message}\n`);
  }
}

async function calculateUnits(signal, indicators) {
  const account    = await icmarkets.getAccount();
  const balance    = parseFloat(account.balance) / 100;
  const riskAmount = balance * (config.riskPercentPerTrade / 100);
  const slDistance = Math.abs(signal.entry - signal.stopLoss);

  // Convert risk amount to units
  const isJPY = PAIR.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const slPips  = slDistance / pipSize;
  
  // Dynamic Pip Value (USD per lot)
  // For EUR/USD on USD account, it is $10. For others, it varies.
  const rate = indicators ? indicators.currentPrice : signal.entry;
  
  // Professional calculation of pip value in account currency (assuming USD account)
  let pipValue = 10; // Default for EUR/USD, GBP/USD, etc.
  if (PAIR.startsWith("USD/")) {
    // e.g. USD/JPY, USD/CAD -> Base is account currency
    pipValue = (pipSize / rate) * 100_000;
  } else if (!PAIR.endsWith("/USD") && !PAIR.endsWith("_USD")) {
    // Cross pair, e.g. EUR/GBP -> we'd need another rate. 
    // For now, let's use the user's recommended formula as a fallback for non-USD-quote pairs
    pipValue = (pipSize / rate) * 100_000;
  }

  const lots = riskAmount / (slPips * pipValue);
  let units     = Math.floor(lots * 100_000);

  // Apply Hard Max Limit
  if (units > config.maxPositionSizeUnits) {
    console.log(`  ⚠️  Position size ${units} exceeded max limit (${config.maxPositionSizeUnits}). Capped.`);
    units = config.maxPositionSizeUnits;
  }

  // Apply symbol rules
  const symbol = await icmarkets.getSymbol(PAIR);
  if (symbol.stepVolume > 0) {
    units = Math.floor(units / symbol.stepVolume) * symbol.stepVolume;
  }
  if (units < symbol.minVolume) {
    console.log(`  ⚠️  Position size ${units} too small (min: ${symbol.minVolume}) — skipping.\n`);
    return 0;
  }
  return units;
}

// ─── Session & Helpers ───────────────────────────────────────────────────────

function currentSession() {
  const h = utcHour();
  if (h >= 8  && h < 18) return h >= 13 && h < 16 ? "London+NY overlap (best liquidity)" :
                                h >= 8  && h < 13  ? "London session" :
                                                     "New York session";
  return "off";
}

function utcHour() {
  return new Date().getUTCHours();
}

function getHTFGranularity(base) {
  const map = {
    "M1": "M5",
    "M5": "M15",
    "M15": "H1",
    "M30": "H4",
    "H1": "H4"
  };
  return map[base] || "H1";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      activeTrades = data.activeTrades || [];
      if (activeTrades.length > 0) {
        console.log(`  📂  Loaded previous state: ${activeTrades.length} Active Trade(s)`);
      }
    } catch (err) {
      console.error("  ⚠️  Failed to load state.json:", err.message);
    }
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ activeTrades, lastUpdated: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error("  ⚠️  Failed to save state.json:", err.message);
  }
}

async function reconcileAccount() {
  process.stdout.write("  🔄  Syncing account positions...");
  try {
    const positions = await icmarkets.reconcile();
    const symbolId = icmarkets._resolveSymbolId(PAIR);
    
    // Find all open positions for our PAIR
    const pairPositions = positions.filter(p => p.tradeData && String(p.tradeData.symbolId) === String(symbolId));
    
    const syncedTrades = [];
    for (const pos of pairPositions) {
        const brokerPosId = String(pos.positionId);
        const entryPrice = parseFloat(pos.price || pos.entryPrice);
        const direction = pos.tradeData.tradeSide === "BUY" ? "BUY" : "SELL";
        const stopLoss = pos.stopLoss ? parseFloat(pos.stopLoss) : null;
        
        // Breakeven check: Has SL been moved to or beyond entry price?
        const isBreakeven = stopLoss !== null && (direction === "BUY" ? stopLoss >= entryPrice : stopLoss <= entryPrice);
        
        syncedTrades.push({ id: brokerPosId, entryPrice, direction, isBreakeven });
    }

    // Robust Comparison
    const currentIds = activeTrades.map(t => t.id).sort().join(",");
    const syncedIds = syncedTrades.map(t => t.id).sort().join(",");

    if (currentIds !== syncedIds) {
        console.log(`\n  ✅  Account out of sync. Reconciled ${syncedTrades.length} position(s).`);
        activeTrades = syncedTrades;
        saveState();
    } else {
        console.log(" ✓ (Matches local state)");
    }
  } catch (err) {
    console.error(`\n  ❌  Reconciliation failed: ${err.message}. Using local state.`);
  }
}

function logActivity(type, data) {
  // Deep round numeric values for clean logs
  const cleanData = JSON.parse(JSON.stringify(data, (key, value) => 
    typeof value === "number" ? Number(value.toFixed(5)) : value
  ));

  const entry = JSON.stringify({ timestamp: new Date().toISOString(), type, ...cleanData }) + "\n";
  try {
    fs.appendFileSync("activity.log", entry);
  } catch (err) {
    console.error("Failed to write to activity.log", err.message);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────
run().catch(console.error);
