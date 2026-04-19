#!/usr/bin/env node

/**
 * Forex Scalping Bot — IC Markets Edition
 * Pure Technical Indicators + IC Markets cTrader Open API
 *
 * Risk Engine: 50,000 KES account, 1,000 KES daily drawdown cap,
 * 500–1,000 KES daily profit target, max 1 trade at a time.
 *
 * Usage:
 *   node index.js                        → monitor all tradingPairs (default: EUR_USD)
 *   node index.js --auto-execute         → auto-execute trades
 *   node index.js --pair GBP_USD         → single pair only
 *   node index.js --pair EUR_USD,GBP_USD,USD_JPY --auto-execute
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { calculateIndicators } from "./indicators.js";
import { formatSignalAlert, formatTradeResult } from "./formatter.js";
import { createAIClient, getSystemPrompt, getUserPrompt } from "./ai.js";
import { config }          from "./config.js";
import { RiskManager }     from "./risk-manager.js";

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
const riskManager = new RiskManager();

// ─── Per-pair state ──────────────────────────────────────────────────────────
const pairState = new Map();  // pair → { lastSignal, activeTrades, candleCache, lastTickPrice }

function getState(pair) {
  if (!pairState.has(pair)) {
    pairState.set(pair, { 
      lastSignal: null, 
      activeTrades: [], 
      candleCache: [], 
      lastTickPrice: null,
      lastTickTime: 0
    });
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
  console.log(`  🤖  FOREX SCALPING BOT — IC Markets (KES Risk Engine)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pairs      : ${PAIRS.join(", ")}`);
  console.log(`  Timeframe  : ${config.granularity}`);
  console.log(`  Mode       : ${AUTO_EXECUTE ? "🔴 AUTO-EXECUTE" : "🟡 MONITOR ONLY"}`);
  console.log(`  Interval   : Reactive (5s cycle + WebSocket ticks)`);
  console.log(`  Account    : ${config.ctraderEnv.toUpperCase()}`);
  console.log(`  Capital    : ${config.risk.accountCapitalKES.toLocaleString()} KES`);
  console.log(`  Daily Loss : max ${config.risk.dailyStopLossKES.toLocaleString()} KES (${((config.risk.dailyStopLossKES / config.risk.accountCapitalKES) * 100).toFixed(1)}%)`);
  console.log(`  Daily TP   : ${config.risk.dailyProfitTargetKES.toLocaleString()} KES`);
  console.log(`  Max Trades : ${config.risk.maxOpenTrades} concurrent`);
  console.log(`  Min R:R    : 1:${config.risk.minRiskReward}`);
  console.log(`  Session    : ${config.sessionStartUTC}:00–${config.sessionEndUTC}:00 UTC (London/NY Overlap)`);
  console.log(`${"═".repeat(60)}\n`);

  if (AUTO_EXECUTE) {
    console.log("⚠️  AUTO-EXECUTE ON — trades will be placed automatically.\n");
  }

  // Connect and authenticate
  process.stdout.write("Connecting to IC Markets...");
  await icmarkets.connect();

  // Set up connection health alert callback
  icmarkets.onConnectionLost = (msg) => {
    logActivity("emergency", { message: msg });
  };

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

  // Sync state and account
  loadState();
  
  // Initial data fetch and subscription
  process.stdout.write("Initializing candle caches and subscribing to ticks...");
  for (const pair of PAIRS) {
    await reconcileAccount(pair);
    const state = getState(pair);
    // Initial fetch to prime the cache
    state.candleCache = await icmarkets.getCandles(pair, config.granularity, 200);
    await icmarkets.subscribeTicks(pair);
  }
  process.stdout.write(" ✓\n");

  // Listen for real-time ticks to update cache
  icmarkets.on(2131, (payload) => { // PT.SPOT_EVENT
    for (const pair of PAIRS) {
      const symbolId = icmarkets._resolveSymbolId(pair);
      if (String(payload.symbolId) === String(symbolId)) {
        updateCandleCache(pair, payload);
      }
    }
  });

  // Sync RiskManager open trade count from state
  const totalActive = getAllActiveTrades().length;
  riskManager.syncOpenTradeCount(totalActive);

  const account = await icmarkets.getAccount();
  startingBalance = parseFloat(account.balance);
  startingDay     = new Date().getUTCDate();

  // Show RiskManager status
  const riskStatus = riskManager.getStatus();
  console.log(`  📊 RiskManager: Trading=${riskStatus.tradingEnabled ? "ON" : "OFF"} | Daily PnL: ${riskStatus.dailyRealizedPnLKES.toFixed(2)} KES | Open: ${riskStatus.openTradeCount}`);
  console.log();

  // Optimized Main Loop: Check every 5 seconds instead of 60
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("❌ Tick error:", err.message);
    }
    await sleep(5000); // Check every 5 seconds
  }
}

/**
 * Updates the local candle cache with tick data.
 * If a new candle period has started, it fetches fresh data or rolls the candle.
 */
