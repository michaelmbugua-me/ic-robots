/**
 * Backtest Runner — 5-10-20 EMA Scalping Strategy (Multi-Pair)
 */

import fs from "fs";
import { detectHigherTimeframeTrend, generateNYAsianContinuationSignal, generateNYOpeningRangeBreakoutSignal, generateSignal, generateSessionSweepSignal, generateSmashBuySignal, generateSmashSellSignal } from "./indicators.js";
import { config } from "./config.js";

const INITIAL_BALANCE = 385; 
const COMMISSION_SIDE_USD = 3.00;
const SPREAD_PIPS = 0.5; 
const SLIPPAGE_PIPS = 0.2;

let balance = INITIAL_BALANCE;
const pairData = {};
const PAIRS = config.tradingPairs;
const htfConfig = config.strategy.higherTimeframeTrend ?? {};
const strategyMode = config.strategy.mode || "ema_pullback";

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  5-10-20 EMA SCALPING BACKTESTER (MULTI-PAIR)`);
  console.log(`  Pairs    : ${PAIRS.join(", ")}`);
  console.log(`  Strategy : ${strategyMode}`);
  console.log(`${"═".repeat(60)}\n`);

  const allTimestamps = new Set();

  for (const pair of PAIRS) {
    const filename = `history_${pair.replace("/", "_")}.json`;
    if (!fs.existsSync(filename)) continue;
    let candles = JSON.parse(fs.readFileSync(filename, "utf8"));
    
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
        higherTimeframeCandles: htfConfig.enabled ? buildHourlyCandles(candles) : [],
        liquidityContext: buildLiquidityContext(candles),
        openingRangeContext: buildOpeningRangeContext(candles),
        higherTimeframeIndex: 0,
        isJPY: pair.includes("JPY"),
        pipSize: pair.includes("JPY") ? 0.01 : 0.0001,
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

  for (const timestamp of sortedTimestamps) {
    for (const pair of PAIRS) {
      const p = pairData[pair];
      if (!p) continue;

      while (p.candleIndex < p.candles.length && p.candles[p.candleIndex].time < timestamp) p.candleIndex++;
      if (p.candleIndex >= p.candles.length || p.candles[p.candleIndex].time !== timestamp || p.candleIndex < windowM5) continue;

      const currentM5Candles = p.candles.slice(p.candleIndex - windowM5, p.candleIndex);
      const nextCandle = p.candles[p.candleIndex];
      const dateObj = new Date(timestamp);
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

      // Manage trades
      p.activeTrades = p.activeTrades.filter(trade => {
        trade.ageBars = (trade.ageBars ?? 0) + 1;
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) { closeTrade(pair, trade, trade.sl - slippage, "SL", timestamp); return false; }
          if (bidHigh >= trade.tp) { closeTrade(pair, trade, trade.tp - slippage, "TP", timestamp); return false; }
        } else {
          if (askHigh >= trade.sl) { closeTrade(pair, trade, trade.sl + slippage, "SL", timestamp); return false; }
          if (askLow <= trade.tp) { closeTrade(pair, trade, trade.tp + slippage, "TP", timestamp); return false; }
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

      // Session Hours (supports multi-window UTC, incl. half-hours)
      const activeWindow = getActiveSessionWindowUTC(dateObj);
      if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6 || !activeWindow) continue;

      if (p.cooldownCandlesRemaining > 0) {
        p.cooldownCandlesRemaining -= 1;
        continue;
      }

      processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
      if (p.activeTrades.length >= config.maxTradesPerPair) continue;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) continue;

      const sessionKey = getSessionKey(dateObj, activeWindow);
      if (["session_sweep", "ny_orb", "ny_asian_continuation"].includes(strategyMode)) {
        const strategyCfg = strategyMode === "ny_orb"
          ? config.strategy.nyOrb
          : strategyMode === "ny_asian_continuation"
            ? config.strategy.nyAsianContinuation
            : config.strategy.sessionSweep;
        const allowedSessions = strategyCfg.allowedSessionNames;
        if (Array.isArray(allowedSessions) && allowedSessions.length > 0 && !allowedSessions.includes(activeWindow.name)) continue;

        const maxTradesPerSession = strategyCfg.maxTradesPerSession ?? 1;
        if ((p.sessionTradeCounts.get(sessionKey) ?? 0) >= maxTradesPerSession) continue;

        const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);
        if (strategyMode === "session_sweep") {
          const noNewTradeMinutes = strategyCfg.noNewTradeMinutesBeforeSessionEnd ?? 0;
          if (h >= activeWindow.end - (noNewTradeMinutes / 60)) continue;
        } else if (strategyMode === "ny_asian_continuation") {
          if (h < strategyCfg.tradeStartUTC || h >= strategyCfg.tradeEndUTC) continue;
        } else if (Number.isFinite(strategyCfg.noNewTradeAfterUTC) && h >= strategyCfg.noNewTradeAfterUTC) {
          continue;
        }
      }

      // Signal Generation
      const liquidityLevels = strategyMode === "session_sweep"
        ? getLiquidityLevelsForSession(p, dateObj, activeWindow)
        : [];
      const openingRange = strategyMode === "ny_orb"
        ? getOpeningRangeForSession(p, dateObj)
        : null;
      const asianRange = strategyMode === "ny_asian_continuation"
        ? getAsianRangeForSession(p, dateObj)
        : null;
      const signal = generateStrategySignal(currentM5Candles, higherTimeframe, p, liquidityLevels, openingRange, asianRange);

      if (signal.signal === 'none' || p.activeTrades.length >= config.maxTradesPerPair || p.pendingOrders.length > 0) continue;

      handleSignal(pair, signal, midOpen, timestamp, p.candleIndex, sessionKey);
      processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
    }
  }

  function generateStrategySignal(currentM5Candles, higherTimeframe, p, liquidityLevels = [], openingRange = null, asianRange = null) {
    const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;

    if (strategyMode === "ny_asian_continuation") {
      return generateNYAsianContinuationSignal(currentM5Candles, {
        ...config.strategy.nyAsianContinuation,
        asianRange,
        higherTimeframeTrend: htfTrend,
        isJPY: p.isJPY,
      });
    }

    if (strategyMode === "ny_orb") {
      return generateNYOpeningRangeBreakoutSignal(currentM5Candles, {
        ...config.strategy.nyOrb,
        openingRange,
        higherTimeframeTrend: htfTrend,
        isJPY: p.isJPY,
      });
    }

    if (strategyMode === "session_sweep") {
      return generateSessionSweepSignal(currentM5Candles, {
        ...config.strategy.sessionSweep,
        levels: liquidityLevels,
        higherTimeframeTrend: htfTrend,
        isJPY: p.isJPY,
      });
    }

    if (strategyMode === "smash_sell") {
      return generateSmashSellSignal(currentM5Candles, { ...config.strategy.smashSell, higherTimeframeTrend: htfTrend, isJPY: p.isJPY });
    }

    if (strategyMode === "smash_buy") {
      return generateSmashBuySignal(currentM5Candles, { ...config.strategy.smashBuy, higherTimeframeTrend: htfTrend, isJPY: p.isJPY });
    }

    if (strategyMode === "smash") {
      const sellSignal = generateSmashSellSignal(currentM5Candles, { ...config.strategy.smashSell, higherTimeframeTrend: htfTrend, isJPY: p.isJPY });
      if (sellSignal.signal !== "none") return sellSignal;
      return generateSmashBuySignal(currentM5Candles, { ...config.strategy.smashBuy, higherTimeframeTrend: htfTrend, isJPY: p.isJPY });
    }

    return generateSignal(currentM5Candles, {
      pipBuffer: config.strategy.pipBuffer,
      rrRatio:   config.strategy.rrRatio,
      minRiskPips: config.strategy.minRiskPips,
      maxRiskPips: config.strategy.maxRiskPips,
      emaSeparationMinPips: config.strategy.emaSeparationMinPips,
      higherTimeframeTrend: htfTrend,
      isJPY:     p.isJPY,
    });
  }

  function handleSignal(pair, signal, price, time, setupIndex, sessionKey = null) {
    const p = pairData[pair];
    const action = signal.signal.toUpperCase();
    const riskPerTrade = INITIAL_BALANCE * ((config.risk.riskPerTradePercent ?? 1) / 100);
    const units = Math.min(10000, Math.floor(riskPerTrade / (signal.riskPips * (10/100000))));
    if (units <= 0) return;

    if (signal.signal === "sell_stop") {
      p.pendingOrders.push({
        direction: "SELL",
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        units,
        setupTime: signal.setupTime,
        setupIndex,
        expiresAfterBars: signal.pendingExpiryBars ?? config.strategy.smashSell.pendingExpiryBars,
        timeExitBars: signal.timeExitBars ?? config.strategy.smashSell.timeExitBars,
        forceExitUTC: signal.forceExitUTC,
        sessionKey,
        strategy: signal.strategy,
        levelName: signal.levelName,
        levelPrice: signal.levelPrice,
        pair,
        reason: signal.reason,
        riskPips: signal.riskPips,
        rewardPips: signal.rewardPips,
        atrPips: signal.atrPips,
        smashAtrRatio: signal.smashAtrRatio,
      });
      return;
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
        expiresAfterBars: signal.pendingExpiryBars ?? config.strategy.smashBuy.pendingExpiryBars,
        timeExitBars: signal.timeExitBars ?? config.strategy.smashBuy.timeExitBars,
        forceExitUTC: signal.forceExitUTC,
        sessionKey,
        strategy: signal.strategy,
        levelName: signal.levelName,
        levelPrice: signal.levelPrice,
        pair,
        reason: signal.reason,
        riskPips: signal.riskPips,
        rewardPips: signal.rewardPips,
        atrPips: signal.atrPips,
        smashAtrRatio: signal.smashAtrRatio,
      });
      return;
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
      ageBars: 0,
      timeExitBars: signal.timeExitBars,
      forceExitUTC: signal.forceExitUTC,
    });
  }

  function processPendingOrders(pair, p, market) {
    p.pendingOrders = p.pendingOrders.filter(order => {
      const ageBars = p.candleIndex - order.setupIndex;
      if (ageBars > order.expiresAfterBars) return false;
      if (p.activeTrades.length >= config.maxTradesPerPair) return true;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) return true;

      if (order.direction === "SELL" && market.bidLow <= order.entry) {
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
          atrPips: order.atrPips,
          smashAtrRatio: order.smashAtrRatio,
        });
        return false;
      }

      if (order.direction === "BUY" && market.askHigh >= order.entry) {
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
          atrPips: order.atrPips,
          smashAtrRatio: order.smashAtrRatio,
        });
        return false;
      }

      return true;
    });
  }

  function getTotalActiveTrades() {
    return Object.values(pairData).reduce((sum, p) => sum + p.activeTrades.length, 0);
  }

  function closeTrade(pair, trade, exitPrice, reason, exitTime) {
    const p = pairData[pair];
    const diff = trade.direction === "BUY" ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
    const pips = diff / p.pipSize;
    const grossProfit = (pips * (10/100000)) * trade.units;
    const commission = COMMISSION_SIDE_USD * 2 * (trade.units / 100_000);
    const profit = grossProfit - commission;
    balance += profit;
    if (reason === "SL" && config.strategy.cooldownCandlesAfterLoss > 0) {
      p.cooldownCandlesRemaining = Math.max(p.cooldownCandlesRemaining, config.strategy.cooldownCandlesAfterLoss);
    }
    p.tradeHistory.push({ ...trade, exit: exitPrice, exitTime, reason, grossProfit, commission, profit, balance });
    console.log(`  ✅ [${exitTime}] ${pair} ${reason} | Net: $${profit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  const allHistory = Object.values(pairData).flatMap(p => p.tradeHistory);
  const wins = allHistory.filter(t => t.profit > 0);
  const byPair = Object.fromEntries(Object.keys(pairData).map(pair => [pair, summarizeTrades(pairData[pair].tradeHistory)]));

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
      emaSeparationMinPips: config.strategy.emaSeparationMinPips,
      cooldownCandlesAfterLoss: config.strategy.cooldownCandlesAfterLoss,
      minRiskPips: config.strategy.minRiskPips,
      maxRiskPips: config.strategy.maxRiskPips,
      riskPerTradePercent: config.risk.riskPerTradePercent,
      higherTimeframeTrend: htfConfig.enabled ? {
        granularity: htfConfig.granularity || config.higherTimeframe,
        emaPeriod: htfConfig.emaPeriod,
        requireSlope: htfConfig.requireSlope,
      } : null,
      smashSell: ["smash_sell", "smash"].includes(strategyMode) ? config.strategy.smashSell : null,
      smashBuy: ["smash_buy", "smash"].includes(strategyMode) ? config.strategy.smashBuy : null,
      sessionSweep: strategyMode === "session_sweep" ? config.strategy.sessionSweep : null,
      nyOrb: strategyMode === "ny_orb" ? config.strategy.nyOrb : null,
      nyAsianContinuation: strategyMode === "ny_asian_continuation" ? config.strategy.nyAsianContinuation : null,
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
    }
  };

  fs.writeFileSync("trades_backtest.json", JSON.stringify(finalStats, null, 2));

  console.log(`\n  📊 FINAL: $${balance.toFixed(2)} | Trades: ${allHistory.length} | Win Rate: ${finalStats.summary.winRate}%`);
  console.log(`  📈 Per-pair summary:`);
  for (const [pair, stats] of Object.entries(byPair)) {
    console.log(`     ${pair.padEnd(8)} Trades: ${String(stats.total).padStart(3)} | Win: ${stats.winRate}% | PF: ${stats.profitFactor} | Net: $${stats.netProfit}`);
  }
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
  const dailyRanges = new Map();
  const asianRanges = new Map();
  const asianCfg = config.strategy.nyAsianContinuation ?? {};
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

    updateRange(dailyRanges, key, high, low);

    const h = date.getUTCHours() + (date.getUTCMinutes() / 60);
    if (h >= asianStart && h < asianEnd) updateRange(asianRanges, key, high, low);
  }

  const sortedDays = Array.from(dailyRanges.keys()).sort();
  const previousDayRanges = new Map();
  for (let i = 1; i < sortedDays.length; i++) {
    previousDayRanges.set(sortedDays[i], dailyRanges.get(sortedDays[i - 1]));
  }

  return { dailyRanges, asianRanges, previousDayRanges };
}

