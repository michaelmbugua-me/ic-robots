/**
 * Backtest Runner for IC Markets Bot (Multi-Pair)
 * Replicates the live trading environment (index.js) as closely as possible.
 */

import fs from "fs";
import { calculateIndicators } from "./indicators.js";
import { createAIClient, getSystemPrompt, getUserPrompt } from "./ai.js";
import { config } from "./config.js";

const args = process.argv.slice(2);
const pairArg = args.find(a => a.startsWith('--pair='))?.split('=')[1]
              || (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null);
const providerArg = args.find(a => a.startsWith('--provider='))?.split('=')[1]
              || (args.includes('--provider') ? args[args.indexOf('--provider') + 1] : null);
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1]
              || (args.includes('--model') ? args[args.indexOf('--model') + 1] : null);
const mockArg = args.includes('--mock');

// Override config from CLI
if (providerArg) config.aiProvider = providerArg;
if (modelArg) {
  if (config.aiProvider === "ollama") config.ollama.model = modelArg;
  else config.anthropicModel = modelArg;
}

const PAIRS = pairArg ? pairArg.split(",").map(s => s.trim()) : config.tradingPairs;
const INITIAL_BALANCE = config.backtest.initialBalance || 500;
const MOCK_AI = mockArg;
const COMMISSION_SIDE_USD = config.backtest.commissionPerSideUSD || 3.00;

// Global state for helper functions
let balance = INITIAL_BALANCE;
const pairData = {};

function calculateUnits(pair, signal, indicators, currentBalance) {
  const p = pairData[pair];
  const riskPercent = config.riskPercentPerTrade || 2.0;
  const riskAmount = currentBalance * (riskPercent / 100);
  const slDistance = Math.abs(signal.entry - signal.stopLoss);
  if (slDistance === 0) return 0;

  const slPips = slDistance / p.pipSize;
  let pipValue = 10;
  if (pair.startsWith("USD/")) pipValue = (p.pipSize / signal.entry) * 100000;
  else if (!pair.endsWith("_USD") && !pair.endsWith("/USD")) pipValue = (p.pipSize / signal.entry) * 100000;

  const lots = riskAmount / (slPips * pipValue);
  let units = Math.floor(lots * 100000);
  const maxUnits = config.maxPositionSizeUnits || 50000;
  if (units > maxUnits) units = maxUnits;

  const minVol = 100;
  const stepVol = 100;
  units = Math.floor(units / stepVol) * stepVol;
  return units < minVol ? 0 : units;
}

function closeTrade(pair, trade, exitPrice, reason, exitTime) {
  const p = pairData[pair];
  const rawPnL = trade.direction === "BUY" ? (exitPrice - trade.entry) * trade.units : (trade.entry - exitPrice) * trade.units;

  const entryVolumeUSD = pair.startsWith("USD") ? trade.units : (trade.units * trade.entry);
  const exitVolumeUSD = pair.startsWith("USD") ? trade.units : (trade.units * exitPrice);
  const commission = ((entryVolumeUSD / 100000) * COMMISSION_SIDE_USD) + ((exitVolumeUSD / 100000) * COMMISSION_SIDE_USD);

  const netProfit = rawPnL - commission;
  if (netProfit < 0 && reason === "SL") p.lastLossTime = exitTime;

  balance += netProfit;
  const result = { ...trade, exit: exitPrice, exitTime, reason, profit: netProfit, balance };
  p.tradeHistory.push(result);
  console.log(`  ✅ [${exitTime}] ${pair} Closed ${trade.id} (${reason}) | Net PnL: $${netProfit.toFixed(2)} | Balance: $${balance.toFixed(2)}`);
}

