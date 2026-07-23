/**
 * Backtest Runner — NY Asian Range Continuation Strategy (Multi-Pair)
 */

import fs from "fs";
import path from "path";
import zlib from "zlib";
import { TickDatabase } from "./tick-db.js";
import { detectHigherTimeframeTrend, generateLondonAsianFakeBreakReversalSignal, generateNYAsianContinuationSignal } from "./indicators.js";
import { config } from "./config.js";
import { calculatePipValueUSD, calculateRiskVolume } from "./position-sizing.js";
import { getPipSize, getInstrumentType, getLotSize } from "./instrument-utils.js";

const COMMISSION_SIDE_USD = 3.00;
const SPREAD_PIPS = config.backtest?.spreadPips ?? 0.5;
const SLIPPAGE_PIPS = config.backtest?.slippagePips ?? 0.2;
const USD_KES_RATE = config.risk.usdKesRate ?? 129.0;
const FIXED_BALANCE_USD = Number(config.backtest?.fixedBalanceUSD);
const USE_FIXED_BALANCE = Number.isFinite(FIXED_BALANCE_USD) && FIXED_BALANCE_USD > 0;
const INITIAL_BALANCE = USE_FIXED_BALANCE ? FIXED_BALANCE_USD : config.risk.accountCapitalKES / USD_KES_RATE;
const INTRABAR_MODE = String(config.backtest?.intrabarMode ?? "conservative").toLowerCase();
const TICK_CACHE_DIR = process.env.BACKTEST_TICK_CACHE_DIR || "data/ticks";
const TICK_MISSING_MODE = String(process.env.BACKTEST_TICK_MISSING || "fallback").toLowerCase();
const BACKTEST_TICK_SOURCE = process.env.BACKTEST_TICK_SOURCE || "sqlite"; // sqlite or files

let TICK_DB = null;
if (INTRABAR_MODE === "tick" && BACKTEST_TICK_SOURCE === "sqlite") {
  try {
    TICK_DB = new TickDatabase();
  } catch (err) {
    console.warn(`  ⚠️  Failed to initialize SQLite tick database: ${err.message}. Falling back to file cache.`);
  }
}