function buildOpeningRangeContext(candles) {
  const ranges = new Map();
  const cfg = config.strategy.nyOrb ?? {};
  const start = cfg.openingRangeStartUTC ?? 12.5;
  const end = cfg.openingRangeEndUTC ?? 13.0;

  for (const candle of candles) {
    const mid = candle.mid;
    if (!mid) continue;

    const date = new Date(candle.time);
    const h = date.getUTCHours() + (date.getUTCMinutes() / 60);
    if (h < start || h >= end) continue;

    const key = dayKeyUTC(date);
    const high = parseFloat(mid.h);
    const low = parseFloat(mid.l);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    updateRange(ranges, key, high, low);
  }

  return { ranges, start, end };
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

function getLiquidityLevelsForSession(pairState, dateObj, activeWindow) {
  const cfg = config.strategy.sessionSweep;
  const key = dayKeyUTC(dateObj);
  const levels = [];
  const name = activeWindow?.name ?? "";

  const asian = pairState.liquidityContext.asianRanges.get(key);
  if (cfg.useAsianLevels && asian && (name === "london_open" || name === "ny_overlap" || name === "legacy")) {
    levels.push({ name: "asian_high", side: "high", price: asian.high, priority: name === "london_open" ? 3 : 2 });
    levels.push({ name: "asian_low", side: "low", price: asian.low, priority: name === "london_open" ? 3 : 2 });
  }

  const previousDay = pairState.liquidityContext.previousDayRanges.get(key);
  if (cfg.usePreviousDayLevels && previousDay && (name === "ny_overlap" || name === "legacy")) {
    levels.push({ name: "previous_day_high", side: "high", price: previousDay.high, priority: 3 });
    levels.push({ name: "previous_day_low", side: "low", price: previousDay.low, priority: 3 });
  }

  return levels;
}

function getOpeningRangeForSession(pairState, dateObj) {
  const key = dayKeyUTC(dateObj);
  const range = pairState.openingRangeContext.ranges.get(key);
  if (!range) return null;

  return {
    name: "ny_opening_range",
    high: range.high,
    low: range.low,
    start: pairState.openingRangeContext.start,
    end: pairState.openingRangeContext.end,
  };
}

function getAsianRangeForSession(pairState, dateObj) {
  const key = dayKeyUTC(dateObj);
  const range = pairState.liquidityContext.asianRanges.get(key);
  if (!range) return null;

  const cfg = config.strategy.nyAsianContinuation ?? {};
  return {
    name: "asian_range",
    high: range.high,
    low: range.low,
    start: cfg.asianStartUTC ?? 0,
    end: cfg.asianEndUTC ?? 7,
  };
}

function dayKeyUTC(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

main().catch(console.error);
