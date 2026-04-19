/**
 * Backtest Runner for IC Markets Bot (Single Pair)
 * Simplified and perfectly aligned with index.js and multi-backtest.
 */

import fs from "fs";
import { calculateIndicators } from "./indicators.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const pairArg = args.find(a => a.startsWith('--pair='))?.split('=')[1]
              || (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null);

const PAIR = pairArg || config.defaultInstrument || "EUR_USD";
const HISTORY_FILE = `history_${PAIR.replace("/", "_")}.json`;
const INITIAL_BALANCE = config.backtest.initialBalance || 500;
const COMMISSION_SIDE_USD = config.backtest.commissionPerSideUSD || 3.00;

// Constants for simulation
const IS_JPY = PAIR.includes("JPY");
const PIP_SIZE = IS_JPY ? 0.01 : 0.0001;
const SPREAD = (config.backtest.spreadPips || 0.1) * PIP_SIZE;
const SLIPPAGE = (config.backtest.slippagePips || 0.2) * PIP_SIZE;

async function main() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.error(`❌ History file not found: ${HISTORY_FILE}`);
    process.exit(1);
  }

  const allCandles = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  IC MARKETS BACKTESTER (SINGLE PAIR)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pair         : ${PAIR}`);
  console.log(`  Initial Bal  : $${INITIAL_BALANCE}`);
  console.log(`${"═".repeat(60)}\n`);

  let balance = INITIAL_BALANCE;
  let activeTrades = [];
  let tradeHistory = [];
  let lastSignal = null;
  let lastLossTime = null;

  const windowSize = 200; // REDUCED windowSize from 1000 to 200 to ensure trades run on smaller history files

  for (let i = windowSize; i < allCandles.length; i++) {
    const currentCandles = allCandles.slice(i - windowSize, i);
    const nextCandle = allCandles[i]; 
    const timestamp = nextCandle.time;

    const indicators = calculateIndicators(currentCandles);
    const midOpen = parseFloat(nextCandle.mid.o);
    const midHigh = parseFloat(nextCandle.mid.h);
    const midLow  = parseFloat(nextCandle.mid.l);

    const hasActuals = nextCandle.bid && nextCandle.ask && (nextCandle.bid.c !== nextCandle.ask.c);
    const bidHigh = hasActuals ? parseFloat(nextCandle.bid.h) : midHigh - SPREAD/2;
    const bidLow  = hasActuals ? parseFloat(nextCandle.bid.l) : midLow - SPREAD/2;
    const askHigh = hasActuals ? parseFloat(nextCandle.ask.h) : midHigh + SPREAD/2;
    const askLow  = hasActuals ? parseFloat(nextCandle.ask.l) : midLow + SPREAD/2;

    manageActiveTrades(indicators, midOpen);

    activeTrades = activeTrades.filter(trade => {
      if (trade.direction === "BUY") {
        if (bidLow <= trade.sl) { closeTrade(trade, trade.sl, "SL", timestamp); return false; }
        if (bidHigh >= trade.tp) { closeTrade(trade, trade.tp, "TP", timestamp); return false; }
      } else {
        if (askHigh >= trade.sl) { closeTrade(trade, trade.sl, "SL", timestamp); return false; }
        if (askLow <= trade.tp) { closeTrade(trade, trade.tp, "TP", timestamp); return false; }
      }
      return true;
    });

    const dateObj = new Date(timestamp);
    const h = dateObj.getUTCHours();
    const day = dateObj.getUTCDay();
    // Simplified session check: Market is open if not weekend and within hours
    const isSession = day !== 0 && day !== 6 && h >= config.sessionStartUTC && h < config.sessionEndUTC;
    
    if (!isSession) {
      lastSignal = "WAIT";
      continue;
    }

    if (lastLossTime && (new Date(timestamp) - new Date(lastLossTime)) / 60000 < config.lossCooldownMinutes) continue;

    let possibleActions = ["BUY", "SELL", "WAIT"];
    const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[PAIR] || {}) };
    const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;

    if (indicators.atr / PIP_SIZE < config.minAtrPips) continue;
    if (indicators.adx !== null && indicators.adx < (pairCfg.minAdx || 18)) continue;

    const isSharpDrop = indicators.momentum < -1.2 * indicators.atr;
    const isSharpRise = indicators.momentum > 1.2 * indicators.atr;
    if (isSharpDrop) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (isSharpRise) possibleActions = possibleActions.filter(a => a !== "SELL");

    if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

    const emaF = indicators[`ema${emaFast}`];
    const emaS = indicators[`ema${emaSlow}`];
    if (emaF <= emaS) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (emaF >= emaS) possibleActions = possibleActions.filter(a => a !== "SELL");

    const ema200 = indicators.ema200;
    if (ema200) {
        if (midOpen > ema200) possibleActions = possibleActions.filter(a => a !== "SELL");
        else possibleActions = possibleActions.filter(a => a !== "BUY");
    }

    let action = "WAIT";
    const strategyMode = pairCfg.strategyMode || "pullback";
    if (strategyMode === "pullback") {
      const isOverbought = indicators.rsi > rsiThresholdHigh && midOpen > (indicators.bbands.upper - (0.5 * indicators.atr));
      const isOversold   = indicators.rsi < rsiThresholdLow  && midOpen < (indicators.bbands.lower + (0.5 * indicators.atr));
      const vwapBuyBias  = indicators.vwap ? midOpen < indicators.vwap : true;
      const vwapSellBias = indicators.vwap ? midOpen > indicators.vwap : true;

      const macdHist = indicators.macd.hist;
      const prevHist = indicators.prevMacdHist;
      const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
      const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

      let buyConf = (macdTurningBullish ? 1 : 0) + (indicators.isBullishRejection ? 1 : 0) + (indicators.volumeRatio >= (pairCfg.minVolumeRatio || 1.0) ? 1 : 0);
      let sellConf = (macdTurningBearish ? 1 : 0) + (indicators.isBearishRejection ? 1 : 0) + (indicators.volumeRatio >= (pairCfg.minVolumeRatio || 1.0) ? 1 : 0);

      if (isOversold && buyConf >= (pairCfg.minConfirmations || 1) && vwapBuyBias && possibleActions.includes("BUY")) action = "BUY";
      if (isOverbought && sellConf >= (pairCfg.minConfirmations || 1) && vwapSellBias && possibleActions.includes("SELL")) action = "SELL";
    }

    if (action !== "WAIT") {
      const tooClose = activeTrades.some(t => Math.abs(midOpen - t.entry) / PIP_SIZE < config.minTradeDistancePips);
      if (activeTrades.length < config.maxTradesPerPair && !tooClose) {
         handleSignal(action, midOpen, indicators, timestamp);
      }
    }
    lastSignal = action;
  }

  function handleSignal(action, price, indicators, time) {
    const { atrMultiplierSL, atrMultiplierTP } = config.strategy;
    const slDist = atrMultiplierSL * indicators.atr;
    const tpDist = atrMultiplierTP * indicators.atr;
    const entryPrice = action === "BUY" ? price + SLIPPAGE : price - SLIPPAGE;

    activeTrades.push({
      id: `T${tradeHistory.length + 1}`,
      direction: action,
      entry: entryPrice,
      sl: action === "BUY" ? entryPrice - slDist : entryPrice + slDist,
      tp: action === "BUY" ? entryPrice + tpDist : entryPrice - tpDist,
      units: calculateUnits(price, indicators, balance),
      time,
      isBreakeven: false
    });
    console.log(`  🚀 [${time}] ${PAIR} Opened ${action} at ${entryPrice.toFixed(5)}`);
  }

  function manageActiveTrades(indicators, currentPrice) {
    if (activeTrades.length === 0 || !config.useBreakeven) return;
    for (const trade of activeTrades) {
      const profitPips = trade.direction === "BUY" ? (currentPrice - trade.entry) / PIP_SIZE : (trade.entry - currentPrice) / PIP_SIZE;
      if (profitPips >= (indicators.atr * config.breakevenTriggerATR) / PIP_SIZE) {
        const trailDist = indicators.atr * (config.trailingStopATR || 1.0);
        let newSL = trade.direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;
        const buffer = 1.0 * PIP_SIZE;
        const minSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
        if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
        if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;
        if (trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl) { trade.sl = newSL; trade.isBreakeven = true; }
      }
    }
  }

  function closeTrade(trade, exitPrice, reason, exitTime) {
    const rawPnL = trade.direction === "BUY" ? (exitPrice - trade.entry) * trade.units : (trade.entry - exitPrice) * trade.units;
    const entryVol = PAIR.startsWith("USD") ? trade.units : (trade.units * trade.entry);
    const exitVol = PAIR.startsWith("USD") ? trade.units : (trade.units * exitPrice);
    const commission = ((entryVol / 100000) * COMMISSION_SIDE_USD) + ((exitVol / 100000) * COMMISSION_SIDE_USD);
    const netProfit = rawPnL - commission;
    if (netProfit < 0 && reason === "SL") lastLossTime = exitTime;
    balance += netProfit;
    tradeHistory.push({ ...trade, exit: exitPrice, exitTime, reason, profit: netProfit, balance });
    console.log(`  ✅ [${exitTime}] ${PAIR} Closed ${trade.id} (${reason}) | Net: $${netProfit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  function calculateUnits(price, indicators, currentBalance) {
    const riskAmount = currentBalance * (config.riskPercentPerTrade / 100);
    const slDist = config.strategy.atrMultiplierSL * indicators.atr;
    const slPips = slDist / PIP_SIZE;
    let pipValue = 10;
    if (PAIR.startsWith("USD/")) pipValue = (PIP_SIZE / price) * 100000;
    const units = Math.floor((riskAmount / (slPips * pipValue)) * 100000);
    return Math.max(100, Math.floor(Math.min(units, 50000) / 100) * 100);
  }

  const tT = tradeHistory.length;
  const wins = tradeHistory.filter(t => t.profit > 0);
  const losses = tradeHistory.filter(t => t.profit <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : Infinity;

  let peak = INITIAL_BALANCE, maxDD = 0, runningBal = INITIAL_BALANCE;
  tradeHistory.sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime)).forEach(t => {
    runningBal += t.profit;
    if (runningBal > peak) peak = runningBal;
    const dd = ((peak - runningBal) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  });

  const winRate = ((wins.length / Math.max(1, tT)) * 100).toFixed(1);

  console.log(`\n${"═".repeat(60)}\n  📊  FINAL RESULTS (OVERALL)\n${"═".repeat(60)}`);
  console.log(`  Total Trades  : ${tT}`);
  console.log(`  Win Rate      : ${winRate}%`);
  console.log(`  Avg Win       : $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss      : $${avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor : ${profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown  : ${maxDD.toFixed(2)}%`);
  console.log(`  Net Profit    : $${(balance - INITIAL_BALANCE).toFixed(2)} (${(((balance/INITIAL_BALANCE)-1)*100).toFixed(2)}%)`);
  console.log(`  Final Bal     : $${balance.toFixed(2)}`);
  console.log(`${"═".repeat(60)}\n`);

  fs.writeFileSync("trades_backtest.json", JSON.stringify({ type: "backtest", timestamp: new Date().toISOString(), winRate, totalNetProfit: balance - INITIAL_BALANCE, totalTrades: tT, trades: tradeHistory }, null, 2));
}

main();