let balance = INITIAL_BALANCE;
const pairData = {};
const PAIRS = config.tradingPairs;
const htfConfig = config.strategy.higherTimeframeTrend ?? {};
const strategyMode = config.strategy.mode;

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  CUSTOM BACKTESTER (MULTI-PAIR)`);
  console.log(`  Pairs    : ${PAIRS.join(", ")}`);
  console.log(`  Strategy : ${strategyMode}`);
  if (USE_FIXED_BALANCE) {
    console.log(`  Sizing   : fixed balance $${FIXED_BALANCE_USD.toFixed(2)} (no compounding for position sizing)`);
  }
  console.log(`  Intrabar : ${INTRABAR_MODE}`);
  console.log(`${"═".repeat(60)}\n`);

  const allTimestamps = new Set();

  for (const pair of PAIRS) {
    const filename = `history_${pair.replace("/", "_")}.json`;
    if (!fs.existsSync(filename)) continue;
    let candles = JSON.parse(fs.readFileSync(filename, "utf8"));

    // Walk-forward date filtering
    const wfStart = process.env.BACKTEST_START_DATE ? new Date(process.env.BACKTEST_START_DATE) : null;
    const wfEnd = process.env.BACKTEST_END_DATE ? new Date(process.env.BACKTEST_END_DATE) : null;
    if (wfStart || wfEnd) {
      candles = candles.filter(c => {
        const t = new Date(c.time);
        return (!wfStart || t >= wfStart) && (!wfEnd || t < wfEnd);
      });
    }
    
    candles = candles.map(c => {
      if (!c.mid && c.bid && c.ask) {
        c.mid = {
          o: ((parseFloat(c.bid.o) + parseFloat(c.ask.o)) / 2).toFixed(5),
          h: ((parseFloat(c.bid.h) + parseFloat(c.ask.h)) / 2).toFixed(5),
          l: ((parseFloat(c.bid.l) + parseFloat(c.ask.l)) / 2).toFixed(5),
          c: ((parseFloat(c.bid.c) + parseFloat(c.ask.c)) / 2).toFixed(5),
        };
      }
      return c;
    });

    pairData[pair] = {
        candles,
        ticks: loadTickData(pair),
        higherTimeframeCandles: htfConfig.enabled ? buildHourlyCandles(candles) : [],
        liquidityContext: buildLiquidityContext(candles),
        higherTimeframeIndex: 0,
        pipSize: getPipSize(pair),
        activeTrades: [],
        pendingOrders: [],
        sessionTradeCounts: new Map(),
        tradeHistory: [],
        cooldownCandlesRemaining: 0,
        candleIndex: 0
    };
    candles.forEach(c => allTimestamps.add(c.time));
  }

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => new Date(a) - new Date(b));
  const windowM5 = 100;
  const dailyRisk = {
    currentDay: null,
    tradingEnabled: true,
    dailyRealizedProfitKES: 0,
    dailyRealizedLossKES: 0,
    blockedSignals: 0,
    blockedPendingTriggers: 0,
    blockedDays: new Map(),
  };
  const londonModuleRisk = {
    currentDay: null,
    dailyLosses: 0,
    dailyLossUSD: 0,
    blockedEvaluations: 0,
    blockedDays: new Map(),
  };

  for (const timestamp of sortedTimestamps) {
    for (const pair of PAIRS) {
      const p = pairData[pair];
      if (!p) continue;

      while (p.candleIndex < p.candles.length && p.candles[p.candleIndex].time < timestamp) p.candleIndex++;
      if (p.candleIndex >= p.candles.length || p.candles[p.candleIndex].time !== timestamp || p.candleIndex < windowM5) continue;

      const currentM5Candles = p.candles.slice(p.candleIndex - windowM5, p.candleIndex);
      const nextCandle = p.candles[p.candleIndex];
      const dateObj = new Date(timestamp);
      resetDailyRiskIfNeeded(dateObj);
      while (
        p.higherTimeframeIndex < p.higherTimeframeCandles.length &&
        new Date(p.higherTimeframeCandles[p.higherTimeframeIndex].endTime) <= new Date(timestamp)
      ) {
        p.higherTimeframeIndex++;
      }

      const higherTimeframe = htfConfig.enabled
        ? detectHigherTimeframeTrend(
            p.higherTimeframeCandles.slice(Math.max(0, p.higherTimeframeIndex - (htfConfig.lookbackCandles || 250)), p.higherTimeframeIndex),
            { emaPeriod: htfConfig.emaPeriod || 200, requireSlope: htfConfig.requireSlope ?? true },
          )
        : { trend: null };

      const midOpen = parseFloat(nextCandle.mid.o);
      const midHigh = parseFloat(nextCandle.mid.h);
      const midLow  = parseFloat(nextCandle.mid.l);
      const midClose = parseFloat(nextCandle.mid.c);

      const spread = SPREAD_PIPS * p.pipSize;
      const bidLow  = midLow - spread/2;
      const bidHigh = midHigh - spread/2;
      const askHigh = midHigh + spread/2;
      const askLow  = midLow + spread/2;
      const askClose = midClose + spread/2;
      const slippage = SLIPPAGE_PIPS * p.pipSize;

      const intervalEndMs = new Date(timestamp).getTime() + 5 * 60_000;
      const intrabarTicks = INTRABAR_MODE === "tick" ? getTicksForInterval(p, new Date(timestamp).getTime(), intervalEndMs) : [];

      // Manage trades
      if (intrabarTicks.length > 0) {
        replayTicks(pair, p, intrabarTicks, slippage);
      } else {
      p.activeTrades = p.activeTrades.filter(trade => {
        trade.ageBars = (trade.ageBars ?? 0) + 1;
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) { closeTrade(pair, trade, trade.sl - slippage, "SL", timestamp); return false; }
          const partialCfg = config.strategy.nyAsianContinuation;
          if (partialCfg.partialTpEnabled && !trade.partialTpDone && Number.isFinite(trade.riskPips)) {
            const partialPrice = trade.entry + trade.riskPips * p.pipSize;
            const hitPartial = bidHigh >= partialPrice;
            if (hitPartial) {
              const fraction = partialCfg.partialTpFraction;
              const closeUnits = Math.floor(trade.units * fraction);
              const remainUnits = trade.units - closeUnits;
              if (closeUnits > 0 && remainUnits > 0) {
                const partialExit = partialPrice - slippage;
                closeTrade(pair, { ...trade, units: closeUnits }, partialExit, "PARTIAL_TP", timestamp);
                trade.units = remainUnits;
                if (partialCfg.partialTpMoveSlToEntry) trade.sl = trade.entry;
                trade.partialTpDone = true;
              }
            }
          }
          if (Number.isFinite(trade.tp) && bidHigh >= trade.tp) { closeTrade(pair, trade, trade.tp - slippage, "TP", timestamp); return false; }
        } else {
          if (askHigh >= trade.sl) { closeTrade(pair, trade, trade.sl + slippage, "SL", timestamp); return false; }
          const partialCfg = config.strategy.nyAsianContinuation;
          if (partialCfg.partialTpEnabled && !trade.partialTpDone && Number.isFinite(trade.riskPips)) {
            const partialPrice = trade.entry - trade.riskPips * p.pipSize;
            const hitPartial = askLow <= partialPrice;
            if (hitPartial) {
              const fraction = partialCfg.partialTpFraction;
              const closeUnits = Math.floor(trade.units * fraction);
              const remainUnits = trade.units - closeUnits;
              if (closeUnits > 0 && remainUnits > 0) {
                const partialExit = partialPrice + slippage;
                closeTrade(pair, { ...trade, units: closeUnits }, partialExit, "PARTIAL_TP", timestamp);
                trade.units = remainUnits;
                if (partialCfg.partialTpMoveSlToEntry) trade.sl = trade.entry;
                trade.partialTpDone = true;
              }
            }
          }
          if (Number.isFinite(trade.tp) && askLow <= trade.tp) { closeTrade(pair, trade, trade.tp + slippage, "TP", timestamp); return false; }
        }
        if (trade.timeExitBars && trade.ageBars >= trade.timeExitBars) {
          const exitPrice = trade.direction === "SELL" ? askClose + slippage : midClose - spread/2 - slippage;
          closeTrade(pair, trade, exitPrice, "TIME", timestamp);
          return false;
        }
        if (Number.isFinite(trade.forceExitUTC)) {
          const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);
          if (h >= trade.forceExitUTC) {
            const exitPrice = trade.direction === "SELL" ? askClose + slippage : midClose - spread/2 - slippage;
            closeTrade(pair, trade, exitPrice, "FORCE_TIME", timestamp);
            return false;
          }
        }
        return true;
      });
      }

      // Session Hours (supports multi-window UTC, incl. half-hours)
      const activeWindow = getActiveSessionWindowUTC(dateObj);
      if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6 || !activeWindow) continue;

      if (p.cooldownCandlesRemaining > 0) {
        p.cooldownCandlesRemaining -= 1;
        continue;
      }

      if (intrabarTicks.length > 0) replayTicks(pair, p, intrabarTicks, slippage);
      else processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
      if (!canBacktestTrade(timestamp)) continue;
      if (!canLondonModuleTrade(timestamp)) continue;
      if (p.activeTrades.length >= config.maxTradesPerPair) continue;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) continue;

      const sessionKey = getSessionKey(dateObj, activeWindow);
      const strategyCfg = getActiveStrategyConfig(activeWindow);
      const allowedSessions = strategyCfg.allowedSessionNames;
      if (Array.isArray(allowedSessions) && allowedSessions.length > 0 && !allowedSessions.includes(activeWindow.name)) continue;

      const maxTradesPerSession = strategyCfg.maxTradesPerSession ?? 1;
      if ((p.sessionTradeCounts.get(sessionKey) ?? 0) >= maxTradesPerSession) continue;

      const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);
      if (h < strategyCfg.tradeStartUTC || h >= strategyCfg.tradeEndUTC) continue;

      if (strategyMode === "london_asian_fake_break_reversal" || (strategyMode === "combined_ny_london" && activeWindow?.name === "london_open")) {
        const allowedPairs = strategyCfg.allowedPairs;
        if (Array.isArray(allowedPairs) && allowedPairs.length > 0 && !allowedPairs.includes(pair)) continue;
        const excludedDay = strategyCfg.excludedPairWeekdays?.[pair];
        if (excludedDay && excludedDay === weekdayUTC(dateObj)) continue;
      }

      // Signal Generation
      const asianRange = getAsianRangeForSession(p, dateObj);
      const signal = generateStrategySignal(currentM5Candles, higherTimeframe, p, asianRange, pair);

      if (signal.signal === 'none' || p.activeTrades.length >= config.maxTradesPerPair || p.pendingOrders.length > 0) continue;

      const added = handleSignal(pair, signal, midOpen, timestamp, p.candleIndex, sessionKey);
      if (added) {
        if (intrabarTicks.length > 0) replayTicks(pair, p, intrabarTicks, slippage);
        else processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
      }
    }
  }

  function generateStrategySignal(currentM5Candles, higherTimeframe, p, asianRange = null, instrument = null) {
    const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;

    if (strategyMode === "ny_asian_continuation") {
      const nyCfg = { ...config.strategy.nyAsianContinuation, ...(config.strategy.nyAsianContinuation.pairOverrides?.[instrument] ?? {}) };
      return generateNYAsianContinuationSignal(currentM5Candles, {
        ...nyCfg,
        asianRange,
        higherTimeframeTrend: htfTrend,
        pair: instrument,
      });
    }

    if (strategyMode === "london_asian_fake_break_reversal") {
      return generateLondonAsianFakeBreakReversalSignal(currentM5Candles, {
        ...config.strategy.londonAsianFakeBreakReversal,
        asianRange,
        higherTimeframeTrend: htfTrend,
        pair: instrument,
      });
    }

    if (strategyMode === "combined_ny_london") {
      const nyCfg = { ...config.strategy.nyAsianContinuation, ...(config.strategy.nyAsianContinuation.pairOverrides?.[instrument] ?? {}) };
      const nySignal = generateNYAsianContinuationSignal(currentM5Candles, {
        ...nyCfg,
        asianRange,
        higherTimeframeTrend: htfTrend,
        pair: instrument,
      });
      if (nySignal.signal !== "none") return nySignal;

      const londonSignal = generateLondonAsianFakeBreakReversalSignal(currentM5Candles, {
        ...config.strategy.londonAsianFakeBreakReversal,
        asianRange,
        higherTimeframeTrend: htfTrend,
        pair: instrument,
      });
      if (londonSignal.signal !== "none") return londonSignal;

      return { signal: "none", reason: `Combined: NY=${nySignal.reason || "none"} | London=${londonSignal.reason || "none"}` };
    }

    return { signal: "none", reason: `Unsupported backtest strategy mode ${strategyMode}` };
  }

  function handleSignal(pair, signal, price, time, setupIndex, sessionKey = null) {
    if (!canBacktestTrade(time)) {
      dailyRisk.blockedSignals += 1;
      return false;
    }

    const p = pairData[pair];
    const action = signal.signal.toUpperCase();
    const units = calculateBacktestUnits(pair, signal);
    if (units <= 0) return false;

    if (signal.signal === "sell_stop") {
      p.pendingOrders.push({
        direction: "SELL",
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        units,
        setupTime: signal.setupTime,
        setupIndex,
        expiresAfterBars: signal.pendingExpiryBars ?? 3,
        timeExitBars: signal.timeExitBars,
        forceExitUTC: signal.forceExitUTC,
        sessionKey,
        strategy: signal.strategy,
        levelName: signal.levelName,
        levelPrice: signal.levelPrice,
        pair,
        reason: signal.reason,
        riskPips: signal.riskPips,
        rewardPips: signal.rewardPips,
        convictionMultiplier: signal.convictionMultiplier ?? 1.0,
      });
      return true;
    }

    if (signal.signal === "buy_stop") {
      p.pendingOrders.push({
        direction: "BUY",
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        units,
        setupTime: signal.setupTime,
        setupIndex,
        expiresAfterBars: signal.pendingExpiryBars ?? 3,
        timeExitBars: signal.timeExitBars,
        forceExitUTC: signal.forceExitUTC,
        sessionKey,
        strategy: signal.strategy,
        levelName: signal.levelName,
        levelPrice: signal.levelPrice,
        pair,
        reason: signal.reason,
        riskPips: signal.riskPips,
        rewardPips: signal.rewardPips,
        convictionMultiplier: signal.convictionMultiplier ?? 1.0,
      });
      return true;
    }

    p.activeTrades.push({
      direction: action,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      units,
      time,
      pair,
      reason: signal.reason,
      strategy: signal.strategy,
      sessionKey,
      levelName: signal.levelName,
      levelPrice: signal.levelPrice,
      riskPips: signal.riskPips,
      rewardPips: signal.rewardPips,
      ageBars: 0,
      timeExitBars: signal.timeExitBars,
      forceExitUTC: signal.forceExitUTC,
      convictionMultiplier: signal.convictionMultiplier ?? 1.0,
    });
    if (sessionKey) {
      p.sessionTradeCounts.set(sessionKey, (p.sessionTradeCounts.get(sessionKey) ?? 0) + 1);
    }
    return true;
  }

  function replayTicks(pair, p, ticks, slippage) {
    for (const tick of ticks) {
      processPendingOrdersAtTick(pair, p, tick, slippage);
      p.activeTrades = p.activeTrades.filter(trade => {
        const exit = getTickExit(trade, tick, slippage);
        if (!exit) return true;
        closeTrade(pair, trade, exit.price, exit.reason, tick.time);
        return false;
      });
    }
  }

  function processPendingOrdersAtTick(pair, p, tick, slippage) {
    p.pendingOrders = p.pendingOrders.filter(order => {
      const ageBars = p.candleIndex - order.setupIndex;
      if (ageBars > order.expiresAfterBars) return false;
      if (p.activeTrades.length >= config.maxTradesPerPair) return true;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) return true;

      const triggered = order.direction === "SELL"
        ? tick.bid <= order.entry
        : tick.ask >= order.entry;
      if (!triggered) return true;
      if (!canBacktestTrade(tick.time)) {
        dailyRisk.blockedPendingTriggers += 1;
        return false;
      }

      if (order.sessionKey) {
        p.sessionTradeCounts.set(order.sessionKey, (p.sessionTradeCounts.get(order.sessionKey) ?? 0) + 1);
      }

      p.activeTrades.push({
        direction: order.direction,
        entry: order.direction === "SELL" ? order.entry - slippage : order.entry + slippage,
        sl: order.sl,
        tp: order.tp,
        units: order.units,
        time: tick.time,
        setupTime: order.setupTime,
        pair,
        reason: order.reason,
        strategy: order.strategy,
        sessionKey: order.sessionKey,
        levelName: order.levelName,
        levelPrice: order.levelPrice,
        ageBars: 0,
        timeExitBars: order.timeExitBars,
        forceExitUTC: order.forceExitUTC,
        riskPips: order.riskPips,
        rewardPips: order.rewardPips,
        convictionMultiplier: order.convictionMultiplier ?? 1.0,
      });
      return false;
    });
  }

  function getTickExit(trade, tick, slippage) {
    if (trade.direction === "BUY") {
      if (tick.bid <= trade.sl) return { reason: "SL", price: trade.sl - slippage };
      if (Number.isFinite(trade.tp) && tick.bid >= trade.tp) return { reason: "TP", price: trade.tp - slippage };
      return null;
    }
    if (tick.ask >= trade.sl) return { reason: "SL", price: trade.sl + slippage };
    if (Number.isFinite(trade.tp) && tick.ask <= trade.tp) return { reason: "TP", price: trade.tp + slippage };
    return null;
  }

  function resetLondonModuleRiskIfNeeded(dateLike) {
    const day = dayKeyUTC(new Date(dateLike));
    if (londonModuleRisk.currentDay === day) return;
    londonModuleRisk.currentDay = day;
    londonModuleRisk.dailyLosses = 0;
    londonModuleRisk.dailyLossUSD = 0;
  }

  function canLondonModuleTrade(dateLike) {
    if (strategyMode === "ny_asian_continuation") return true;
    if (strategyMode === "combined_ny_london") {
      const activeWindow = getActiveSessionWindowUTC(new Date(dateLike));
      if (activeWindow?.name !== "london_open") return true;
    }
    resetLondonModuleRiskIfNeeded(dateLike);
    const cfg = config.strategy.londonAsianFakeBreakReversal ?? {};
    const maxLosses = Number(cfg.maxLossesPerDay ?? 0);
    const maxDailyLoss = Number(cfg.maxDailyLossUSD ?? 0);
    const lossCountBlocked = Number.isFinite(maxLosses) && maxLosses > 0 && londonModuleRisk.dailyLosses >= maxLosses;
    const dailyLossBlocked = Number.isFinite(maxDailyLoss) && maxDailyLoss > 0 && londonModuleRisk.dailyLossUSD >= maxDailyLoss;
    if (!lossCountBlocked && !dailyLossBlocked) return true;

    londonModuleRisk.blockedEvaluations += 1;
    if (!londonModuleRisk.blockedDays.has(londonModuleRisk.currentDay)) {
      londonModuleRisk.blockedDays.set(londonModuleRisk.currentDay, {
        day: londonModuleRisk.currentDay,
        reason: lossCountBlocked ? "london_max_losses_per_day" : "london_max_daily_loss_usd",
        dailyLosses: londonModuleRisk.dailyLosses,
        dailyLossUSD: +londonModuleRisk.dailyLossUSD.toFixed(2),
      });
    }
    return false;
  }

  function updateLondonModuleRisk(exitTime, profitUSD) {
    if (strategyMode === "ny_asian_continuation") return;
    if (strategyMode === "combined_ny_london") {
      const h = new Date(exitTime).getUTCHours() + new Date(exitTime).getUTCMinutes() / 60;
      const londonCfg = config.strategy.londonAsianFakeBreakReversal ?? {};
      const lStart = londonCfg.tradeStartUTC ?? 7;
      const lEnd = londonCfg.tradeEndUTC ?? 10;
      if (h < lStart || h >= lEnd) return;
    }
    resetLondonModuleRiskIfNeeded(exitTime);
    if (profitUSD <= 0) {
      londonModuleRisk.dailyLosses += 1;
      londonModuleRisk.dailyLossUSD += Math.abs(profitUSD);
    }
  }

  function processPendingOrders(pair, p, market) {
    p.pendingOrders = p.pendingOrders.filter(order => {
      const ageBars = p.candleIndex - order.setupIndex;
      if (ageBars > order.expiresAfterBars) return false;
      if (p.activeTrades.length >= config.maxTradesPerPair) return true;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) return true;

      if (order.direction === "SELL" && market.bidLow <= order.entry) {
        if (!canBacktestTrade(market.timestamp)) {
          dailyRisk.blockedPendingTriggers += 1;
          return false;
        }
        if (order.sessionKey) {
          p.sessionTradeCounts.set(order.sessionKey, (p.sessionTradeCounts.get(order.sessionKey) ?? 0) + 1);
        }
        p.activeTrades.push({
          direction: "SELL",
          entry: order.entry - market.slippage,
          sl: order.sl,
          tp: order.tp,
          units: order.units,
          time: market.timestamp,
          setupTime: order.setupTime,
          pair,
          reason: order.reason,
          strategy: order.strategy,
          sessionKey: order.sessionKey,
          levelName: order.levelName,
          levelPrice: order.levelPrice,
          ageBars: 0,
          timeExitBars: order.timeExitBars,
          forceExitUTC: order.forceExitUTC,
          riskPips: order.riskPips,
          rewardPips: order.rewardPips,
          convictionMultiplier: order.convictionMultiplier ?? 1.0,
        });
        return false;
      }

      if (order.direction === "BUY" && market.askHigh >= order.entry) {
        if (!canBacktestTrade(market.timestamp)) {
          dailyRisk.blockedPendingTriggers += 1;
          return false;
        }
        if (order.sessionKey) {
          p.sessionTradeCounts.set(order.sessionKey, (p.sessionTradeCounts.get(order.sessionKey) ?? 0) + 1);
        }
        p.activeTrades.push({
          direction: "BUY",
          entry: order.entry + market.slippage,
          sl: order.sl,
          tp: order.tp,
          units: order.units,
          time: market.timestamp,
          setupTime: order.setupTime,
          pair,
          reason: order.reason,
          strategy: order.strategy,
          sessionKey: order.sessionKey,
          levelName: order.levelName,
          levelPrice: order.levelPrice,
          ageBars: 0,
          timeExitBars: order.timeExitBars,
          forceExitUTC: order.forceExitUTC,
          riskPips: order.riskPips,
          rewardPips: order.rewardPips,
          convictionMultiplier: order.convictionMultiplier ?? 1.0,
        });
        return false;
      }

      return true;
    });
  }

  function getTotalActiveTrades() {
    return Object.values(pairData).reduce((sum, p) => sum + p.activeTrades.length, 0);
  }

  function calculateBacktestUnits(pair, signal) {
    const sizingBalance = USE_FIXED_BALANCE ? FIXED_BALANCE_USD : balance;
    const capital = sizingBalance * USD_KES_RATE;
    const base = calculateRiskVolume({
      pair,
      slPips: signal.riskPips,
      currentRate: signal.entry,
      accountCapitalKES: capital,
      riskPerTradePercent: config.risk.riskPerTradePercent,
      usdKesRate: USD_KES_RATE,
      maxLeverage: config.risk.maxLeverage,
      maxPositionSizeUnits: config.maxPositionSizeUnits,
    });
    const mult = signal.convictionMultiplier ?? 1.0;
    return Math.floor(base * mult);
  }

  function resetDailyRiskIfNeeded(dateLike) {
    const day = dayKeyUTC(new Date(dateLike));
    if (dailyRisk.currentDay === day) return;

    dailyRisk.currentDay = day;
    dailyRisk.tradingEnabled = true;
    dailyRisk.dailyRealizedProfitKES = 0;
    dailyRisk.dailyRealizedLossKES = 0;
  }

  function canBacktestTrade(dateLike) {
    resetDailyRiskIfNeeded(dateLike);
    if (!dailyRisk.tradingEnabled) return false;

    if (config.risk.enforceDailyStopLoss && dailyRisk.dailyRealizedLossKES >= config.risk.dailyStopLossKES) {
      disableDailyBacktestTrading('daily_stop_loss');
      return false;
    }

    if (dailyRisk.dailyRealizedProfitKES >= config.risk.dailyProfitTargetKES) {
      disableDailyBacktestTrading('daily_profit_target');
      return false;
    }

    return true;
  }

  function updateDailyRisk(exitTime, profitUSD) {
    resetDailyRiskIfNeeded(exitTime);
    const pnlKES = profitUSD * USD_KES_RATE;
    if (pnlKES >= 0) dailyRisk.dailyRealizedProfitKES += pnlKES;
    else dailyRisk.dailyRealizedLossKES += Math.abs(pnlKES);

    if (config.risk.enforceDailyStopLoss && dailyRisk.dailyRealizedLossKES >= config.risk.dailyStopLossKES) {
      disableDailyBacktestTrading('daily_stop_loss');
    }
    if (dailyRisk.dailyRealizedProfitKES >= config.risk.dailyProfitTargetKES) {
      disableDailyBacktestTrading('daily_profit_target');
    }

    return {
      day: dailyRisk.currentDay,
      pnlKES: +pnlKES.toFixed(2),
      dailyRealizedProfitKES: +dailyRisk.dailyRealizedProfitKES.toFixed(2),
      dailyRealizedLossKES: +dailyRisk.dailyRealizedLossKES.toFixed(2),
      tradingEnabled: dailyRisk.tradingEnabled,
    };
  }

  function disableDailyBacktestTrading(reason) {
    dailyRisk.tradingEnabled = false;
    if (!dailyRisk.blockedDays.has(dailyRisk.currentDay)) {
      dailyRisk.blockedDays.set(dailyRisk.currentDay, {
        day: dailyRisk.currentDay,
        reason,
        dailyRealizedProfitKES: +dailyRisk.dailyRealizedProfitKES.toFixed(2),
        dailyRealizedLossKES: +dailyRisk.dailyRealizedLossKES.toFixed(2),
      });
    }
  }

  function closeTrade(pair, trade, exitPrice, reason, exitTime) {
    const p = pairData[pair];
    const diff = trade.direction === "BUY" ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
    const pips = diff / p.pipSize;
    const pipValueUSDPerLot = calculatePipValueUSD(pair, exitPrice);
    const lotSize = getLotSize(pair);
    const pipValueUSDPerUnit = pipValueUSDPerLot / lotSize;
    const grossProfit = pips * pipValueUSDPerUnit * trade.units;
    const normalizedPair = pair.toUpperCase().replace("/", "_");
    const base = normalizedPair.split("_")[0];
    const notionalUSD = base === "USD" ? trade.units : trade.units * exitPrice;
    const commission = (COMMISSION_SIDE_USD / 100_000) * 2 * notionalUSD;
    const profit = grossProfit - commission;
    balance += profit;
    if (reason === "SL" && config.strategy.cooldownCandlesAfterLoss > 0) {
      p.cooldownCandlesRemaining = Math.max(p.cooldownCandlesRemaining, config.strategy.cooldownCandlesAfterLoss);
    }
    const dailyRiskSnapshot = updateDailyRisk(exitTime, profit);
    updateLondonModuleRisk(exitTime, profit);
    p.tradeHistory.push({
      ...trade,
      convictionMultiplier: trade.convictionMultiplier ?? 1.0,
      exit: exitPrice,
      exitTime,
      reason,
      grossProfit,
      commission,
      profit,
      balance,
      pipValueUSDPerLot,
      pipValueUSDPerUnit,
      dailyRisk: dailyRiskSnapshot,
    });
    console.log(`  ✅ [${exitTime}] ${pair} ${reason} | Net: $${profit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  const allHistory = Object.values(pairData).flatMap(p => p.tradeHistory);
  const wins = allHistory.filter(t => t.profit > 0);
  const byPair = Object.fromEntries(Object.keys(pairData).map(pair => [pair, summarizeTrades(pairData[pair].tradeHistory)]));
  const blockedDays = Array.from(dailyRisk.blockedDays.values()).sort((a, b) => a.day.localeCompare(b.day));

  const finalStats = {
    type: "backtest",
    generatedAtUTC: new Date().toISOString(),
    pairs: PAIRS,
    profile: {
      strategyMode,
      sessionWindowMode: config.sessionWindowMode,
      sessionWindowsUTC: config.sessionWindowsUTC,
      spreadPips: SPREAD_PIPS,
      slippagePips: SLIPPAGE_PIPS,
      commissionSideUSD: COMMISSION_SIDE_USD,
      usdKesRate: USD_KES_RATE,
      positionSizing: {
        model: "shared_kes_risk_volume",
        accountCapitalKES: config.risk.accountCapitalKES,
        riskPerTradePercent: config.risk.riskPerTradePercent,
        maxLeverage: config.risk.maxLeverage,
        maxPositionSizeUnits: config.maxPositionSizeUnits,
      },
      dailyRiskSimulation: {
        enabled: true,
        enforceDailyStopLoss: config.risk.enforceDailyStopLoss,
        dailyStopLossKES: config.risk.dailyStopLossKES,
        dailyProfitTargetKES: config.risk.dailyProfitTargetKES,
      },
      cooldownCandlesAfterLoss: config.strategy.cooldownCandlesAfterLoss,
      riskPerTradePercent: config.risk.riskPerTradePercent,
      higherTimeframeTrend: htfConfig.enabled ? {
        granularity: htfConfig.granularity || config.higherTimeframe,
        emaPeriod: htfConfig.emaPeriod,
        requireSlope: htfConfig.requireSlope,
      } : null,
      nyAsianContinuation: config.strategy.nyAsianContinuation,
      londonAsianFakeBreakReversal: config.strategy.londonAsianFakeBreakReversal,
    },
    trades: allHistory,
    byPair,
    summary: {
      total: allHistory.length,
      wins: wins.length,
      losses: allHistory.length - wins.length,
      winRate: allHistory.length > 0 ? ((wins.length / allHistory.length) * 100).toFixed(1) : 0,
      netProfit: balance - INITIAL_BALANCE,
      finalBalance: balance,
      dailyRiskSimulation: {
        blockedDays: blockedDays.length,
        blockedSignals: dailyRisk.blockedSignals,
        blockedPendingTriggers: dailyRisk.blockedPendingTriggers,
      },
      sizing: {
        mode: USE_FIXED_BALANCE ? "fixed_balance" : "compounding",
        fixedBalanceUSD: USE_FIXED_BALANCE ? FIXED_BALANCE_USD : null,
      },
    },
    dailyRiskSimulation: {
      blockedDays,
    },
    londonModuleRiskSimulation: (strategyMode === "london_asian_fake_break_reversal" || strategyMode === "combined_ny_london") ? {
      maxLossesPerDay: config.strategy.londonAsianFakeBreakReversal?.maxLossesPerDay ?? 0,
      maxDailyLossUSD: config.strategy.londonAsianFakeBreakReversal?.maxDailyLossUSD ?? 0,
      blockedEvaluations: londonModuleRisk.blockedEvaluations,
      blockedDays: Array.from(londonModuleRisk.blockedDays.values()).sort((a, b) => a.day.localeCompare(b.day)),
    } : null,
  };

  const sortedHistory = [...allHistory].sort((a, b) => new Date(a.exitTime || a.time) - new Date(b.exitTime || b.time));
  const equityCurve = sortedHistory.map(t => Number(t.balance));
  const peak = [];
  let currentPeak = INITIAL_BALANCE;
  for (const eq of equityCurve) {
    if (eq > currentPeak) currentPeak = eq;
    peak.push(currentPeak);
  }
  const drawdowns = equityCurve.map((eq, i) => eq < peak[i] ? +((peak[i] - eq) / peak[i] * 100).toFixed(2) : 0);
  const maxDD = Math.max(...drawdowns, 0);
  const maxDDEnd = drawdowns.indexOf(maxDD);

  let currentDDStart = -1;
  let maxDDLength = 0;
  let currentDDLength = 0;
  for (let i = 0; i < drawdowns.length; i++) {
    if (drawdowns[i] > 0) {
      if (currentDDStart === -1) currentDDStart = i;
      currentDDLength++;
    } else {
      if (currentDDLength > maxDDLength) maxDDLength = currentDDLength;
      currentDDStart = -1;
      currentDDLength = 0;
    }
  }
  if (currentDDLength > maxDDLength) maxDDLength = currentDDLength;

  let longestWinStreak = 0, longestLossStreak = 0;
  let currentWin = 0, currentLoss = 0;
  for (const t of sortedHistory) {
    if (Number(t.profit) > 0) {
      currentWin++;
      currentLoss = 0;
      if (currentWin > longestWinStreak) longestWinStreak = currentWin;
    } else {
      currentLoss++;
      currentWin = 0;
      if (currentLoss > longestLossStreak) longestLossStreak = currentLoss;
    }
  }

  fs.writeFileSync("trades_backtest.json", JSON.stringify(finalStats, null, 2));

  const ddRecoverIdx = drawdowns.findIndex((d, i) => i > maxDDEnd && d === 0);
  const ddPeakDate = ddRecoverIdx >= 0 ? new Date(sortedHistory[ddRecoverIdx].exitTime || sortedHistory[ddRecoverIdx].time).toISOString().slice(0, 10) : "never";
  const ddTroughTrade = sortedHistory[maxDDEnd];
  const ddTroughDate = ddTroughTrade ? new Date(ddTroughTrade.exitTime || ddTroughTrade.time).toISOString().slice(0, 10) : "n/a";

  console.log(`\n  📊 FINAL: $${balance.toFixed(2)} | Trades: ${allHistory.length} | Win Rate: ${finalStats.summary.winRate}%`);
  console.log(`  📉 Max DD: ${maxDD}% (peak → ${ddTroughDate}, recovered by ${ddPeakDate}, ${maxDDLength} trades) | Consecutive loss: ${longestLossStreak} | Consecutive win: ${longestWinStreak}`);
  console.log(`  📈 Per-pair summary:`);
  for (const [pair, stats] of Object.entries(byPair)) {
    console.log(`     ${pair.padEnd(8)} Trades: ${String(stats.total).padStart(3)} | Win: ${stats.winRate}% | PF: ${stats.profitFactor} | Net: $${stats.netProfit}`);
  }
  console.log(`  🛡️  Daily risk simulation: blocked days ${blockedDays.length} | blocked signals ${dailyRisk.blockedSignals} | blocked pending triggers ${dailyRisk.blockedPendingTriggers}`);
  console.log(`  💾 Data saved to trades_backtest.json\n`);
}