function updateCandleCache(pair, payload) {
  const state = getState(pair);
  const price = (payload.bid || payload.ask) / 100000;
  if (!price) return;

  state.lastTickPrice = price;
  state.lastTickTime = Date.now();

  if (state.candleCache.length === 0) return;

  const lastCandle = state.candleCache[state.candleCache.length - 1];
  const lastCandleTime = new Date(lastCandle.time).getTime();
  const granularityMs = {
    M1: 60000, M5: 300000, M15: 900000, H1: 3600000
  }[config.granularity] || 300000;

  const now = Date.now();
  const currentCandleStartTime = Math.floor(now / granularityMs) * granularityMs;

  if (currentCandleStartTime > lastCandleTime) {
    // New candle period started! 
    // We could "guess" the new candle, but for accuracy, we'll let tick() fetch it.
    // Setting cache to empty triggers a fresh fetch in the next tick()
    state.needsRefresh = true;
  } else {
    // Update current candle
    const p = price.toFixed(5);
    lastCandle.mid.c = p;
    if (parseFloat(p) > parseFloat(lastCandle.mid.h)) lastCandle.mid.h = p;
    if (parseFloat(p) < parseFloat(lastCandle.mid.l)) lastCandle.mid.l = p;
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

  // Skip low-liquidity periods
  const session = currentSession();
  if (session === "off") {
    // Still perform heartbeat/health but don't trade
    return;
  }

  // Risk checks...
  const riskCheck = riskManager.canTrade();
  
  // 0. Daily Circuit Breaker
  const account = await icmarkets.getAccount();
  const currentBalance = parseFloat(account.balance);
  const dailyPnL = ((currentBalance - startingBalance) / startingBalance) * 100;

  if (dailyPnL <= -config.maxDailyLossPercent) return;

  // Scan each pair sequentially (or in parallel)
  // Optimization: use Promise.all to check all pairs at once
  await Promise.all(PAIRS.map(pair => {
    return tickPair(pair, timestamp).catch(err => {
      console.error(`[${timestamp}] ❌ ${pair} tick error:`, err.message);
    });
  }));
}

// ─── Tick for a single pair ──────────────────────────────────────────────────

async function tickPair(pair, timestamp) {
  const state = getState(pair);

  // 1. Refresh cache if needed (new candle or empty)
  if (state.needsRefresh || state.candleCache.length < 50) {
    state.candleCache = await icmarkets.getCandles(pair, config.granularity, 200);
    state.needsRefresh = false;
  }

  const baseCandles = state.candleCache;

  // Only proceed if we have a recent tick or the cache is fresh
  if (!state.lastTickPrice && baseCandles.length > 0) {
    state.lastTickPrice = parseFloat(baseCandles[baseCandles.length - 1].mid.c);
  }

  // ─── Heavy fetch for HTF only happens occasionally ──────────────────────
  // We fetch HTF and H1 every 60s or if missing
  const now = Date.now();
  if (!state.lastHeavyFetch || (now - state.lastHeavyFetch > 60000)) {
    const [htfCandles, h1Candles] = await Promise.all([
      icmarkets.getCandles(pair, getHTFGranularity(config.granularity), 50).catch(() => null),
      icmarkets.getCandles(pair, "H1", 500).catch(() => null)
    ]);
    state.htfCandles = htfCandles;
    state.h1Candles = h1Candles;
    state.lastHeavyFetch = now;
  }

  // ─── Phase 1: Risk & Spread ─────────────────────────────────────────────
  const riskCheck = riskManager.canTrade();
  if (!riskCheck.allowed) return;

  // Spread check (optional: we can skip if we haven't seen a tick in 10s)
  // ... (existing spread check)
  
  // ─── Phase 2: Indicators ────────────────────────────────────────────────
  const indicators = calculateIndicators(baseCandles);
  const htfIndicators = state.htfCandles ? calculateIndicators(state.htfCandles) : null;
  const h1Indicators  = state.h1Candles ? calculateIndicators(state.h1Candles) : null;
  
  if (h1Indicators) {
    indicators.srZone = h1Indicators.srZone;
    indicators.nearSupport = h1Indicators.nearSupport;
    indicators.nearResistance = h1Indicators.nearResistance;
  }

  // Manage existing trades
  await manageActiveTrades(pair, indicators);

  // Only log if something interesting is happening or every 60s to avoid spam
  const shouldLog = (now - (state.lastLogTime || 0)) > 60000;
  
  const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };
  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;

  // 0. ATR Volatility Floor
  const atrPips = indicators.atr / pipSize;
  if (atrPips < config.minAtrPips) {
    if (shouldLog) console.log(`[${timestamp}] ${pair} ⏸  Low ATR (${atrPips.toFixed(1)} pips)`);
    state.lastLogTime = now;
    return;
  }

  // Define possible actions based on filters
  let possibleActions = ["BUY", "SELL", "WAIT"];

  // 0b. ADX Trend Strength Floor
  if (indicators.adx !== null && indicators.adx < pairCfg.minAdx) {
    if (shouldLog) console.log(`[${timestamp}] ${pair} ⏸  Low ADX (${indicators.adx.toFixed(1)})`);
    state.lastLogTime = now;
    return;
  }

  // 1. EMA(200) Trend Filter on H1
  const ema200 = h1Indicators?.ema200 ?? indicators.ema200;
  if (ema200 !== null) {
    if (indicators.currentPrice > ema200) {
      possibleActions = possibleActions.filter(a => a !== "SELL");
    } else if (indicators.currentPrice < ema200) {
      possibleActions = possibleActions.filter(a => a !== "BUY");
    }
  }

  // 2. Volatility Filter
  if (!indicators.isVolatilityOk) {
    if (shouldLog) console.log(`[${timestamp}] ${pair} ⏸  Low relative volatility`);
    state.lastLogTime = now;
    return;
  }

  // 3. RSI & EMA Alignment
  const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;
  if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
  if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

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
      if (shouldLog) console.log(`[${timestamp}] ${pair} ⏸  Too close to existing entry`);
      state.lastLogTime = now;
      return;
    }
  }

  // 6. Total trades across all pairs check
  const totalActiveTrades = getAllActiveTrades().length;
  if (totalActiveTrades >= (config.maxTotalTrades || 1)) {
    if (shouldLog) console.log(`[${timestamp}] ${pair} ⏸  Global max trades reached`);
    state.lastLogTime = now;
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
    const rsiVal = indicators.rsi;
    const buyRsiMin = pairCfg.rsiMomentumBuyMin || 55;
    const sellRsiMax = pairCfg.rsiMomentumSellMax || 45;
    const isBullishBreakout = indicators.currentPrice > indicators.bbands.upper && rsiVal > buyRsiMin;
    const isBearishBreakout = indicators.currentPrice < indicators.bbands.lower && rsiVal < sellRsiMax;

    if (isBullishBreakout && possibleActions.includes("BUY")) technicalAction = "BUY";
    if (isBearishBreakout && possibleActions.includes("SELL")) technicalAction = "SELL";
  } else {
    // ─── PULLBACK STRATEGY (Restore high WR thresholds) ───
    // Tighten BB zone from 1.0 to 0.5 ATR
    const isOverbought = indicators.rsi > rsiThresholdHigh && indicators.currentPrice > (indicators.bbands.upper - (0.5 * indicators.atr));
    const isOversold   = indicators.rsi < rsiThresholdLow  && indicators.currentPrice < (indicators.bbands.lower + (0.5 * indicators.atr));
    
    // VWAP Bias
    const vwapBuyBias  = indicators.vwap ? indicators.currentPrice < indicators.vwap : true;
    const vwapSellBias = indicators.vwap ? indicators.currentPrice > indicators.vwap : true;

    // Use flexible confirmation count instead of hard AND
    let buyConf = 0;
    if (macdTurningBullish) buyConf++;
    if (indicators.isBullishRejection) buyConf++;
    if (indicators.volumeRatio >= minVolRatio) buyConf++;
    
    let sellConf = 0;
    if (macdTurningBearish) sellConf++;
    if (indicators.isBearishRejection) sellConf++;
    if (indicators.volumeRatio >= minVolRatio) sellConf++;

    if (isOversold && buyConf >= minConfirmations && vwapBuyBias && possibleActions.includes("BUY")) technicalAction = "BUY";
    if (isOverbought && sellConf >= minConfirmations && vwapSellBias && possibleActions.includes("SELL")) technicalAction = "SELL";
  }

  // Price Action Trigger
  if (technicalAction !== "WAIT" && config.strategy.usePriceActionTrigger) {
    const isBuy = technicalAction === "BUY";
    const hasPAConfirm = isBuy ? indicators.hasBullishPriceAction : indicators.hasBearishPriceAction;
    if (!hasPAConfirm) {
      technicalAction = "WAIT";
    }
  }

  // Build signal and process
  if (config.aiMode === "OFF") {
    const { atrMultiplierSL, atrMultiplierTP } = pairCfg;
    const slDist = atrMultiplierSL * indicators.atr;
    const tpDist = atrMultiplierTP * indicators.atr;
    const px = indicators.currentPrice;

    const signal = {
      action: technicalAction,
      confidence: 100,
      sentiment: technicalAction === "BUY" ? "Bullish" : technicalAction === "SELL" ? "Bearish" : "Neutral",
      sentimentScore: 100,
      entry: px,
      stopLoss:   technicalAction === "BUY" ? px - slDist : px + slDist,
      takeProfit: technicalAction === "BUY" ? px + tpDist : px - tpDist,
      reasoning: "Reactive indicator signal (AI OFF)"
    };

    if (technicalAction !== "WAIT" || shouldLog) {
      if (technicalAction === "WAIT") {
        process.stdout.write(`[${timestamp}] ${pair} RSI ${indicators.rsi.toFixed(1)} | Px ${indicators.currentPrice.toFixed(5)}\r`);
      } else {
        console.log(`\n[${timestamp}] ⚡ ${pair} ${technicalAction} Signal detected!`);
      }
      await processSignal(pair, signal, indicators, timestamp, htfIndicators, "0.0", possibleActions);
      state.lastLogTime = now;
    }
    return;
  }

  // AI Logic (Hybrid/Always)
  if (config.aiMode === "HYBRID" && technicalAction === "WAIT") {
    if (shouldLog) {
      process.stdout.write(`[${timestamp}] ${pair} RSI ${indicators.rsi.toFixed(1)} | Px ${indicators.currentPrice.toFixed(5)}\r`);
      state.lastLogTime = now;
    }
    return;
  }

  process.stdout.write(`[${timestamp}] ${pair} Asking AI...`);
  const startTime = Date.now();
  const signal = await getAISignal(pair, baseCandles, indicators, htfIndicators, possibleActions);
  const latency = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(` ${signal.action} (${latency}s)`);

  await processSignal(pair, signal, indicators, timestamp, htfIndicators, latency, possibleActions);
  state.lastLogTime = now;
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

    // ─── Phase 3: Break-Even Logic ──────────────────────────────────────
    // If Current_Profit >= 1 × Initial_Risk → move SL to Entry_Price
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

    // ─── Phase 3: Enforce minimum R:R of 1:1.5 ──────────────────────────
    if (!riskManager.validateRiskReward(signal)) {
      // Try to adjust TP to meet minimum R:R
      const risk = Math.abs(signal.entry - signal.stopLoss);
      const minTP = risk * config.risk.minRiskReward;
      if (signal.action === "BUY") {
        signal.takeProfit = parseFloat((signal.entry + minTP).toFixed(5));
      } else {
        signal.takeProfit = parseFloat((signal.entry - minTP).toFixed(5));
      }
      // Revalidate
      if (!riskManager.validateRiskReward(signal)) {
        signal.action = "WAIT";
        signal.reasoning = "Rejected: Cannot meet minimum R:R of 1:1.5";
      }
    }
  }

  console.log(formatSignalAlert(pair, signal, indicators, timestamp, latency));
  logActivity("signal", { pair, ...signal, indicators });

  if (signal.action === "WAIT") return;

  // ─── RiskManager final gate before execution ──────────────────────────
  const riskCheck = riskManager.canTrade();
  if (!riskCheck.allowed) {
    console.log(`  🛑 RiskManager blocked: ${riskCheck.reason}`);
    return;
  }

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

