#!/usr/bin/env node

/**
 * Forex Scalping Bot — IC Markets Edition
 * Pure Technical Indicators + IC Markets cTrader Open API
 *
 * Usage:
 *   node index.js                        → monitor all tradingPairs (default: EUR_USD, GBP_USD)
 *   node index.js --auto-execute         → auto-execute trades
 *   node index.js --pair GBP_USD         → single pair only
 *   node index.js --pair EUR_USD,GBP_USD,USD_JPY --auto-execute
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

// Multi-pair: --pair EUR_USD,GBP_USD or default from config.tradingPairs
const PAIRS = pairArg
  ? pairArg.split(",").map(s => s.trim())
  : config.tradingPairs || [config.defaultInstrument];

const STATE_FILE = "state.json";
const icmarkets  = new ICMarketsClient();
const ai         = createAIClient();

// ─── Per-pair state ──────────────────────────────────────────────────────────
const pairState = new Map();  // pair → { lastSignal, activeTrades }

function getState(pair) {
  if (!pairState.has(pair)) {
    pairState.set(pair, { lastSignal: null, activeTrades: [] });
  }
  return pairState.get(pair);
}

// Account-level state (shared across all pairs)
let startingBalance = null;
let startingDay     = null;
let lastDailyPnL    = 0;
let lastLossTime    = 0; 

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  FOREX SCALPING BOT — IC Markets`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pairs      : ${PAIRS.join(", ")}`);
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

  // Only connect to AI if we're using it
  if (config.aiMode !== "OFF") {
    process.stdout.write(" ✓\nConnecting to AI...");
    await ai.healthCheck();
    process.stdout.write(" ✓\n");
  } else {
    process.stdout.write(" ✓\n  AI Mode: OFF (pure indicators — zero latency)\n");
  }

  process.stdout.write("Connecting to Finnhub News (WS)...");

  if (config.strategy.newsApiKey) {
    global.finnhubWsClient = new FinnhubWSClient(config.strategy.newsApiKey);
    global.finnhubWsClient.connect();
    process.stdout.write(" ✓\n\n");
  } else {
    process.stdout.write(" ⚠️  (Skipped - no API key)\n\n");
  }

  // Sync state and account
  loadState();
  for (const pair of PAIRS) {
    await reconcileAccount(pair);
  }

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

// ─── One Tick (scans all pairs) ──────────────────────────────────────────────

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

  // 0. Daily Circuit Breaker (account-level)
  const account = await icmarkets.getAccount();
  const currentBalance = parseFloat(account.balance);
  const dailyPnL = ((currentBalance - startingBalance) / startingBalance) * 100;

  if (dailyPnL <= -config.maxDailyLossPercent) {
    console.log(`[${timestamp}] 🛑 CIRCUIT BREAKER: Daily loss ${Math.abs(dailyPnL).toFixed(1)}% exceeded limit. Skipping trades.`);
    return;
  }

  // Cooldown check (account-level)
  if (dailyPnL < lastDailyPnL) {
    lastLossTime = Date.now();
    console.log(`[${timestamp}] ⚠️  Loss detected. Entering cooldown for ${config.lossCooldownMinutes} mins.`);
  }
  lastDailyPnL = dailyPnL;

  if (lastLossTime > 0) {
    const minsSinceLoss = (Date.now() - lastLossTime) / (60 * 1000);
    if (minsSinceLoss < config.lossCooldownMinutes) {
      console.log(`[${timestamp}] ⏸  COOLDOWN: Waiting ${Math.ceil(config.lossCooldownMinutes - minsSinceLoss)} more mins after loss.`);
      return;
    }
  }

  // Scan each pair sequentially
  for (const pair of PAIRS) {
    try {
      await tickPair(pair, timestamp);
    } catch (err) {
      console.error(`[${timestamp}] ❌ ${pair} tick error:`, err.message);
    }
  }
}

// ─── Tick for a single pair ──────────────────────────────────────────────────

async function tickPair(pair, timestamp) {
  const state = getState(pair);

  // 1. News Blocker Check
  if (config.strategy.newsBlocker) {
    const isNewsWindow = await isNearHighImpactNews(pair, config.strategy.newsBlockMinutesBefore, config.strategy.newsBlockMinutesAfter);
    if (isNewsWindow) {
      console.log(`[${timestamp}] ⏸  ${pair} HIGH-IMPACT NEWS WINDOW — skipping.`);
      return;
    }
  }

  // 2. Spread Check
  try {
    const spread = await icmarkets.getSpread(pair);
    if (spread > config.maxSpreadPips) {
      console.log(`[${timestamp}] ⏸  ${pair} HIGH SPREAD (${spread.toFixed(1)} pips) — skipping.`);
      return;
    }
  } catch (err) {
    // Spread check is best-effort — continue if it fails
  }

  process.stdout.write(`[${timestamp}] ${pair} `);

  // Multi-Timeframe Fetch
  const baseGranularity = config.granularity;
  const htfGranularity  = getHTFGranularity(baseGranularity);

  const [baseCandles, htfCandles] = await Promise.all([
    icmarkets.getCandles(pair, baseGranularity, 200),
    icmarkets.getCandles(pair, htfGranularity, 50).catch(() => null)
  ]);

  if (!baseCandles || baseCandles.length < 50) {
    console.log("⚠️  Not enough data.");
    return;
  }

  const indicators = calculateIndicators(baseCandles);
  const htfIndicators = htfCandles ? calculateIndicators(htfCandles) : null;

  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;

  // Manage existing trades (trailing stop)
  await manageActiveTrades(pair, indicators);

  // --- HARD FILTERS ---
  let possibleActions = ["BUY", "SELL", "WAIT"];
  const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };

  // 0. ATR Volatility Floor
  const atrPips = indicators.atr / pipSize;
  if (atrPips < config.minAtrPips) {
    console.log(`Skipping (Low ATR: ${atrPips.toFixed(1)} pips)`);
    return;
  }

  // 0b. ADX Trend Strength Floor
  if (indicators.adx !== null && indicators.adx < pairCfg.minAdx) {
    console.log(`Skipping (Low ADX: ${indicators.adx.toFixed(1)})`);
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

  // 3. EMA alignment
  if (indicators[`ema${emaFast}`] <= indicators[`ema${emaSlow}`]) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (indicators[`ema${emaFast}`] >= indicators[`ema${emaSlow}`]) possibleActions = possibleActions.filter(a => a !== "SELL");

  // 4. Falling Knife Filter
  const isSharpDrop = indicators.momentum < -1.2 * indicators.atr;
  const isSharpRise = indicators.momentum > 1.2 * indicators.atr;
  if (isSharpDrop) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (isSharpRise) possibleActions = possibleActions.filter(a => a !== "SELL");

  // 5. Distance check
  if (state.activeTrades.length > 0 && state.activeTrades.length < config.maxConcurrentTrades) {
    const tooClose = state.activeTrades.some(t => {
      const distPips = Math.abs(indicators.currentPrice - t.entryPrice) / pipSize;
      return distPips < config.minTradeDistancePips;
    });
    if (tooClose) {
      console.log(`Skipping (too close to existing entry)`);
      return;
    }
  }

  // 6. Total trades across all pairs check
  const totalActiveTrades = getAllActiveTrades().length;
  if (totalActiveTrades >= (config.maxTotalTrades || 3)) {
    console.log(`Skipping (total trades ${totalActiveTrades} >= max ${config.maxTotalTrades})`);
    return;
  }

  // --- TRIGGER LOGIC ---
  const strategyMode = pairCfg.strategyMode || "pullback";

  const macdHist = indicators.macd.hist;
  const prevHist = indicators.prevMacdHist;
  const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
  const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

  const minConfirmations = pairCfg.minConfirmations || 1;
  const minVolRatio = pairCfg.minVolumeRatio || 1.0;

  let technicalAction = "WAIT";

  if (strategyMode === "momentum") {
    // ─── MOMENTUM/BREAKOUT STRATEGY (GBP_USD) ───
    const rsiVal = indicators.rsi;
    const buyRsiMin = pairCfg.rsiMomentumBuyMin || 55;
    const sellRsiMax = pairCfg.rsiMomentumSellMax || 45;

    const isBullishBreakout = indicators.currentPrice > indicators.bbands.upper
      && rsiVal > buyRsiMin && rsiVal < 85;
    const isBearishBreakout = indicators.currentPrice < indicators.bbands.lower
      && rsiVal < sellRsiMax && rsiVal > 15;

    // Quality gate: BB must be expanding from a squeeze (compressed bands → breakout)
    if (pairCfg.requireBbExpansion && !indicators.bbSqueezeBreakout) {
      technicalAction = "WAIT";
    }
    // Quality gate: volume must be above threshold (genuine breakout)
    else if (pairCfg.requireVolume && indicators.volumeRatio < minVolRatio) {
      technicalAction = "WAIT";
    }
    // Quality gate: breakout candle must show conviction (decent body)
    else if (pairCfg.minCandleBodyATR && indicators.candleBodyATR < pairCfg.minCandleBodyATR) {
      technicalAction = "WAIT";
    }
    else {
      // MACD alignment (not requiring histogram acceleration — sustained trends flatten)
      const macdBullish = indicators.macd.macd > 0 && macdHist > 0;
      const macdBearish = indicators.macd.macd < 0 && macdHist < 0;

      let buyConf = 0, sellConf = 0;
      if (macdBullish) buyConf++;
      if (indicators.emaSlope > 0) buyConf++;

      if (macdBearish) sellConf++;
      if (indicators.emaSlope < 0) sellConf++;

      technicalAction = (isBullishBreakout && buyConf >= 1 && possibleActions.includes("BUY"))  ? "BUY" :
                        (isBearishBreakout && sellConf >= 1 && possibleActions.includes("SELL")) ? "SELL" : "WAIT";
    }
  } else {
    // ─── PULLBACK STRATEGY (EUR_USD, default) ───
    const isOverbought = indicators.rsi > rsiThresholdHigh && indicators.currentPrice > (indicators.bbands.upper - (0.5 * indicators.atr));
    const isOversold   = indicators.rsi < rsiThresholdLow  && indicators.currentPrice < (indicators.bbands.lower + (0.5 * indicators.atr));

    let buyConfirmCount = 0;
    if (indicators.isBullishRejection) buyConfirmCount++;
    if (macdTurningBullish) buyConfirmCount++;
    if (indicators.volumeRatio >= minVolRatio) buyConfirmCount++;
    const hasBuyConfirmation = buyConfirmCount >= minConfirmations;

    let sellConfirmCount = 0;
    if (indicators.isBearishRejection) sellConfirmCount++;
    if (macdTurningBearish) sellConfirmCount++;
    if (indicators.volumeRatio >= minVolRatio) sellConfirmCount++;
    const hasSellConfirmation = sellConfirmCount >= minConfirmations;

    technicalAction = (isOversold  && hasBuyConfirmation  && possibleActions.includes("BUY"))  ? "BUY" :
                      (isOverbought && hasSellConfirmation && possibleActions.includes("SELL")) ? "SELL" : "WAIT";
  }

  // Build signal
  if (config.aiMode === "OFF") {
    const { atrMultiplierSL, atrMultiplierTP } = pairCfg;
    const atrVal = indicators.atr || (pipSize * 15);
    const slDist = atrMultiplierSL * atrVal;
    const tpDist = atrMultiplierTP * atrVal;
    const px = indicators.currentPrice;

    const signal = {
      action: technicalAction,
      confidence: 100,
      sentiment: technicalAction === "BUY" ? "Bullish" : technicalAction === "SELL" ? "Bearish" : "Neutral",
      sentimentScore: 100,
      entry: px,
      stopLoss:   technicalAction === "BUY" ? px - slDist : px + slDist,
      takeProfit: technicalAction === "BUY" ? px + tpDist : px - tpDist,
      reasoning: "Pure indicator signal (AI OFF)"
    };

    if (technicalAction !== "WAIT") {
      console.log(`⚡ ${technicalAction} signal`);
    } else {
      console.log(`WAIT`);
    }

    await processSignal(pair, signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
    return;
  }

  // HYBRID / ALWAYS mode — route through AI
  if (config.aiMode === "HYBRID" && technicalAction === "WAIT") {
    console.log(`WAIT (no technical trigger)`);
    return;
  }

  process.stdout.write(`Asking AI...`);
  const startTime = Date.now();
  let newsContext = "";
  if (config.strategy.newsProvider === "finnhub" && config.strategy.newsApiKey) {
    newsContext = await getMarketNewsContext(5);
  }
  const signal = await getAISignal(pair, baseCandles, indicators, htfIndicators, possibleActions, newsContext);
  const latency = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(` ${signal.action} (${latency}s)`);

  await processSignal(pair, signal, indicators, timestamp, htfIndicators, latency, possibleActions);
}

// ─── Manage active trades (Trailing Stop / Breakeven) ────────────────────────

async function manageActiveTrades(pair, indicators) {
  const state = getState(pair);
  if (state.activeTrades.length === 0 || !config.useBreakeven || !AUTO_EXECUTE) return;

  const currentPX = indicators.currentPrice;
  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const atr = indicators.atr;

  for (const trade of state.activeTrades) {
    const profitPips = trade.direction === "BUY"
      ? (currentPX - trade.entryPrice) / pipSize
      : (trade.entryPrice - currentPX) / pipSize;

    const triggerPips = (atr * config.breakevenTriggerATR) / pipSize;

    if (profitPips >= triggerPips) {
      let newSL;

      if (config.useTrailingStop) {
        const trailDist = atr * (config.trailingStopATR || 1.5);
        newSL = trade.direction === "BUY" ? currentPX - trailDist : currentPX + trailDist;

        const buffer = 1.0 * pipSize;
        const minSL = trade.direction === "BUY" ? trade.entryPrice + buffer : trade.entryPrice - buffer;
        if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
        if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;

        const currentSL = trade.currentSL || (trade.direction === "BUY" ? 0 : Infinity);
        const shouldUpdate = trade.direction === "BUY" ? newSL > currentSL : newSL < currentSL;
        if (!shouldUpdate) continue;
      } else {
        if (trade.isBreakeven) continue;
        const buffer = 1.0 * pipSize;
        newSL = trade.direction === "BUY" ? trade.entryPrice + buffer : trade.entryPrice - buffer;
      }

      const logAction = trade.isBreakeven ? "Trailing SL" : "Breakeven+trail";
      console.log(`  🛡️  ${pair} ${trade.id}: ${logAction} (${profitPips.toFixed(1)} pips, SL→${newSL.toFixed(5)})`);

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

// ─── Process Signal ──────────────────────────────────────────────────────────

async function processSignal(pair, signal, indicators, timestamp, htfIndicators = null, latency = "0.0", allowedActions = ["BUY", "SELL", "WAIT"]) {
  const state = getState(pair);

  // 1. Hard Verification
  if (signal.action !== "WAIT") {
    let failedRule = null;
    if (!allowedActions.includes(signal.action)) {
      failedRule = `Action ${signal.action} not allowed by hard filters`;
    }
    const { emaFast, emaSlow } = config.strategy;
    if (signal.action === "BUY" && indicators[`ema${emaFast}`] <= indicators[`ema${emaSlow}`]) failedRule = `EMA bearish`;
    if (signal.action === "SELL" && indicators[`ema${emaFast}`] >= indicators[`ema${emaSlow}`]) failedRule = `EMA bullish`;

    if (failedRule) {
      signal.action = "WAIT";
      signal.confidence = 0;
      signal.reasoning = `Rejected: ${failedRule}`;
    }
  }

  // 2. Price/SL/TP sanity check
  const currentPX = indicators.currentPrice;
  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const atr = indicators.atr || 0;

  const minDistance = Math.max(pipSize * config.minStopDistancePips, atr * config.atrMultiplierFloor);
  const procPairCfg = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };
  const idealSLDist = Math.max(minDistance, atr * procPairCfg.atrMultiplierSL);
  const idealTPDist = Math.max(minDistance, atr * procPairCfg.atrMultiplierTP);

  if (signal.action !== "WAIT") {
    // Entry correction
    if (!signal.entry || Math.abs(signal.entry - currentPX) / currentPX > (config.maxPriceDeviationPercent / 100)) {
      signal.entry = currentPX;
    }
    // SL/TP correction
    const slDist = signal.stopLoss ? Math.abs(signal.stopLoss - signal.entry) : 0;
    const tpDist = signal.takeProfit ? Math.abs(signal.takeProfit - signal.entry) : 0;
    const isIllogical = (signal.action === "BUY" && (signal.stopLoss >= signal.entry || signal.takeProfit <= signal.entry)) ||
                        (signal.action === "SELL" && (signal.stopLoss <= signal.entry || signal.takeProfit >= signal.entry));

    if (!signal.stopLoss || !signal.takeProfit || isIllogical || slDist < minDistance || tpDist < minDistance) {
      if (signal.action === "BUY") {
        signal.stopLoss = parseFloat((signal.entry - idealSLDist).toFixed(5));
        signal.takeProfit = parseFloat((signal.entry + idealTPDist).toFixed(5));
      } else {
        signal.stopLoss = parseFloat((signal.entry + idealSLDist).toFixed(5));
        signal.takeProfit = parseFloat((signal.entry - idealTPDist).toFixed(5));
      }
    }
  }

  console.log(formatSignalAlert(pair, signal, indicators, timestamp, latency));
  logActivity("signal", { pair, ...signal, indicators });

  if (signal.action === "WAIT") return;

  const isFlip = state.lastSignal && state.lastSignal !== signal.action;
  state.lastSignal = signal.action;

  if (isFlip) {
    console.log(`  🔄  ${pair} signal FLIPPED to ${signal.action}. Closing opposite positions.`);
    await reconcileAccount(pair);
  } else {
    if (state.activeTrades.length >= config.maxConcurrentTrades) {
      console.log(`  ⏸  ${pair} max concurrent trades reached. Holding.`);
      return;
    }
  }

  if (!AUTO_EXECUTE) {
    try {
      const units = await calculateUnits(pair, signal, indicators);
      console.log(`  🔍 DRY RUN ${pair}: Would trade ${units} units\n`);
    } catch (err) {
      console.log(`  ⚠️  DRY RUN calc failed: ${err.message}`);
    }
    return;
  }

  if (AUTO_EXECUTE && signal.confidence >= config.minConfidenceToExecute) {
    if (signal.sentimentScore !== undefined && signal.sentimentScore < config.strategy.minSentimentConfidence) {
      console.log(`  ⏸  Sentiment too low — skipping.\n`);
      return;
    }
    await executeTrade(pair, signal, indicators);
  }
}

// ─── AI Signal ───────────────────────────────────────────────────────────────

async function getAISignal(pair, candles, indicators, htfIndicators = null, allowedActions = ["BUY", "SELL", "WAIT"], newsHeadlines = "") {
  const systemPrompt = getSystemPrompt(pair);
  const userPrompt = getUserPrompt(pair, config.granularity, indicators, candles.slice(-30), htfIndicators, allowedActions, newsHeadlines);
  return await ai.getSignal(systemPrompt, userPrompt);
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(pair, signal, indicators) {
  const state = getState(pair);
  console.log(`\n  🚀  Executing ${signal.action} on ${pair}...`);

  try {
    // Close opposite positions
    const oppositeDirection = signal.action === "BUY" ? "SELL" : "BUY";
    const tradesToClose = state.activeTrades.filter(t => t.direction === oppositeDirection);

    if (tradesToClose.length > 0) {
      for (const t of tradesToClose) {
        try {
          await icmarkets.closeTrade(t.id);
          state.activeTrades = state.activeTrades.filter(at => at.id !== t.id);
          console.log(`     ✓ Closed ${t.id}`);
        } catch (err) {
          const errMsg = err.message.toLowerCase();
          if (errMsg.includes("not found") || errMsg.includes("already closed") || errMsg.includes("invalid position id")) {
            state.activeTrades = state.activeTrades.filter(at => at.id !== t.id);
          } else {
            console.error(`  ⚠️  Aborting ${pair} trade — could not close ${t.id}.`);
            saveState();
            return;
          }
        }
      }
      saveState();
    }

    if (state.activeTrades.length >= config.maxConcurrentTrades) {
      console.log(`  ⏸  ${pair} max concurrent trades reached. Skipping.`);
      return;
    }

    const units = await calculateUnits(pair, signal, indicators);
    if (!units) return;

    const account    = await icmarkets.getAccount();
    const balance    = parseFloat(account.balance) / 100;
    const finalUnits = signal.action === "SELL" ? -units : units;

    const trade = await icmarkets.createOrder({
      instrument: pair,
      units:      finalUnits,
      stopLoss:   signal.stopLoss.toFixed(5),
      takeProfit: signal.takeProfit.toFixed(5),
      entryPrice: signal.entry,
    });

    state.activeTrades.push({
      id: String(trade.id),
      entryPrice: parseFloat(trade.price),
      direction: signal.action,
      pair,
      isBreakeven: false
    });
    saveState();

    console.log(formatTradeResult(trade, signal, balance, units));
    logActivity("trade", { pair, action: signal.action, units, price: trade.price, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit });

  } catch (err) {
    console.error(`  ❌  ${pair} trade failed: ${err.message}\n`);
  }
}

async function calculateUnits(pair, signal, indicators) {
  const account    = await icmarkets.getAccount();
  const balance    = parseFloat(account.balance) / 100;
  const riskAmount = balance * (config.riskPercentPerTrade / 100);
  const slDistance = Math.abs(signal.entry - signal.stopLoss);

  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const slPips  = slDistance / pipSize;
  const rate = indicators ? indicators.currentPrice : signal.entry;

  let pipValue = 10;
  if (pair.startsWith("USD_") || pair.startsWith("USD/")) {
    pipValue = (pipSize / rate) * 100_000;
  } else if (!pair.endsWith("_USD") && !pair.endsWith("/USD")) {
    pipValue = (pipSize / rate) * 100_000;
  }

  const lots = riskAmount / (slPips * pipValue);
  let units     = Math.floor(lots * 100_000);

  if (units > config.maxPositionSizeUnits) units = config.maxPositionSizeUnits;

  const symbol = await icmarkets.getSymbol(pair);
  if (symbol.stepVolume > 0) units = Math.floor(units / symbol.stepVolume) * symbol.stepVolume;
  if (units < symbol.minVolume) {
    console.log(`  ⚠️  ${pair} position too small (${units} < min ${symbol.minVolume}) — skipping.\n`);
    return 0;
  }
  return units;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAllActiveTrades() {
  const all = [];
  for (const [, state] of pairState) {
    all.push(...state.activeTrades);
  }
  return all;
}

function currentSession() {
  const h = utcHour();
  if (h >= 8  && h < 18) return h >= 13 && h < 16 ? "London+NY overlap" :
                                h >= 8  && h < 13  ? "London" : "New York";
  return "off";
}

function utcHour() {
  return new Date().getUTCHours();
}

function getHTFGranularity(base) {
  const map = { "M1": "M5", "M5": "M15", "M15": "H1", "M30": "H4", "H1": "H4" };
  return map[base] || "H1";
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      // Support both old format (flat activeTrades) and new (per-pair pairStates)
      if (data.pairStates) {
        for (const [pair, st] of Object.entries(data.pairStates)) {
          pairState.set(pair, { lastSignal: st.lastSignal || null, activeTrades: st.activeTrades || [] });
        }
      } else if (data.activeTrades && data.activeTrades.length > 0) {
        // Migrate old single-pair state
        const pair = data.activeTrades[0]?.pair || config.defaultInstrument;
        pairState.set(pair, { lastSignal: null, activeTrades: data.activeTrades });
      }
      const total = getAllActiveTrades().length;
      if (total > 0) console.log(`  📂  Loaded state: ${total} active trade(s) across ${pairState.size} pair(s)`);
    } catch (err) {
      console.error("  ⚠️  Failed to load state.json:", err.message);
    }
  }
}

function saveState() {
  try {
    const pairStates = {};
    for (const [pair, state] of pairState) {
      pairStates[pair] = { lastSignal: state.lastSignal, activeTrades: state.activeTrades };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pairStates, lastUpdated: new Date().toISOString() }, null, 2));
  } catch (err) {
    console.error("  ⚠️  Failed to save state.json:", err.message);
  }
}

async function reconcileAccount(pair) {
  const state = getState(pair);
  process.stdout.write(`  🔄  Syncing ${pair} positions...`);
  try {
    const positions = await icmarkets.reconcile();
    const symbolId = icmarkets._resolveSymbolId(pair);
    const pairPositions = positions.filter(p => p.tradeData && String(p.tradeData.symbolId) === String(symbolId));

    const syncedTrades = [];
    for (const pos of pairPositions) {
      const brokerPosId = String(pos.positionId);
      const entryPrice = parseFloat(pos.price || pos.entryPrice);
      const direction = pos.tradeData.tradeSide === "BUY" ? "BUY" : "SELL";
      const stopLoss = pos.stopLoss ? parseFloat(pos.stopLoss) : null;
      const isBreakeven = stopLoss !== null && (direction === "BUY" ? stopLoss >= entryPrice : stopLoss <= entryPrice);
      syncedTrades.push({ id: brokerPosId, entryPrice, direction, pair, isBreakeven });
    }

    const currentIds = state.activeTrades.map(t => t.id).sort().join(",");
    const syncedIds = syncedTrades.map(t => t.id).sort().join(",");

    if (currentIds !== syncedIds) {
      console.log(` ✅ Reconciled ${syncedTrades.length} position(s).`);
      state.activeTrades = syncedTrades;
      saveState();
    } else {
      console.log(" ✓");
    }
  } catch (err) {
    console.error(` ❌ Reconciliation failed: ${err.message}`);
  }
}

function logActivity(type, data) {
  const cleanData = JSON.parse(JSON.stringify(data, (key, value) =>
    typeof value === "number" ? Number(value.toFixed(5)) : value
  ));
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), type, ...cleanData }) + "\n";
  try { fs.appendFileSync("activity.log", entry); } catch {}
}

// ─── Start ───────────────────────────────────────────────────────────────────
run().catch(console.error);