function summarizeTrades(trades) {
  const profits = trades.map(t => Number(t.profit) || 0);
  const wins = profits.filter(p => p > 0);
  const losses = profits.filter(p => p <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const netProfit = profits.reduce((a, b) => a + b, 0);

  return {
    total: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0",
    grossProfit: +grossProfit.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    netProfit: +netProfit.toFixed(2),
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(3) : (grossProfit > 0 ? "∞" : "0.000"),
    expectancy: trades.length ? +(netProfit / trades.length).toFixed(3) : 0,
    avgWin: wins.length ? +(grossProfit / wins.length).toFixed(2) : 0,
    avgLoss: losses.length ? +(-grossLoss / losses.length).toFixed(2) : 0,
  };
}

function loadTickData(pair) {
  if (INTRABAR_MODE !== "tick") return { mode: "disabled" };
  const state = {
    mode: "cache",
    pair,
    pairKey: pair.replace("/", "_"),
    cacheDir: TICK_CACHE_DIR,
    dailyCache: new Map(),
    warnedDays: new Set(),
    legacyTicks: [],
  };

  const file = `ticks_${pair.replace("/", "_")}.json`;
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ticks = Array.isArray(data) ? data : data.ticks;
    if (Array.isArray(ticks)) {
      state.legacyTicks = normalizeTicks(ticks);
    } else {
      console.warn(`  ⚠️  ${file} has no ticks array; ignoring legacy tick file for ${pair}.`);
    }
  }

  const pairDir = path.join(TICK_CACHE_DIR, state.pairKey);
  if (!fs.existsSync(pairDir) && state.legacyTicks.length === 0) {
    console.warn(`  ⚠️  BACKTEST_INTRABAR_MODE=tick but no tick cache found for ${pair} (${pairDir}); falling back to M5 candle sequencing.`);
  }

  return state;
}

