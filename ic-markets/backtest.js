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

const HISTORY_FILE = "history.json";
const PAIR = pairArg || config.defaultInstrument || "EUR_USD";
const INITIAL_BALANCE = config.backtest.initialBalance || 200;
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

    // 0. Manage active trades (Breakeven, etc.)
    manageActiveTrades(indicators, midOpen);

    activeTrades = activeTrades.filter(trade => {
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
    const { rsiThresholdLow, rsiThresholdHigh, emaFast, emaSlow } = config.strategy;
    const fastEma = indicators[`ema${emaFast}`];
    const slowEma = indicators[`ema${emaSlow}`];

    // ADX Trend Strength Floor (filter choppy/ranging markets)
    const atrPips = indicators.atr / PIP_SIZE;
    if (atrPips < config.minAtrPips) { possibleActions = ["WAIT"]; }
    if (indicators.adx !== null && indicators.adx < (config.strategy.minAdx || 18)) { possibleActions = ["WAIT"]; }

    if (indicators.rsi > rsiThresholdHigh + 20) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (indicators.rsi < rsiThresholdLow - 20) possibleActions = possibleActions.filter(a => a !== "SELL");

    if (fastEma <= slowEma) possibleActions = possibleActions.filter(a => a !== "BUY");
    if (fastEma >= slowEma) possibleActions = possibleActions.filter(a => a !== "SELL");

    // Falling Knife Filter
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

    if (aiNeeded) { 
       try {
         let signal;
         if (MOCK_AI) {
           const { rsiThresholdLow, rsiThresholdHigh, atrMultiplierSL, atrMultiplierTP, emaFast, emaSlow } = config.strategy;
           const fastEma = indicators[`ema${emaFast}`];
           const slowEma = indicators[`ema${emaSlow}`];

           // Institutional Mock: Buying/Selling Extremes (Mean Reversion in a Trend)
           const isOverbought = indicators.rsi > rsiThresholdHigh && midOpen > (indicators.bbands.upper - (0.5 * indicators.atr));
           const isOversold   = indicators.rsi < rsiThresholdLow  && midOpen < (indicators.bbands.lower + (0.5 * indicators.atr));
           
           // Falling knife protection
           const isSharpDrop = indicators.momentum < -1.5 * indicators.atr;
           const isSharpRise = indicators.momentum > 1.5 * indicators.atr;

           // Momentum confirmation: MACD histogram turning in entry direction
           const macdHist = indicators.macd.hist;
           const prevHist = indicators.prevMacdHist;
           const macdTurningBullish = macdHist !== null && prevHist !== null && (macdHist > prevHist);
           const macdTurningBearish = macdHist !== null && prevHist !== null && (macdHist < prevHist);

           // Confirmation gate: rejection candle, volume spike, or MACD turning
           const hasBuyConfirmation  = indicators.isBullishRejection || macdTurningBullish || indicators.volumeRatio >= (config.strategy.minVolumeRatio || 0.8);
           const hasSellConfirmation = indicators.isBearishRejection || macdTurningBearish || indicators.volumeRatio >= (config.strategy.minVolumeRatio || 0.8);

           const action = (isOversold  && !isSharpDrop && hasBuyConfirmation)  ? "BUY" :
                          (isOverbought && !isSharpRise && hasSellConfirmation) ? "SELL" : "WAIT";

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

         // --- LIVE REPLICATION: Signal Validation (processSignal logic) ---
         if (signal.action !== "WAIT") {
            // 1. Filter Check
            if (!possibleActions.includes(signal.action)) {
                signal.action = "WAIT";
            } else {
                // 2. Hallucination Check & ATR Correction
                const atr = indicators.atr || 0;
                const { atrMultiplierSL, atrMultiplierTP } = config.strategy;
                const minDistance = Math.max(PIP_SIZE * config.minStopDistancePips, atr * config.atrMultiplierFloor);
                const idealSLDist = Math.max(minDistance, atr * atrMultiplierSL);
                const idealTPDist = Math.max(minDistance, atr * atrMultiplierTP);

                // Entry correction
                if (Math.abs(signal.entry - midOpen) / midOpen > (config.maxPriceDeviationPercent / 100)) {
                    signal.entry = midOpen;
                }

                // SL/TP logic/distance correction
                const slDist = Math.abs(signal.stopLoss - signal.entry);
                const tpDist = Math.abs(signal.takeProfit - signal.entry);
                const isIllogical = (signal.action === "BUY" && (signal.stopLoss >= signal.entry || signal.takeProfit <= signal.entry)) ||
                                    (signal.action === "SELL" && (signal.stopLoss <= signal.entry || signal.takeProfit >= signal.entry));
                
                if (!signal.stopLoss || !signal.takeProfit || isIllogical || slDist < minDistance || tpDist < minDistance) {
                    if (signal.action === "BUY") {
                        signal.stopLoss = signal.entry - idealSLDist;
                        signal.takeProfit = signal.entry + idealTPDist;
                    } else {
                        signal.stopLoss = signal.entry + idealSLDist;
                        signal.takeProfit = signal.entry - idealTPDist;
                    }
                }
            }
         }

         if (signal.action !== "WAIT" && signal.confidence >= config.minConfidenceToExecute) {
            // Sentiment Filter
            if (signal.sentimentScore !== undefined && signal.sentimentScore < config.strategy.minSentimentConfidence) {
                // Skip trade due to low sentiment
            } else {
                handleSignal(signal, currentAsk, currentBid, timestamp, indicators);
            }
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
          // If we are flipping SELL to BUY, we close SELL at ASK + Slippage
          // If we are flipping BUY to SELL, we close BUY at BID - Slippage
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

  /**
   * Replicates index.js manageActiveTrades for backtesting (trailing stop)
   */
  function manageActiveTrades(indicators, currentPrice) {
    if (activeTrades.length === 0 || !config.useBreakeven) return;

    for (const trade of activeTrades) {
      const profitPips = trade.direction === "BUY"
        ? (currentPrice - trade.entry) / PIP_SIZE
        : (trade.entry - currentPrice) / PIP_SIZE;
      
      const triggerPips = (indicators.atr * config.breakevenTriggerATR) / PIP_SIZE;

      if (profitPips >= triggerPips) {
        if (config.useTrailingStop) {
          // Trailing stop: trail at X * ATR behind the current price
          const trailDist = indicators.atr * (config.trailingStopATR || 1.5);
          let newSL = trade.direction === "BUY" ? currentPrice - trailDist : currentPrice + trailDist;

          // Ensure trailing SL is at least at entry + buffer (commission cover)
          const buffer = 1.0 * PIP_SIZE;
          const minSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
          if (trade.direction === "BUY" && newSL < minSL) newSL = minSL;
          if (trade.direction === "SELL" && newSL > minSL) newSL = minSL;

          // Only move SL forward, never backward
          const shouldUpdate = trade.direction === "BUY" ? newSL > trade.sl : newSL < trade.sl;
          if (shouldUpdate) {
            trade.sl = newSL;
            trade.isBreakeven = true;
          }
        } else {
          // Flat breakeven
          if (trade.isBreakeven) continue;
          const buffer = 1.0 * PIP_SIZE;
          const newSL = trade.direction === "BUY" ? trade.entry + buffer : trade.entry - buffer;
          trade.sl = newSL;
          trade.isBreakeven = true;
          console.log(`  🛡️  [${trade.time}] Trade ${trade.id} reached profit target. Moving SL to Entry + Buffer.`);
        }
      }
    }
  }

  function closeTrade(trade, exitPrice, reason, exitTime) {
    const rawPnL = trade.direction === "BUY" ? (exitPrice - trade.entry) * trade.units : (trade.entry - exitPrice) * trade.units;
    
    // cTrader Commission: $3.00 USD per 100,000 USD volume traded (per side)
    // For EUR_USD: Volume = Units * Price
    const entryVolumeUSD = PAIR.startsWith("USD") ? trade.units : (trade.units * trade.entry);
    const exitVolumeUSD = PAIR.startsWith("USD") ? trade.units : (trade.units * exitPrice);
    const commission = ((entryVolumeUSD / 100000) * COMMISSION_SIDE_USD) + ((exitVolumeUSD / 100000) * COMMISSION_SIDE_USD);
    
    const netProfit = rawPnL - commission;
    
    if (netProfit < 0 && reason === "SL") {
      lastLossTime = exitTime;
    }

    balance += netProfit;
    
    const result = { ...trade, exit: exitPrice, exitTime, reason, profit: netProfit, balance };
    tradeHistory.push(result);
    console.log(`  ✅ [${exitTime}] Closed ${trade.id} (${reason}) | Net PnL: $${netProfit.toFixed(2)} (Comm: $${commission.toFixed(2)}) | Balance: $${balance.toFixed(2)}`);
  }

  function calculateUnits(signal, indicators, currentBalance) {
    const riskAmount = currentBalance * (config.riskPercentPerTrade / 100);
    const slDistance = Math.abs(signal.entry - signal.stopLoss);
    if (slDistance === 0) return 0;

    const slPips = slDistance / PIP_SIZE;
    
    // Simplified pip value for backtest (assuming USD account)
    let pipValue = 10; // Default for XXX/USD
    if (PAIR.startsWith("USD/")) pipValue = (PIP_SIZE / signal.entry) * 100000;
    else if (!PAIR.endsWith("_USD") && !PAIR.endsWith("/USD")) pipValue = (PIP_SIZE / signal.entry) * 100000;

    const lots = riskAmount / (slPips * pipValue);
    let units = Math.floor(lots * 100000);

    if (units > config.maxPositionSizeUnits) units = config.maxPositionSizeUnits;
    
    // Use sensible defaults for step/min volume if symbol info not available
    const minVol = 100;
    const stepVol = 100;
    units = Math.floor(units / stepVol) * stepVol;
    return units < minVol ? 0 : units;
  }

  function getHTFIndicators(candles) {
    let htfIndicators = null;
    const htfFactor = config.granularity === "M5" ? 3 : (config.granularity === "M15" ? 4 : 1);
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

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊  FINAL RESULTS`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total Trades : ${tradeHistory.length}`);
  const wins = tradeHistory.filter(t => t.profit > 0).length;
  const totalComm = tradeHistory.reduce((s, t) => {
    const entryVol = PAIR.startsWith("USD") ? t.units : (t.units * t.entry);
    const exitVol = PAIR.startsWith("USD") ? t.units : (t.units * t.exit);
    return s + ((entryVol / 100000) * COMMISSION_SIDE_USD) + ((exitVol / 100000) * COMMISSION_SIDE_USD);
  }, 0);
  const netPnL = balance - INITIAL_BALANCE;
  const grossPnL = netPnL + totalComm;

  console.log(`  Win Rate     : ${((wins / Math.max(1, tradeHistory.length)) * 100).toFixed(1)}%`);
  console.log(`  Gross PnL    : $${grossPnL.toFixed(2)}`);
  console.log(`  Total Comm   : $${totalComm.toFixed(2)}`);
  console.log(`  Net Profit   : $${netPnL.toFixed(2)} (${((balance/INITIAL_BALANCE - 1)*100).toFixed(2)}%)`);
  console.log(`  Avg Net/Trade: $${(netPnL / Math.max(1, tradeHistory.length)).toFixed(2)}`);
  console.log(`${"═".repeat(60)}\n`);
}

main();
