/**
 * Backtest Runner for IC Markets Bot
 * Replicates the live trading environment (index.js) as closely as possible.
 *
 * Includes:
 *  - Spread simulation (Buy at Ask, Sell at Bid)
 *  - SL/TP hit detection using Bid/Ask prices
 *  - ATR-based SL/TP correction (same as index.js)
 *  - Accurate units calculation with Pip Value
 *  - IC Markets Commissions ($7/lot round turn)
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

const HISTORY_FILE = "history_EUR_USD.json"; // Use M1 history
const PAIR = pairArg || config.defaultInstrument || "EUR_USD";
const INITIAL_BALANCE = config.backtest.initialBalance || 500;
const MOCK_AI = mockArg;

// Constants for simulation
const IS_JPY = PAIR.includes("JPY");
const PIP_SIZE = IS_JPY ? 0.01 : 0.0001;
const SPREAD = (config.backtest.spreadPips || 0.1) * PIP_SIZE;
const SLIPPAGE = (config.backtest.slippagePips || 0) * PIP_SIZE;
const COMMISSION_SIDE_USD = config.backtest.commissionPerSideUSD || 3.00;

async function main() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.error(`❌ History file not found: ${HISTORY_FILE}`);
    console.log(`\nTo get a data dump, run:`);
    console.log(`  npm run download\n`);
    process.exit(1);
  }

  const allCandles = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  IC MARKETS BACKTESTER (PRO)`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Pair         : ${PAIR}`);
  console.log(`  Candles      : ${allCandles.length}`);
  console.log(`  Spread       : ${config.backtest.spreadPips} pips`);
  console.log(`  Commission   : $${config.backtest.commissionPerSideUSD.toFixed(2)} per $100k volume (Side)`);
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

  let balance = INITIAL_BALANCE;
  let activeTrades = [];
  let tradeHistory = [];
  let lastSignal = null;
  let lastLossTime = null; // timestamp

  const windowSize = 200;

  for (let i = windowSize; i < allCandles.length; i++) {
    const currentCandles = allCandles.slice(i - windowSize, i);
    const nextCandle = allCandles[i]; 
    const timestamp = nextCandle.time;

    // 2. Calculate indicators
    const indicators = calculateIndicators(currentCandles);

    // Prices for indicators and simulation
    const midOpen = parseFloat(nextCandle.mid.o);
    const midHigh = parseFloat(nextCandle.mid.h);
    const midLow  = parseFloat(nextCandle.mid.l);

    // 1. Update active trades (check SL/TP)
    // IMPORTANT: BUY trades hit SL/TP on BID price. SELL trades hit on ASK price.
    // Use actual Bid/Ask if available and different, otherwise simulate from Mid + Spread
    const hasActuals = nextCandle.bid && nextCandle.ask && (nextCandle.bid.c !== nextCandle.ask.c);
    
    const bidHigh = hasActuals ? parseFloat(nextCandle.bid.h) : midHigh - SPREAD/2;
    const bidLow  = hasActuals ? parseFloat(nextCandle.bid.l) : midLow - SPREAD/2;
    const bidOpen = hasActuals ? parseFloat(nextCandle.bid.o) : midOpen - SPREAD/2;
    
    const askHigh = hasActuals ? parseFloat(nextCandle.ask.h) : midHigh + SPREAD/2;
    const askLow  = hasActuals ? parseFloat(nextCandle.ask.l) : midLow + SPREAD/2;
    const askOpen = hasActuals ? parseFloat(nextCandle.ask.o) : midOpen + SPREAD/2;

    const currentAsk = askOpen;
    const currentBid = bidOpen;

    // Simulation of reactive loop within the candle
    // We treat each candle as multiple "checks" (though with M5 data, we can only see the H/L/C)
    // BUT we can prioritize SL/TP hits more accurately.
    
    // 0. Manage active trades (Trailing Stop / Breakeven)
    manageActiveTrades(indicators, midOpen);

    activeTrades = activeTrades.filter(trade => {
      // Intra-candle SL/TP detection
      if (trade.direction === "BUY") {
        if (bidLow <= trade.sl) {
          closeTrade(trade, trade.sl, "SL", timestamp);
          return false;
        }
        if (bidHigh >= trade.tp) {
          closeTrade(trade, trade.tp, "TP", timestamp);
          return false;
        }
      } else { // SELL
        if (askHigh >= trade.sl) {
          closeTrade(trade, trade.sl, "SL", timestamp);
          return false;
        }
        if (askLow <= trade.tp) {
          closeTrade(trade, trade.tp, "TP", timestamp);
          return false;
        }
      }
      return true;
    });

    // --- LIVE REPLICATION: Session Filtering ---
    const dateObj = new Date(timestamp);
    const sessionH = dateObj.getUTCHours();
    const sessionDay = dateObj.getUTCDay();
    const isWeekend = sessionDay === 0 || sessionDay === 6;
    const isTradingSession = !isWeekend && sessionH >= config.sessionStartUTC && sessionH < config.sessionEndUTC;

    if (!isTradingSession) {
      if (lastSignal && lastSignal !== "WAIT") lastSignal = "WAIT";
      continue; // Skip signal checking during off-hours
    }

    // --- Loss Cooldown Filter ---
    if (lastLossTime) {
      const minsSinceLoss = (new Date(timestamp) - new Date(lastLossTime)) / (60 * 1000);
      if (minsSinceLoss < config.lossCooldownMinutes) {
        continue;
      }
    }

    // 3. HTF Context (Aggregation)
    const htfIndicators = getHTFIndicators(currentCandles);

    // 4. Generate Signal (using index.js filters)
    let possibleActions = ["BUY", "SELL", "WAIT"];
    const pairCfg = { ...config.strategy, ...(config.pairOverrides?.[PAIR] || {}) };
    const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;
    const fastEma = indicators[`ema${emaFast}`];
    const slowEma = indicators[`ema${emaSlow}`];

    // ADX Trend Strength Floor (filter choppy/ranging markets)
    const atrPips = indicators.atr / PIP_SIZE;
    if (atrPips < config.minAtrPips) { possibleActions = ["WAIT"]; }
    if (indicators.adx !== null && indicators.adx < (pairCfg.minAdx || 18)) { possibleActions = ["WAIT"]; }

    if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

    if (fastEma <= slowEma) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (fastEma >= slowEma) possibleActions = possibleActions.filter(a => a !== "SELL");

    // Falling knife protection
    const isSharpDrop = indicators.momentum < -1.2 * indicators.atr;
    const isSharpRise = indicators.momentum > 1.2 * indicators.atr;
    if (isSharpDrop) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (isSharpRise) possibleActions = possibleActions.filter(a => a !== "SELL");

    // Distance check
    const tooClose = activeTrades.some(t => {
      const distPips = Math.abs(midOpen - t.entry) / PIP_SIZE;
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

    if (i % 1000 === 0) {
       // Debug Log
       // console.log(`[DEBUG ${timestamp}] RSI: ${indicators.rsi.toFixed(1)}, ADX: ${indicators.adx?.toFixed(1)}, Actions: ${possibleActions.join(",")}`);
    }

    if (aiNeeded) { 
       try {
         let signal;
         if (MOCK_AI) {
           const { atrMultiplierSL, atrMultiplierTP } = pairCfg;

           // institutional Mock: Buying/Selling Extremes (Mean Reversion in a Trend)
           const isOverbought = indicators.rsi > rsiThresholdHigh && midOpen > (indicators.bbands.upper - (0.5 * indicators.atr));
           const isOversold   = indicators.rsi < rsiThresholdLow  && midOpen < (indicators.bbands.lower + (0.5 * indicators.atr));
           
           // Momentum confirmation: MACD histogram turning in entry direction
           const macdHist = indicators.macd.hist;
           const prevHist = indicators.prevMacdHist;
           const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
           const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

           // Confirmation gate
           const hasBuyConfirmation  = indicators.isBullishRejection || macdTurningBullish || indicators.volumeRatio >= (pairCfg.minVolumeRatio || 0.8);
           const hasSellConfirmation = indicators.isBearishRejection || macdTurningBearish || indicators.volumeRatio >= (pairCfg.minVolumeRatio || 0.8);

           const action = (isOversold  && hasBuyConfirmation && possibleActions.includes("BUY"))  ? "BUY" :
                          (isOverbought && hasSellConfirmation && possibleActions.includes("SELL")) ? "SELL" : "WAIT";

           const atr = indicators.atr || (PIP_SIZE * 15);
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
           const systemPrompt = getSystemPrompt(PAIR);
           const userPrompt = getUserPrompt(PAIR, config.granularity, indicators, currentCandles.slice(-30), htfIndicators, possibleActions);
           
           process.stdout.write(`[${timestamp}] AI Query... `);
           const startTime = Date.now();
           signal = await ai.getSignal(systemPrompt, userPrompt);
           const latency = ((Date.now() - startTime) / 1000).toFixed(1);
           console.log(`${signal.action} (${signal.confidence}%) [${latency}s]`);
         }

         // --- LIVE REPLICATION: Signal Validation ---
         if (signal.action !== "WAIT") {
            // Entry correction
            if (Math.abs(signal.entry - midOpen) / midOpen > (config.maxPriceDeviationPercent / 100)) {
                signal.entry = midOpen;
            }
            handleSignal(signal, askOpen, bidOpen, timestamp, indicators);
         }
       } catch (err) {
         console.log(`[${timestamp}] ❌ AI Error: ${err.message}`);
       }
    } else if (lastSignal && lastSignal !== "WAIT") {
        lastSignal = "WAIT";
    }
  }

  function handleSignal(signal, ask, bid, time, indicators) {
    const isFlip = lastSignal && lastSignal !== signal.action;
    
    if (isFlip) {
      const opposite = signal.action === "BUY" ? "SELL" : "BUY";
      activeTrades.filter(t => t.direction === opposite).forEach(t => {
          const p = t.direction === "BUY" ? bid - SLIPPAGE : ask + SLIPPAGE;
          closeTrade(t, p, "FLIP", time);
      });
      activeTrades = activeTrades.filter(t => t.direction !== opposite);
    }

    if (activeTrades.length < config.maxConcurrentTrades) {
      const units = calculateUnits(signal, indicators, balance);
      if (units > 0) {
        const entryPrice = signal.action === "BUY" ? ask + SLIPPAGE : bid - SLIPPAGE;
        const trade = {
            id: `T${tradeHistory.length + 1}`,
            direction: signal.action,
            entry: entryPrice,
            sl: signal.stopLoss,
            tp: signal.takeProfit,
            units: units,
            time,
            isBreakeven: false
        };
        activeTrades.push(trade);
        console.log(`  🚀 [${time}] Opened ${trade.direction} at ${trade.entry.toFixed(5)} (Units: ${trade.units})`);
      }
    }
    lastSignal = signal.action;
  }

  function manageActiveTrades(indicators, currentPrice) {
    if (activeTrades.length === 0 || !config.useBreakeven) return;

    for (const trade of activeTrades) {
      const profitPips = trade.direction === "BUY" ? (currentPrice - trade.entry) / PIP_SIZE : (trade.entry - currentPrice) / PIP_SIZE;
      const triggerPips = (indicators.atr * config.breakevenTriggerATR) / PIP_SIZE;

      if (profitPips >= triggerPips) {
        if (config.useTrailingStop) {
          const trailDist = indicators.atr * (config.trailingStopATR || 1.5);
          let newSL = trade.direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;
          const buffer = 1.0 * PIP_SIZE;
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
          trade.sl = trade.direction === "BUY" ? trade.entry + 1.0 * PIP_SIZE : trade.entry - 1.0 * PIP_SIZE;
          trade.isBreakeven = true;
        }
      }
    }
  }

  function closeTrade(trade, exitPrice, reason, exitTime) {
    const rawPnL = trade.direction === "BUY" ? (exitPrice - trade.entry) * trade.units : (trade.entry - exitPrice) * trade.units;
    const entryVolumeUSD = PAIR.startsWith("USD") ? trade.units : (trade.units * trade.entry);
    const exitVolumeUSD = PAIR.startsWith("USD") ? trade.units : (trade.units * exitPrice);
    const commission = ((entryVolumeUSD / 100000) * COMMISSION_SIDE_USD) + ((exitVolumeUSD / 100000) * COMMISSION_SIDE_USD);
    const netProfit = rawPnL - commission;
    if (netProfit < 0 && reason === "SL") lastLossTime = exitTime;
    balance += netProfit;
    tradeHistory.push({ ...trade, exit: exitPrice, exitTime, reason, profit: netProfit, balance });
    console.log(`  ✅ [${exitTime}] Closed ${trade.id} (${reason}) | Net PnL: $${netProfit.toFixed(2)} | Balance: $${balance.toFixed(2)}`);
  }

  function calculateUnits(signal, indicators, currentBalance) {
    const riskAmount = currentBalance * (config.riskPercentPerTrade / 100);
    const slDistance = Math.abs(signal.entry - signal.stopLoss);
    if (slDistance === 0) return 0;
    const slPips = slDistance / PIP_SIZE;
    let pipValue = 10;
    if (PAIR.startsWith("USD/")) pipValue = (PIP_SIZE / signal.entry) * 100000;
    const lots = riskAmount / (slPips * pipValue);
    let units = Math.floor(lots * 100000);
    if (units > 100000) units = 100000;
    return Math.max(100, Math.floor(units / 100) * 100);
  }

  function getHTFIndicators(candles) {
    const htfFactor = 5; // M1 to M5
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
    return htfCandles.length > 50 ? calculateIndicators(htfCandles) : null;
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊  FINAL RESULTS`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total Trades : ${tradeHistory.length}`);
  const wins = tradeHistory.filter(t => t.profit > 0).length;
  const netPnL = balance - INITIAL_BALANCE;
  console.log(`  Win Rate     : ${((wins / Math.max(1, tradeHistory.length)) * 100).toFixed(1)}%`);
  console.log(`  Net Profit   : $${netPnL.toFixed(2)} (${((balance/INITIAL_BALANCE - 1)*100).toFixed(2)}%)`);
  console.log(`${"═".repeat(60)}\n`);
}

main();