function handleSignal(pair, signal, ask, bid, time, indicators) {
  const p = pairData[pair];
  const isFlip = p.lastSignal && p.lastSignal !== signal.action;

  if (isFlip) {
    const opposite = signal.action === "BUY" ? "SELL" : "BUY";
    p.activeTrades.filter(t => t.direction === opposite).forEach(t => {
        const exitPrice = t.direction === "BUY" ? bid - (config.backtest.slippagePips * p.pipSize) : ask + (config.backtest.slippagePips * p.pipSize);
        closeTrade(pair, t, exitPrice, "FLIP", time);
    });
    p.activeTrades = p.activeTrades.filter(t => t.direction !== opposite);
  }

  // Check global max trades across all pairs
  const totalGlobalTrades = Object.values(pairData).reduce((acc, pair) => acc + pair.activeTrades.length, 0);

  if (p.activeTrades.length < (config.maxConcurrentTrades || 1) && totalGlobalTrades < (config.maxTotalTrades || 1)) {
    const units = calculateUnits(pair, signal, indicators, balance);
    if (units > 0) {
      const slippage = (config.backtest.slippagePips || 0) * p.pipSize;
      const entryPrice = signal.action === "BUY" ? ask + slippage : bid - slippage;
      const trade = {
          id: `${pair.substring(0,3)}-T${p.tradeHistory.length + 1}`,
          direction: signal.action,
          entry: entryPrice,
          sl: signal.stopLoss,
          tp: signal.takeProfit,
          units: units,
          time,
          isBreakeven: false
      };
      p.activeTrades.push(trade);
      console.log(`  🚀 [${time}] ${pair} Opened ${trade.direction} at ${trade.entry.toFixed(5)} (Units: ${trade.units})`);
    }
  }
  p.lastSignal = signal.action;
}

function manageActiveTrades(pair, indicators, currentPrice) {
  const p = pairData[pair];
  if (p.activeTrades.length === 0 || !config.useBreakeven) return;
  const pc = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };
  const beTrigger = pc.breakevenTriggerATR ?? config.breakevenTriggerATR;
  const trailMul = pc.trailingStopATR ?? config.trailingStopATR ?? 1.0;

  for (const trade of p.activeTrades) {
    const profitPips = trade.direction === "BUY"
      ? (currentPrice - trade.entry) / p.pipSize
      : (trade.entry - currentPrice) / p.pipSize;

    const triggerPips = (indicators.atr * beTrigger) / p.pipSize;

    if (profitPips >= triggerPips) {
      if (config.useTrailingStop) {
        const trailDist = indicators.atr * trailMul;
        let newSL = trade.direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;

        const buffer = 1.0 * p.pipSize;
        const minSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
        if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
        if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;

        const shouldUpdate = trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl;
        if (shouldUpdate) {
          trade.sl = newSL;
          trade.isBreakeven = true;
        }
      } else {
        if (trade.isBreakeven) continue;
        const buffer = 1.0 * p.pipSize;
        const newSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
        trade.sl = newSL;
        trade.isBreakeven = true;
      }
    }
  }
}