function normalizeTicks(ticks) {
  return ticks
    .map(t => ({
      time: t.time,
      timestamp: Number(t.timestamp ?? new Date(t.time).getTime()),
      bid: Number(t.bid),
      ask: Number(t.ask),
    }))
    .filter(t => Number.isFinite(t.timestamp) && Number.isFinite(t.bid) && Number.isFinite(t.ask) && t.bid > 0 && t.ask > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function getTicksForInterval(pairState, startMs, endMs) {
  if (pairState.ticks?.mode !== "cache") return [];

  if (TICK_DB) {
    const dbTicks = TICK_DB.getTicks(pairState.pair, startMs, endMs);
    if (dbTicks.length > 0) return dbTicks;
  }

  const day = new Date(startMs).toISOString().slice(0, 10);
  const daily = loadDailyTicks(pairState.ticks, day);
  if (daily.ticks.length > 0 && isCovered(daily.coverage, startMs, endMs)) {
    return daily.ticks.filter(t => t.timestamp >= startMs && t.timestamp < endMs);
  }

  if (pairState.ticks.legacyTicks.length > 0) {
    const legacyTicks = pairState.ticks.legacyTicks.filter(t => t.timestamp >= startMs && t.timestamp < endMs);
    if (legacyTicks.length > 0) return legacyTicks;
  }

  handleMissingTicks(pairState.ticks, day, startMs, endMs);
  return [];
}

function loadDailyTicks(tickState, day) {
  if (tickState.dailyCache.has(day)) return tickState.dailyCache.get(day);

  const file = path.join(tickState.cacheDir, tickState.pairKey, `${day}.json.gz`);
  if (!fs.existsSync(file)) {
    const empty = { ticks: [], coverage: [] };
    tickState.dailyCache.set(day, empty);
    return empty;
  }

  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  const daily = {
    ticks: normalizeTicks(data.ticks ?? []),
    coverage: Array.isArray(data.coverage) ? data.coverage : [],
  };
  tickState.dailyCache.set(day, daily);
  return daily;
}

function isCovered(coverage, startMs, endMs) {
  return coverage.some(range => Number(range.from) <= startMs && Number(range.to) >= endMs);
}

function handleMissingTicks(tickState, day, startMs, endMs) {
  const message = `BACKTEST_INTRABAR_MODE=tick missing ticks for ${tickState.pair} ${new Date(startMs).toISOString()} -> ${new Date(endMs).toISOString()}`;
  if (TICK_MISSING_MODE === "strict") {
    throw new Error(`${message}. Download ticks first or use BACKTEST_TICK_MISSING=fallback.`);
  }
  if (!tickState.warnedDays.has(day)) {
    tickState.warnedDays.add(day);
    console.warn(`  ⚠️  ${message}; falling back to M5 candle sequencing for missing intervals.`);
  }
}

function getActiveSessionWindowUTC(dateObj) {
  const windows = config.sessionWindowsUTC;
  const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);

  if (Array.isArray(windows) && windows.length > 0) {
    return windows.find(w => h >= w.start && h < w.end) || null;
  }

  return h >= config.sessionStartUTC && h < config.sessionEndUTC ? { name: "legacy", start: config.sessionStartUTC, end: config.sessionEndUTC } : null;
}

function getSessionKey(dateObj, activeWindow) {
  return `${dayKeyUTC(dateObj)}:${activeWindow?.name ?? "unknown"}`;
}

function buildHourlyCandles(candles) {
  const groups = new Map();

  for (const candle of candles) {
    const date = new Date(candle.time);
    date.setUTCMinutes(0, 0, 0);
    const key = date.toISOString();
    const mid = candle.mid;
    if (!mid) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        time: key,
        endTime: new Date(date.getTime() + 60 * 60 * 1000).toISOString(),
        volume: candle.volume ?? 0,
        mid: { o: mid.o, h: mid.h, l: mid.l, c: mid.c },
      });
      continue;
    }

    const group = groups.get(key);
    group.mid.h = Math.max(parseFloat(group.mid.h), parseFloat(mid.h)).toFixed(5);
    group.mid.l = Math.min(parseFloat(group.mid.l), parseFloat(mid.l)).toFixed(5);
    group.mid.c = mid.c;
    group.volume += candle.volume ?? 0;
  }

  return Array.from(groups.values()).sort((a, b) => new Date(a.time) - new Date(b.time));
}

