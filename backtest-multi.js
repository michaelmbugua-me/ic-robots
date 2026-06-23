/**
 * Backtest Runner — NY Asian Range Continuation Strategy (Multi-Pair)
 */

import fs from "fs";
import { detectHigherTimeframeTrend, generateLondonAsianFakeBreakReversalSignal, generateNYAsianContinuationSignal } from "./indicators.js";
import { config } from "./config.js";
import { calculatePipValueUSD, calculateRiskVolume } from "./position-sizing.js";

const INITIAL_BALANCE = config.risk.accountCapitalKES / 129.0;
const COMMISSION_SIDE_USD = 3.00;
const SPREAD_PIPS = config.backtest?.spreadPips ?? 0.5;
const SLIPPAGE_PIPS = config.backtest?.slippagePips ?? 0.2;
const USD_KES_RATE = config.risk.usdKesRate ?? 129.0;

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
        higherTimeframeCandles: htfConfig.enabled ? buildHourlyCandles(candles) : [],
        liquidityContext: buildLiquidityContext(candles),
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

      // Manage trades
      p.activeTrades = p.activeTrades.filter(trade => {
        trade.ageBars = (trade.ageBars ?? 0) + 1;
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) { closeTrade(pair, trade, trade.sl - slippage, "SL", timestamp); return false; }
          if (Number.isFinite(trade.tp) && bidHigh >= trade.tp) { closeTrade(pair, trade, trade.tp - slippage, "TP", timestamp); return false; }
        } else {
          if (askHigh >= trade.sl) { closeTrade(pair, trade, trade.sl + slippage, "SL", timestamp); return false; }
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

      // Session Hours (supports multi-window UTC, incl. half-hours)
      const activeWindow = getActiveSessionWindowUTC(dateObj);
      if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6 || !activeWindow) continue;

      if (p.cooldownCandlesRemaining > 0) {
        p.cooldownCandlesRemaining -= 1;
        continue;
      }

      processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
      if (!canBacktestTrade(timestamp)) continue;
      if (!canLondonModuleTrade(timestamp)) continue;
      if (p.activeTrades.length >= config.maxTradesPerPair) continue;
      if (getTotalActiveTrades() >= (config.maxTotalTrades ?? Infinity)) continue;

      const sessionKey = getSessionKey(dateObj, activeWindow);
      const strategyCfg = getActiveStrategyConfig();
      const allowedSessions = strategyCfg.allowedSessionNames;
      if (Array.isArray(allowedSessions) && allowedSessions.length > 0 && !allowedSessions.includes(activeWindow.name)) continue;

      const maxTradesPerSession = strategyCfg.maxTradesPerSession ?? 1;
      if ((p.sessionTradeCounts.get(sessionKey) ?? 0) >= maxTradesPerSession) continue;

      const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);
      if (h < strategyCfg.tradeStartUTC || h >= strategyCfg.tradeEndUTC) continue;

      if (strategyMode === "london_asian_fake_break_reversal") {
        const excludedDay = strategyCfg.excludedPairWeekdays?.[pair];
        if (excludedDay && excludedDay === weekdayUTC(dateObj)) continue;
      }

      // Signal Generation
      const asianRange = getAsianRangeForSession(p, dateObj);
      const signal = generateStrategySignal(currentM5Candles, higherTimeframe, p, asianRange);

      if (signal.signal === 'none' || p.activeTrades.length >= config.maxTradesPerPair || p.pendingOrders.length > 0) continue;

      handleSignal(pair, signal, midOpen, timestamp, p.candleIndex, sessionKey);
      processPendingOrders(pair, p, { timestamp, bidLow, askHigh, slippage });
    }
  }

  function generateStrategySignal(currentM5Candles, higherTimeframe, p, asianRange = null) {
    const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;

    if (strategyMode === "ny_asian_continuation") {
      return generateNYAsianContinuationSignal(currentM5Candles, {
        ...config.strategy.nyAsianContinuation,
        asianRange,
        higherTimeframeTrend: htfTrend,
        isJPY: p.isJPY,
      });
    }

    if (strategyMode === "london_asian_fake_break_reversal") {
      return generateLondonAsianFakeBreakReversalSignal(currentM5Candles, {
        ...config.strategy.londonAsianFakeBreakReversal,
        asianRange,
        higherTimeframeTrend: htfTrend,
        isJPY: p.isJPY,
      });
    }

    return { signal: "none", reason: `Unsupported backtest strategy mode ${strategyMode}` };
  }

  function handleSignal(pair, signal, price, time, setupIndex, sessionKey = null) {
    if (!canBacktestTrade(time)) {
      dailyRisk.blockedSignals += 1;
      return;
    }

    const p = pairData[pair];
    const action = signal.signal.toUpperCase();
    const units = calculateBacktestUnits(pair, signal);
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
      convictionMultiplier: signal.convictionMultiplier ?? 1.0,
    });
    if (sessionKey) {
      p.sessionTradeCounts.set(sessionKey, (p.sessionTradeCounts.get(sessionKey) ?? 0) + 1);
    }
  }

  function resetLondonModuleRiskIfNeeded(dateLike) {
    const day = dayKeyUTC(new Date(dateLike));
    if (londonModuleRisk.currentDay === day) return;
    londonModuleRisk.currentDay = day;
    londonModuleRisk.dailyLosses = 0;
    londonModuleRisk.dailyLossUSD = 0;
  }

  function canLondonModuleTrade(dateLike) {
    if (strategyMode !== "london_asian_fake_break_reversal") return true;
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
    if (strategyMode !== "london_asian_fake_break_reversal") return;
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
    const capital = balance * USD_KES_RATE;
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
    const pipValueUSDPerUnit = pipValueUSDPerLot / 100_000;
    const grossProfit = pips * pipValueUSDPerUnit * trade.units;
    const commission = COMMISSION_SIDE_USD * 2 * (trade.units / 100_000);
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
    },
    dailyRiskSimulation: {
      blockedDays,
    },
    londonModuleRiskSimulation: strategyMode === "london_asian_fake_break_reversal" ? {
      maxLossesPerDay: config.strategy.londonAsianFakeBreakReversal?.maxLossesPerDay ?? 0,
      maxDailyLossUSD: config.strategy.londonAsianFakeBreakReversal?.maxDailyLossUSD ?? 0,
      blockedEvaluations: londonModuleRisk.blockedEvaluations,
      blockedDays: Array.from(londonModuleRisk.blockedDays.values()).sort((a, b) => a.day.localeCompare(b.day)),
    } : null,
  };

  fs.writeFileSync("trades_backtest.json", JSON.stringify(finalStats, null, 2));

  console.log(`\n  📊 FINAL: $${balance.toFixed(2)} | Trades: ${allHistory.length} | Win Rate: ${finalStats.summary.winRate}%`);
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

function getActiveStrategyConfig() {
  if (strategyMode === "london_asian_fake_break_reversal") return config.strategy.londonAsianFakeBreakReversal;
  return config.strategy.nyAsianContinuation;
}

function dayKeyUTC(dateObj) {
  return dateObj.toISOString().slice(0, 10);
}

function weekdayUTC(dateObj) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dateObj.getUTCDay()];
}

main().catch(console.error);
