/**
 * Backtest Runner for IC Markets Bot (Multi-Pair)
 * Replicates the live trading environment (index.js) as closely as possible.
 */

import fs from "fs";
import { calculateIndicators } from "./indicators.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const pairArg = args.find(a => a.startsWith('--pair='))?.split('=')[1]
              || (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null);

const PAIRS = pairArg ? pairArg.split(",").map(s => s.trim()) : config.tradingPairs;
const INITIAL_BALANCE = config.backtest.initialBalance || 500;
const COMMISSION_SIDE_USD = config.backtest.commissionPerSideUSD || 3.00;

let balance = INITIAL_BALANCE;
const pairData = {};

// Constants for simulation
const SPREAD_PIPS = config.backtest.spreadPips || 0.1;
const SLIPPAGE_PIPS = config.backtest.slippagePips || 0.2;

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  IC MARKETS MULTI-PAIR BACKTESTER (BALANCED)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pairs        : ${PAIRS.join(", ")}`);
  console.log(`  Initial Bal  : $${INITIAL_BALANCE}`);
  console.log(`${"═".repeat(60)}\n`);

  const allTimestamps = new Set();

  for (const pair of PAIRS) {
    const filename = `history_${pair.replace("/", "_")}.json`;
    if (!fs.existsSync(filename)) {
      console.error(`❌ History file not found for ${pair}: ${filename}`);
      continue;
    }
    const candles = JSON.parse(fs.readFileSync(filename, "utf8"));
    pairData[pair] = {
        candles,
        isJPY: pair.includes("JPY"),
        pipSize: pair.includes("JPY") ? 0.01 : 0.0001,
        activeTrades: [],
        lastSignal: null,
        lastLossTime: null,
        tradeHistory: [],
        candleIndex: 0
    };
    candles.forEach(c => allTimestamps.add(c.time));
  }

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => new Date(a) - new Date(b));
  const windowSize = 200; // REDUCED from 1000

  for (const timestamp of sortedTimestamps) {
    for (const pair of PAIRS) {
      const p = pairData[pair];
      if (!p) continue;

      while (p.candleIndex < p.candles.length && p.candles[p.candleIndex].time < timestamp) p.candleIndex++;
      if (p.candleIndex >= p.candles.length || p.candles[p.candleIndex].time !== timestamp || p.candleIndex < windowSize) continue;

      const currentCandles = p.candles.slice(p.candleIndex - windowSize, p.candleIndex);
      const nextCandle = p.candles[p.candleIndex];
      const indicators = calculateIndicators(currentCandles);
      
      const midOpen = parseFloat(nextCandle.mid.o);
      const midHigh = parseFloat(nextCandle.mid.h);
      const midLow  = parseFloat(nextCandle.mid.l);

      const spread = SPREAD_PIPS * p.pipSize;
      const hasActuals = nextCandle.bid && nextCandle.ask && (nextCandle.bid.c !== nextCandle.ask.c);
      const bidHigh = hasActuals ? parseFloat(nextCandle.bid.h) : midHigh - spread/2;
      const bidLow  = hasActuals ? parseFloat(nextCandle.bid.l) : midLow - spread/2;
      const askHigh = hasActuals ? parseFloat(nextCandle.ask.h) : midHigh + spread/2;
      const askLow  = hasActuals ? parseFloat(nextCandle.ask.l) : midLow + spread/2;

      manageActiveTrades(pair, indicators, midOpen);

      p.activeTrades = p.activeTrades.filter(trade => {
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) { closeTrade(pair, trade, trade.sl, "SL", timestamp); return false; }
          if (bidHigh >= trade.tp) { closeTrade(pair, trade, trade.tp, "TP", timestamp); return false; }
        } else {
          if (askHigh >= trade.sl) { closeTrade(pair, trade, trade.sl, "SL", timestamp); return false; }
          if (askLow <= trade.tp) { closeTrade(pair, trade, trade.tp, "TP", timestamp); return false; }
        }
        return true;
      });

      const dateObj = new Date(timestamp);
      const h = dateObj.getUTCHours();
      const day = dateObj.getUTCDay();
      const isSession = day !== 0 && day !== 6 && h >= config.sessionStartUTC && h < config.sessionEndUTC;
      
      if (!isSession) continue;
      if (p.lastLossTime && (new Date(timestamp) - new Date(p.lastLossTime)) / 60000 < config.lossCooldownMinutes) continue;

      let possibleActions = ["BUY", "SELL", "WAIT"];
      const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };
      const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;

      if (indicators.atr / p.pipSize < config.minAtrPips) continue;
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
        const totalGlobalTrades = Object.values(pairData).reduce((acc, pair) => acc + pair.activeTrades.length, 0);
        const tooClose = p.activeTrades.some(t => Math.abs(midOpen - t.entry) / p.pipSize < config.minTradeDistancePips);
        if (p.activeTrades.length < (config.maxTradesPerPair || 1) && totalGlobalTrades < (config.maxTotalTrades || 1) && !tooClose) {
           handleSignal(pair, action, midOpen, indicators, timestamp);
        }
      }
      p.lastSignal = action;
    }
  }

  function handleSignal(pair, action, price, indicators, time) {
    const p = pairData[pair];
    const { atrMultiplierSL, atrMultiplierTP } = config.strategy;
    const slDist = atrMultiplierSL * indicators.atr;
    const tpDist = atrMultiplierTP * indicators.atr;
    const slippage = SLIPPAGE_PIPS * p.pipSize;
    const entryPrice = action === "BUY" ? price + slippage : price - slippage;

    p.activeTrades.push({
      id: `${pair.substring(0,3)}-T${p.tradeHistory.length + 1}`,
      direction: action,
      entry: entryPrice,
      sl: action === "BUY" ? entryPrice - slDist : entryPrice + slDist,
      tp: action === "BUY" ? entryPrice + tpDist : entryPrice - tpDist,
      units: calculateUnits(pair, price, indicators, balance),
      time,
      isBreakeven: false
    });
    console.log(`  🚀 [${time}] ${pair} Opened ${action} at ${entryPrice.toFixed(5)}`);
  }

  function manageActiveTrades(pair, indicators, currentPrice) {
    const p = pairData[pair];
    if (p.activeTrades.length === 0 || !config.useBreakeven) return;
    for (const trade of p.activeTrades) {
      const profitPips = trade.direction === "BUY" ? (currentPrice - trade.entry) / p.pipSize : (trade.entry - currentPrice) / p.pipSize;
      if (profitPips >= (indicators.atr * config.breakevenTriggerATR) / p.pipSize) {
        const trailDist = indicators.atr * (config.trailingStopATR || 1.0);
        let newSL = trade.direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;
        const buffer = 1.0 * p.pipSize;
        const minSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
        if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
        if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;

        const currentSL = trade.sl;
        const shouldUpdate = trade.direction === "BUY" ? newSL > currentSL : newSL < currentSL;
        if (shouldUpdate) {
          trade.sl = newSL;
          trade.isBreakeven = true;
        }
      }
    }
  }

  function closeTrade(pair, trade, exitPrice, reason, exitTime) {
    const p = pairData[pair];
    const rawPnL = trade.direction === "BUY" ? (exitPrice - trade.entry) * trade.units : (trade.entry - exitPrice) * trade.units;
    const entryVol = pair.startsWith("USD") ? trade.units : (trade.units * trade.entry);
    const exitVol = pair.startsWith("USD") ? trade.units : (trade.units * exitPrice);
    const commission = ((entryVol / 100000) * COMMISSION_SIDE_USD) + ((exitVol / 100000) * COMMISSION_SIDE_USD);
    const netProfit = rawPnL - commission;
    if (netProfit < 0 && reason === "SL") p.lastLossTime = exitTime;
    balance += netProfit;
    p.tradeHistory.push({ ...trade, exit: exitPrice, exitTime, reason, profit: netProfit, balance });
    console.log(`  ✅ [${exitTime}] ${pair} Closed ${trade.id} (${reason}) | Net: $${netProfit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  function calculateUnits(pair, price, indicators, currentBalance) {
    const p = pairData[pair];
    const riskAmount = currentBalance * (config.riskPercentPerTrade / 100);
    const slDist = config.strategy.atrMultiplierSL * indicators.atr;
    const slPips = slDist / p.pipSize;
    let pipValue = 10;
    if (pair.startsWith("USD/")) pipValue = (p.pipSize / price) * 100000;
    const units = Math.floor((riskAmount / (slPips * pipValue)) * 100000);
    return Math.max(100, Math.floor(Math.min(units, 50000) / 100) * 100);
  }

  // Summary Logic (Unified)
  const allHistory = Object.values(pairData).flatMap(p => p.tradeHistory);
  const tT = allHistory.length;
  const wins = allHistory.filter(t => t.profit > 0);
  const losses = allHistory.filter(t => t.profit <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : Infinity;

  let peak = INITIAL_BALANCE, maxDD = 0, runningBal = INITIAL_BALANCE;
  allHistory.sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime)).forEach(t => {
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

  fs.writeFileSync("trades_backtest.json", JSON.stringify({ type: "backtest", timestamp: new Date().toISOString(), totalNetProfit: balance - INITIAL_BALANCE, totalTrades: tT, winRate, trades: allHistory }, null, 2));
}

main();