function getHTFIndicators(candles, customFactor = null) {
  let htfIndicators = null;
  const defaultFactor = config.granularity === "M5" ? 3 : (config.granularity === "M15" ? 4 : 1);
  const htfFactor = customFactor || defaultFactor;

  if (htfFactor > 1) {
    const htfCandles = [];
    for (let j = 0; j < candles.length; j += htfFactor) {
      const chunk = candles.slice(j, j + htfFactor);
      if (chunk.length === htfFactor) {
        htfCandles.push({
          time: chunk[0].time,
          mid: {
            o: chunk[0].mid.o,
            h: Math.max(...chunk.map(c => parseFloat(c.mid.h))).toFixed(5),
            l: Math.min(...chunk.map(c => parseFloat(c.mid.l))).toFixed(5),
            c: chunk[chunk.length - 1].mid.c
          },
          volume: chunk.reduce((s, c) => s + (c.volume || 0), 0)
        });
      }
    }
    if (htfCandles.length > 50) htfIndicators = calculateIndicators(htfCandles);
  }
  return htfIndicators;
}

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  IC MARKETS MULTI-PAIR BACKTESTER`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pairs        : ${PAIRS.join(", ")}`);
  console.log(`  Initial Bal  : $${INITIAL_BALANCE}`);
  console.log(`  AI Mode      : ${MOCK_AI ? "MOCK (Fast/Free)" : config.aiProvider + " (" + (config.aiProvider === "ollama" ? config.ollama.model : config.anthropicModel) + ")"} `);
  console.log(`${"═".repeat(60)}\n`);

  const ai = createAIClient();

  if (!MOCK_AI) {
    process.stdout.write("Connecting to AI...");
    try {
      await ai.healthCheck();
      console.log(" ✓\n");
    } catch (err) {
      console.log(" ❌\n");
      console.error(`  ⚠️  AI error: ${err.message}`);
      process.exit(1);
    }
  }

  // Load data for all pairs
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
        spread: (config.backtest.spreadPips || 0.1) * (pair.includes("JPY") ? 0.01 : 0.0001),
        activeTrades: [],
        lastSignal: null,
        lastLossTime: null,
        tradeHistory: [],
        candleIndex: 0
    };
    candles.forEach(c => allTimestamps.add(c.time));
  }

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => new Date(a) - new Date(b));
  const windowSize = 1000;

  for (const timestamp of sortedTimestamps) {
    for (const pair of PAIRS) {
      const p = pairData[pair];
      if (!p) continue;

      // Find the candle for this timestamp
      while (p.candleIndex < p.candles.length && p.candles[p.candleIndex].time < timestamp) {
          p.candleIndex++;
      }

      if (p.candleIndex >= p.candles.length || p.candles[p.candleIndex].time !== timestamp) {
          continue; // No data for this pair at this timestamp
      }

      if (p.candleIndex < windowSize) {
          continue; // Not enough history yet for indicators
      }

      const currentCandles = p.candles.slice(p.candleIndex - windowSize, p.candleIndex);
      const nextCandle = p.candles[p.candleIndex];
      const indicators = calculateIndicators(currentCandles);
      
      const htfIndicators = getHTFIndicators(currentCandles);
      const h1Factor = config.granularity === "M5" ? 12 : (config.granularity === "M15" ? 4 : 1);
      const h1Indicators = h1Factor > 1 ? getHTFIndicators(currentCandles, h1Factor) : indicators;

      if (h1Indicators) {
        indicators.ema200 = h1Indicators.ema200;
        indicators.srZone = h1Indicators.srZone;
        indicators.nearSupport = h1Indicators.nearSupport;
        indicators.nearResistance = h1Indicators.nearResistance;
      }

      const midOpen = parseFloat(nextCandle.mid.o);
      const midHigh = parseFloat(nextCandle.mid.h);
      const midLow  = parseFloat(nextCandle.mid.l);

      const hasActuals = nextCandle.bid && nextCandle.ask && (nextCandle.bid.c !== nextCandle.ask.c);
      const bidHigh = hasActuals ? parseFloat(nextCandle.bid.h) : midHigh - p.spread/2;
      const bidLow  = hasActuals ? parseFloat(nextCandle.bid.l) : midLow - p.spread/2;
      const askHigh = hasActuals ? parseFloat(nextCandle.ask.h) : midHigh + p.spread/2;
      const askLow  = hasActuals ? parseFloat(nextCandle.ask.l) : midLow + p.spread/2;
      const askOpen = hasActuals ? parseFloat(nextCandle.ask.o) : midOpen + p.spread/2;
      const bidOpen = hasActuals ? parseFloat(nextCandle.bid.o) : midOpen - p.spread/2;

      const currentAsk = askOpen;
      const currentBid = bidOpen;

      // 0. Manage active trades (Trailing SL, etc.)
      manageActiveTrades(pair, indicators, midOpen);

      // 1. Check SL/TP
      p.activeTrades = p.activeTrades.filter(trade => {
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) {
            closeTrade(pair, trade, trade.sl, "SL", timestamp);
            return false;
          }
          if (bidHigh >= trade.tp) {
            closeTrade(pair, trade, trade.tp, "TP", timestamp);
            return false;
          }
        } else { // SELL
          if (askHigh >= trade.sl) {
            closeTrade(pair, trade, trade.sl, "SL", timestamp);
            return false;
          }
          if (askLow <= trade.tp) {
            closeTrade(pair, trade, trade.tp, "TP", timestamp);
            return false;
          }
        }
        return true;
      });

      // 2. Session/Cooldown filtering
      const dateObj = new Date(timestamp);
      const sessionH = dateObj.getUTCHours();
      const sessionDay = dateObj.getUTCDay();
      const isWeekend = sessionDay === 0 || sessionDay === 6;
      const isTradingSession = !isWeekend && sessionH >= config.sessionStartUTC && sessionH < config.sessionEndUTC;
      if (!isTradingSession) {
        if (p.lastSignal && p.lastSignal !== "WAIT") p.lastSignal = "WAIT";
        continue;
      }

      if (p.lastLossTime) {
        const minsSinceLoss = (new Date(timestamp) - new Date(p.lastLossTime)) / (60 * 1000);
        if (minsSinceLoss < config.lossCooldownMinutes) continue;
      }

      // 3. HTF and Filters
      let possibleActions = ["BUY", "SELL", "WAIT"];
      const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;
      const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[pair] || {}) };
      const fastEma = indicators[`ema${emaFast}`];
      const slowEma = indicators[`ema${emaSlow}`];

      const atrPips = indicators.atr / p.pipSize;
      if (atrPips < config.minAtrPips) { possibleActions = ["WAIT"]; }
      if (indicators.adx !== null && indicators.adx < (pairCfg.minAdx || 18)) { possibleActions = ["WAIT"]; }

      if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
      if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

      if (fastEma <= slowEma) possibleActions = possibleActions.filter(a => a !== "BUY");
      if (fastEma >= slowEma) possibleActions = possibleActions.filter(a => a !== "SELL");

      const ema200 = indicators.ema200;
      if (ema200 && midOpen > ema200) possibleActions = possibleActions.filter(a => a !== "SELL");
      if (ema200 && midOpen < ema200) possibleActions = possibleActions.filter(a => a !== "BUY");

      // Falling Knife Filter
      const isSharpDrop = indicators.momentum < -1.2 * indicators.atr;
      const isSharpRise = indicators.momentum > 1.2 * indicators.atr;
      if (isSharpDrop) possibleActions = possibleActions.filter(a => a !== "BUY");
      if (isSharpRise) possibleActions = possibleActions.filter(a => a !== "SELL");

      // Distance check
      const tooClose = p.activeTrades.some(t => {
        const distPips = Math.abs(midOpen - t.entry) / p.pipSize;
        return distPips < config.minTradeDistancePips;
      });
      if (tooClose) possibleActions = ["WAIT"];

      if (htfIndicators) {
        const htfFastEma = htfIndicators[`ema${emaFast}`];
        const htfSlowEma = htfIndicators[`ema${emaSlow}`];
        const htfTrend = htfFastEma > htfSlowEma ? "UP" : "DOWN";
        if (htfTrend === "DOWN") possibleActions = possibleActions.filter(a => a !== "BUY");
        if (htfTrend === "UP")   possibleActions = possibleActions.filter(a => a !== "SELL");
      }

      const aiNeeded = possibleActions.length > 1;

      if (aiNeeded) {
        try {
          let signal;
          if (MOCK_AI) {
            const { rsiThresholdLow, rsiThresholdHigh } = config.strategy;
            const { atrMultiplierSL, atrMultiplierTP } = pairCfg;
            const strategyMode = pairCfg.strategyMode || "pullback";

            const macdHist = indicators.macd.hist;
            const prevHist = indicators.prevMacdHist;
            const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
            const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

            const minConfirmations = pairCfg.minConfirmations || 1;
            const minVolRatio = pairCfg.minVolumeRatio || 1.0;

            let action = "WAIT";

            if (strategyMode === "momentum") {
              // MOMENTUM placeholder
              action = "WAIT";
            } else {
              // ─── PULLBACK STRATEGY (EUR_USD, default) ───
              // Restored high WR thresholds for mock backtest
              const isOverbought = indicators.rsi > rsiThresholdHigh && midOpen > (indicators.bbands.upper - (0.5 * indicators.atr));
              const isOversold   = indicators.rsi < rsiThresholdLow  && midOpen < (indicators.bbands.lower + (0.5 * indicators.atr));

              const vwapBuyBias  = indicators.vwap ? midOpen < indicators.vwap : true;
              const vwapSellBias = indicators.vwap ? midOpen > indicators.vwap : true;

              let buyConf = 0;
              if (macdTurningBullish) buyConf++;
              if (indicators.isBullishRejection) buyConf++;
              if (indicators.volumeRatio >= minVolRatio) buyConf++;
              const hasBuyConfirmation = buyConf >= minConfirmations;

              let sellConf = 0;
              if (macdTurningBearish) sellConf++;
              if (indicators.isBearishRejection) sellConf++;
              if (indicators.volumeRatio >= minVolRatio) sellConf++;
              const hasSellConfirmation = sellConf >= minConfirmations;

              action = (isOversold  && !isSharpDrop && hasBuyConfirmation && vwapBuyBias  && possibleActions.includes("BUY"))  ? "BUY" :
                       (isOverbought && !isSharpRise && hasSellConfirmation && vwapSellBias && possibleActions.includes("SELL")) ? "SELL" : "WAIT";
              
              // Phase 3: Price Action Trigger Gate (Optional Hardening)
              if (action !== "WAIT" && config.strategy.usePriceActionTrigger) {
                const isBuy = action === "BUY";
                const hasPAConfirm = isBuy ? indicators.hasBullishPriceAction : indicators.hasBearishPriceAction;
                if (!hasPAConfirm) {
                    action = "WAIT";
                }
              }
            }

            const atr = indicators.atr || (p.pipSize * 15);
            const slDist = atrMultiplierSL * atr;
            const tpDist = atrMultiplierTP * atr;

            signal = {
              action,
              confidence: 85,
              sentiment: action === "BUY" ? "Bullish" : action === "SELL" ? "Bearish" : "Neutral",
              sentimentScore: 85,
              entry: midOpen,
              stopLoss: action === "BUY" ? midOpen - slDist : midOpen + slDist,
              takeProfit: action === "BUY" ? midOpen + tpDist : midOpen - tpDist,
              reasoning: `Mock AI: Value Area Entry`
            };
          } else {
            const systemPrompt = getSystemPrompt(pair);
            const userPrompt = getUserPrompt(pair, config.granularity, indicators, currentCandles.slice(-30), htfIndicators, possibleActions);
            signal = await ai.getSignal(systemPrompt, userPrompt);
          }

          if (signal.action !== "WAIT" && signal.confidence >= (config.minConfidenceToExecute || 80)) {
            handleSignal(pair, signal, currentAsk, currentBid, timestamp, indicators);
          }
        } catch (err) {
          console.log(`[${timestamp}] ${pair} ❌ Error: ${err.message}`);
        }
      } else if (p.lastSignal && p.lastSignal !== "WAIT") {
          p.lastSignal = "WAIT";
      }
    }
  }

  // Final Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊  FINAL RESULTS (OVERALL)`);
  console.log(`${"═".repeat(60)}`);
  
  let totalTrades = 0;
  let totalWins = 0;
  let totalNetProfit = 0;
  const allTradeHistory = [];

  for (const pair of PAIRS) {
    const p = pairData[pair];
    if (!p) continue;
    const pairTrades = p.tradeHistory.length;
    const pairWins = p.tradeHistory.filter(t => t.profit > 0).length;
    const pairNet = p.tradeHistory.reduce((s, t) => s + t.profit, 0);
    const pairTPs = p.tradeHistory.filter(t => t.reason === "TP").length;

    totalTrades += pairTrades;
    totalWins += pairWins;
    totalNetProfit += pairNet;
    allTradeHistory.push(...p.tradeHistory);

    console.log(`  ${pair.padEnd(10)}: ${pairTrades} trades, Win Rate: ${((pairWins/Math.max(1,pairTrades))*100).toFixed(1)}%, TPs: ${pairTPs}, Net: $${pairNet.toFixed(2)}`);
  }

  // Compute detailed stats
  const wins = allTradeHistory.filter(t => t.profit > 0);
  const losses = allTradeHistory.filter(t => t.profit <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : 0;
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : Infinity;

  // Max drawdown
  let peak = INITIAL_BALANCE;
  let maxDD = 0;
  let runningBal = INITIAL_BALANCE;
  for (const t of allTradeHistory.sort((a, b) => new Date(a.exitTime) - new Date(b.exitTime))) {
    runningBal += t.profit;
    if (runningBal > peak) peak = runningBal;
    const dd = ((peak - runningBal) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Save results for analysis
  const backtestResults = {
    type: "backtest",
    timestamp: new Date().toISOString(),
    totalNetProfit,
    totalTrades,
    winRate: ((totalWins / Math.max(1, totalTrades)) * 100).toFixed(1),
    trades: allTradeHistory
  };
  fs.writeFileSync("trades_backtest.json", JSON.stringify(backtestResults, null, 2));
  console.log(`  📁 Results saved to trades_backtest.json for dashboard analysis.`);

  console.log(`${"-".repeat(60)}`);
  console.log(`  Total Trades  : ${totalTrades}`);
  console.log(`  Win Rate      : ${((totalWins / Math.max(1, totalTrades)) * 100).toFixed(1)}%`);
  console.log(`  Avg Win       : $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss      : $${avgLoss.toFixed(2)}`);
  console.log(`  Profit Factor : ${profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown  : ${maxDD.toFixed(2)}%`);
  console.log(`  Net Profit    : $${totalNetProfit.toFixed(2)} (${((balance/INITIAL_BALANCE - 1)*100).toFixed(2)}%)`);
  console.log(`  Final Bal     : $${balance.toFixed(2)}`);
  console.log(`${"═".repeat(60)}\n`);
}

main();