function buildLiquidityContext(candles) {
  const asianRanges = new Map();
  const asianCfg = getActiveStrategyConfig() ?? {};
  const asianStart = asianCfg.asianStartUTC ?? 0;
  const asianEnd = asianCfg.asianEndUTC ?? 7;

  for (const candle of candles) {
    const mid = candle.mid;
    if (!mid) continue;

    const date = new Date(candle.time);
    const key = dayKeyUTC(date);
    const high = parseFloat(mid.h);
    const low = parseFloat(mid.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const h = date.getUTCHours() + (date.getUTCMinutes() / 60);
    if (h >= asianStart && h < asianEnd) updateRange(asianRanges, key, high, low);
  }

  return { asianRanges };
}

function updateRange(map, key, high, low) {
  if (!map.has(key)) {
    map.set(key, { high, low });
    return;
  }
  const range = map.get(key);
  range.high = Math.max(range.high, high);
  range.low = Math.min(range.low, low);
}


function getAsianRangeForSession(pairState, dateObj) {
  const key = dayKeyUTC(dateObj);
  const range = pairState.liquidityContext.asianRanges.get(key);
  if (!range) return null;

  const cfg = getActiveStrategyConfig() ?? {};
  return {
    name: "asian_range",
    high: range.high,
    low: range.low,
    start: cfg.asianStartUTC ?? 0,
    end: cfg.asianEndUTC ?? 7,
  };
}

function getActiveStrategyConfig(activeWindow = null) {
  if (strategyMode === "london_asian_fake_break_reversal") return config.strategy.londonAsianFakeBreakReversal;
  if (strategyMode === "combined_ny_london") {
    if (activeWindow?.name === "london_open") return config.strategy.londonAsianFakeBreakReversal;
    return config.strategy.nyAsianContinuation;
  }
  return config.strategy.nyAsianContinuation;
}

function dayKeyUTC(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function weekdayUTC(dateObj) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dateObj.getUTCDay()];
}

main().catch(console.error);