async function getAISignal(pair, candles, indicators, htfIndicators = null, allowedActions = ["BUY", "SELL", "WAIT"]) {
  const systemPrompt = getSystemPrompt(pair);
  const userPrompt = getUserPrompt(pair, config.granularity, indicators, candles.slice(-30), htfIndicators, allowedActions);
  return await ai.getSignal(systemPrompt, userPrompt);
}

// ─── Trade Execution ─────────────────────────────────────────────────────────

async function executeTrade(pair, signal, indicators) {
  const state = getState(pair);

  // ─── Final RiskManager permission check (MUST always ask before order) ──
  const riskCheck = riskManager.canTrade();
  if (!riskCheck.allowed) {
    console.log(`  🛑 RiskManager BLOCKED execution: ${riskCheck.reason}\n`);
    return;
  }

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
          riskManager.syncOpenTradeCount(getAllActiveTrades().length);
          console.log(`     ✓ Closed ${t.id}`);
        } catch (err) {
          const errMsg = err.message.toLowerCase();
          if (errMsg.includes("not found") || errMsg.includes("already closed") || errMsg.includes("invalid position id")) {
            state.activeTrades = state.activeTrades.filter(at => at.id !== t.id);
            riskManager.syncOpenTradeCount(getAllActiveTrades().length);
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
    const balance    = parseFloat(account.balance);
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

    // Notify RiskManager
    riskManager.onTradeOpened(
      String(trade.id), pair, signal.action,
      parseFloat(trade.price), signal.stopLoss, signal.takeProfit, units
    );

    console.log(formatTradeResult(trade, signal, balance, units));
    logActivity("trade", { pair, action: signal.action, units, price: trade.price, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit });

  } catch (err) {
    console.error(`  ❌  ${pair} trade failed: ${err.message}\n`);
  }
}

async function calculateUnits(pair, signal, indicators) {
  const isJPY = pair.includes("JPY");
  const pipSize = isJPY ? 0.01 : 0.0001;
  const slDistance = Math.abs(signal.entry - signal.stopLoss);
  const slPips = slDistance / pipSize;
  const rate = indicators ? indicators.currentPrice : signal.entry;

  // ─── Phase 1: Use RiskManager's KES-based lot size calculator ──────────
  let units = riskManager.calculateVolume(pair, slPips, rate);

  if (units <= 0) {
    console.log(`  ⚠️  ${pair} RiskManager calculated 0 units — skipping.\n`);
    return 0;
  }

  // Clamp to broker symbol constraints
  const symbol = await icmarkets.getSymbol(pair);
  if (symbol.stepVolume > 0) units = Math.floor(units / symbol.stepVolume) * symbol.stepVolume;
  if (units < symbol.minVolume) {
    console.log(`  ⚠️  ${pair} position too small (${units} < min ${symbol.minVolume}) — skipping.\n`);
    return 0;
  }

  console.log(`  📊 Volume: ${units} units (${(units / 100_000).toFixed(2)} lots) | SL: ${slPips.toFixed(1)} pips | Rate: ${rate.toFixed(5)}`);
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
  const now = new Date();
  const h = now.getUTCHours();
  const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday

  // Weekend check: block Saturday and Sunday
  if (day === 0 || day === 6) return "off";

  // London + NY sessions: 08:00–18:00 UTC (11:00–21:00 EAT)
  if (h >= config.sessionStartUTC && h < config.sessionEndUTC) {
    if (h >= 12 && h < 16) return "London+NY overlap";
    if (h >= 8  && h < 12) return "London";
    if (h >= 16 && h < 18) return "New York";
    return "Market Open";
  }
  return "off";
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

    // Sync RiskManager
    riskManager.syncOpenTradeCount(getAllActiveTrades().length);
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
