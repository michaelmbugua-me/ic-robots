#!/usr/bin/env node

/**
 * 5-10-20 EMA Scalping Strategy
 * M5 Execution on EURUSD — IC Markets cTrader
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";
import { detectHigherTimeframeTrend, generateNYAsianContinuationSignal, generateSignal } from "./indicators.js";
import { RiskManager } from "./risk-manager.js";

const STATE_FILE = "state.json";
const AUTO_EXECUTE = process.argv.includes("--auto-execute");
const PAIRS = config.tradingPairs;
const GRANULARITY_MS = {
  M1: 60_000,
  M2: 2 * 60_000,
  M3: 3 * 60_000,
  M4: 4 * 60_000,
  M5: 5 * 60_000,
  M10: 10 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

const icmarkets = new ICMarketsClient();
const riskManager = new RiskManager(config);
const pairState = new Map();

function getState(pair) {
  if (!pairState.has(pair)) {
    pairState.set(pair, {
      candleCache: [],
      higherTimeframeCandleCache: [],
      activeTrades: [],
      pendingOrders: [],
      sessionTradeCounts: new Map(),
      cooldownCandlesRemaining: 0,
      lastCandleTime: null,
      lastLogTime: 0,
    });
  }
  return pairState.get(pair);
}

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊 EURUSD M5 BOT — ${config.strategy.mode.toUpperCase()}`);
  console.log(`  Mode: ${AUTO_EXECUTE ? "🚀 AUTO-EXECUTE" : "💡 MONITOR ONLY"}`);
  console.log(`  Session: ${config.sessionWindowMode} | Risk: ${config.risk.riskPerTradePercent}% per trade`);
  console.log(`${"═".repeat(60)}\n`);

  console.log(`  🔌 Connecting to cTrader (${config.ctraderEnv})...`);
  await icmarkets.connect();
  console.log(`  ✅ Connected.`);

  await new Promise(r => setTimeout(r, 1000));

  console.log(`  🔐 Authenticating trading account...`);
  await icmarkets.authenticate();
  console.log(`  ✅ Authenticated.`);

  for (const pair of PAIRS) {
    console.log(`  🔄 Reconciling account state for ${pair}...`);
    await reconcileAccount(pair);
    console.log(`  📡 Subscribing to live ticks for ${pair}...`);
    await icmarkets.subscribeTicks(pair);
  }

  icmarkets.on(2126, (payload) => handleExecutionEvent(payload));

  console.log(`  ⏱️ Poll loop started (${config.pollIntervalSeconds}s interval).`);
  await tick();
  setInterval(tick, config.pollIntervalSeconds * 1000);
}

async function tick() {
  const timestamp = new Date().toLocaleTimeString();
  const now = new Date();

  const day = now.getUTCDay();
  const activeWindow = getActiveSessionWindowUTC(now);
  if (day === 0 || day === 6 || !activeWindow) {
    const utcHour = `${now.getUTCHours()}`.padStart(2, "0");
    const utcMin = `${now.getUTCMinutes()}`.padStart(2, "0");
    process.stdout.write(`[${timestamp}] 💤 Outside trading windows (${utcHour}:${utcMin} UTC)\r`);
    return;
  }

  for (const pair of PAIRS) {
    await tickPair(pair, timestamp).catch(err => console.error(`  ❌ ${pair} error:`, err.message));
  }
}

async function tickPair(pair, timestamp) {
  const state = getState(pair);
  const now   = Date.now();
  const isJPY = pair.includes("JPY");

  // 1. Refresh candles every poll to avoid stale trend/signal state.
  try {
    const candleCount = config.strategy.mode === "ny_asian_continuation"
      ? (config.strategy.nyAsianContinuation?.lookbackCandles ?? 220)
      : 100;
    const latestCandles = await getLiveMidCandles(pair, config.granularity, candleCount + 2);
    const closedCandles = onlyClosedCandles(latestCandles, config.granularity, now);
    if (closedCandles.length > 0) {
      state.candleCache = closedCandles.slice(-candleCount);
    }
  } catch (err) {
    if (!state.candleCache.length) {
      throw err;
    }
  }

  const htfConfig = config.strategy.higherTimeframeTrend ?? {};
  let higherTimeframe = { trend: 'neutral', ema: null, close: null, reason: 'Higher-timeframe filter disabled' };
  if (htfConfig.enabled) {
    try {
      const htfGranularity = htfConfig.granularity || config.higherTimeframe || "H1";
      const htfCandleCount = htfConfig.lookbackCandles || 250;
      const htfCandles = await getLiveMidCandles(
        pair,
        htfGranularity,
        htfCandleCount + 2,
      );
      const closedHtfCandles = onlyClosedCandles(htfCandles, htfGranularity, now);
      if (closedHtfCandles.length > 0) {
        state.higherTimeframeCandleCache = closedHtfCandles.slice(-htfCandleCount);
      }
    } catch (err) {
      if (!state.higherTimeframeCandleCache.length) {
        console.error(`  ⚠️  ${pair} HTF data unavailable: ${err.message}`);
      }
    }

    higherTimeframe = detectHigherTimeframeTrend(state.higherTimeframeCandleCache, {
      emaPeriod: htfConfig.emaPeriod || 200,
      requireSlope: htfConfig.requireSlope ?? true,
    });
  }

  if (state.candleCache.length < 22) return;

  const currentCandleTime = state.candleCache[state.candleCache.length - 1]?.time ?? null;
  if (currentCandleTime && currentCandleTime !== state.lastCandleTime) {
    if (state.lastCandleTime && state.cooldownCandlesRemaining > 0) {
      state.cooldownCandlesRemaining -= 1;
    }
    for (const trade of state.activeTrades) {
      trade.ageBars = (trade.ageBars ?? 0) + 1;
    }
    state.lastCandleTime = currentCandleTime;
  }

  if (state.cooldownCandlesRemaining > 0) return;

  await manageActiveTradeTimeExits(pair, state);
  await processPendingOrders(pair, state);
  if (state.activeTrades.length >= config.maxTradesPerPair) return;
  if (!hasAvailableTradeSlot()) return;

  // 2. Generate signal
  const activeWindow = getActiveSessionWindowUTC(new Date());
  const signal = generateStrategySignal(state, higherTimeframe, activeWindow, isJPY);

  // Log status every minute
  if (now - (state.lastLogTime || 0) > 60000) {
    console.log(
      `[${timestamp}] ${pair} | Trend: ${signal.trend.toUpperCase()} | ` +
      `HTF: ${higherTimeframe.trend.toUpperCase()} | ` +
      `Strategy: ${config.strategy.mode} | Pending: ${state.pendingOrders.length} | ` +
      `Signal: ${signal.signal.toUpperCase()}`
    );
    if (signal.signal !== 'none') console.log(`  → ${signal.reason}`);
    state.lastLogTime = now;
  }

  if (signal.signal === 'none') return;

  // 3. Trade gate
  if (state.activeTrades.length >= config.maxTradesPerPair || state.pendingOrders.length > 0) return;
  if (!hasAvailableTradeSlot()) {
    console.log(`  ⛔ Account trade slot full: active + pending = ${getReservedTradeSlotCount()}/${getMaxTotalTrades()}`);
    return;
  }

  const action = signal.direction || signal.signal.toUpperCase(); // 'BUY' | 'SELL'

  console.log(
    `\n⚡ [${timestamp}] ${pair} ${action} | ` +
    `Entry: ${signal.entry} SL: ${signal.sl} TP: ${signal.tp} | ` +
    `Risk: ${signal.riskPips}p Reward: ${signal.rewardPips}p`
  );

  if (signal.signal === "buy_stop" || signal.signal === "sell_stop") {
    if (!AUTO_EXECUTE) return;
    if (!addPendingOrder(state, signal)) return;
    saveState();
    await processPendingOrders(pair, state);
    return;
  }

  if (!["buy", "sell"].includes(signal.signal)) {
    console.log(`  ⚠️  Unsupported live signal type "${signal.signal}" ignored.`);
    return;
  }

  if (!AUTO_EXECUTE) return;

  try {
    const gate = riskManager.canTrade();
    if (!gate.allowed) {
      console.log(`  ⛔ Risk gate blocked trade: ${gate.reason}`);
      return;
    }

    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry);
    if (units <= 0) return;

    // Use the signal's entry price for more accurate relative SL/TP if possible,
    // though icmarkets.openPosition will fetch current market price for reliability.
    const res = await icmarkets.openPosition(pair, action, units, signal.sl, signal.tp, signal.entry);
    if (res && res.positionId) {
      state.activeTrades.push({ id: String(res.positionId), direction: action, pair, entry: signal.entry, sl: signal.sl, tp: signal.tp });
      riskManager.onTradeOpened(String(res.positionId), pair, action, signal.entry, signal.sl, signal.tp, units);
      saveState();
    }
  } catch (err) {
    console.error(`  ❌ Trade failed:`, err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateStrategySignal(state, higherTimeframe, activeWindow, isJPY) {
  const htfConfig = config.strategy.higherTimeframeTrend ?? {};
  const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;

  if (config.strategy.mode === "ny_asian_continuation") {
    const cfg = config.strategy.nyAsianContinuation ?? {};
    if (Array.isArray(cfg.allowedSessionNames) && cfg.allowedSessionNames.length > 0 && !cfg.allowedSessionNames.includes(activeWindow?.name)) {
      return noSignal(`NY Asian continuation blocked outside allowed session (${activeWindow?.name ?? "none"})`);
    }

    const sessionKey = getSessionKey(new Date(), activeWindow);
    if ((state.sessionTradeCounts.get(sessionKey) ?? 0) >= (cfg.maxTradesPerSession ?? 1)) {
      return noSignal(`NY Asian continuation max trades reached for ${sessionKey}`);
    }

    return generateNYAsianContinuationSignal(state.candleCache, {
      ...cfg,
      asianRange: getAsianRangeFromCandles(state.candleCache, new Date(), cfg),
      higherTimeframeTrend: htfTrend,
      isJPY,
    });
  }

  return generateSignal(state.candleCache, {
    pipBuffer: config.strategy.pipBuffer,
    rrRatio:   config.strategy.rrRatio,
    minRiskPips: config.strategy.minRiskPips,
    maxRiskPips: config.strategy.maxRiskPips,
    emaSeparationMinPips: config.strategy.emaSeparationMinPips,
    higherTimeframeTrend: htfTrend,
    isJPY,
  });
}

function noSignal(reason) {
  return { signal: "none", trend: "neutral", entry: null, sl: null, tp: null, riskPips: null, rewardPips: null, reason };
}

async function getLiveMidCandles(pair, granularity, count) {
  const [bidCandles, askCandles] = await Promise.all([
    icmarkets.getCandles(pair, granularity, count, null, null, 1),
    icmarkets.getCandles(pair, granularity, count, null, null, 2),
  ]);
  return mergeBidAskCandles(bidCandles, askCandles);
}

function mergeBidAskCandles(bidCandles = [], askCandles = []) {
  if (!Array.isArray(bidCandles) || !Array.isArray(askCandles)) return [];

  const asksByTime = new Map(askCandles.map(candle => [candle.time, candle]));
  return bidCandles
    .map(bidCandle => {
      const askCandle = asksByTime.get(bidCandle.time);
      if (!askCandle) return null;

      const bid = extractPriceFields(bidCandle);
      const ask = extractPriceFields(askCandle);
      if (!bid || !ask) return null;

      return {
        time: bidCandle.time,
        complete: Boolean(bidCandle.complete && askCandle.complete),
        volume: Math.max(Number(bidCandle.volume) || 0, Number(askCandle.volume) || 0),
        bid: formatPriceFields(bid),
        ask: formatPriceFields(ask),
        mid: formatPriceFields({
          o: (bid.o + ask.o) / 2,
          h: (bid.h + ask.h) / 2,
          l: (bid.l + ask.l) / 2,
          c: (bid.c + ask.c) / 2,
        }),
      };
    })
    .filter(Boolean);
}

function extractPriceFields(candle) {
  const source = candle?.mid ?? candle?.bid ?? candle?.ask;
  if (!source) return null;
  const prices = {
    o: Number(source.o),
    h: Number(source.h),
    l: Number(source.l),
    c: Number(source.c),
  };
  return Object.values(prices).every(v => Number.isFinite(v) && v > 0) ? prices : null;
}

function formatPriceFields(prices) {
  return {
    o: prices.o.toFixed(5),
    h: prices.h.toFixed(5),
    l: prices.l.toFixed(5),
    c: prices.c.toFixed(5),
  };
}

function onlyClosedCandles(candles, granularity, nowMs = Date.now()) {
  if (!Array.isArray(candles)) return [];
  const periodMs = GRANULARITY_MS[String(granularity || "").toUpperCase()] ?? GRANULARITY_MS.M5;
  return candles.filter(candle => {
    const openMs = new Date(candle?.time).getTime();
    return Number.isFinite(openMs) && openMs + periodMs <= nowMs;
  });
}

function addPendingOrder(state, signal) {
  if (!hasAvailableTradeSlot()) {
    console.log(`  ⛔ Pending ${signal.direction} stop not armed: active + pending = ${getReservedTradeSlotCount()}/${getMaxTotalTrades()}`);
    return false;
  }

  const latest = state.candleCache.at(-1);
  const setupMs = latest?.time ? new Date(latest.time).getTime() : Date.now();
  const expiresAfterBars = signal.pendingExpiryBars ?? 3;
  const activeWindow = getActiveSessionWindowUTC(new Date());
  const sessionKey = getSessionKey(new Date(), activeWindow);

  state.pendingOrders.push({
    direction: signal.direction,
    entry: signal.entry,
    sl: signal.sl,
    tp: signal.tp,
    setupTime: signal.setupTime,
    setupCandleTime: latest?.time,
    expiresAtMs: setupMs + expiresAfterBars * 5 * 60_000,
    expiresAfterBars,
    timeExitBars: signal.timeExitBars,
    forceExitUTC: signal.forceExitUTC,
    sessionKey,
    strategy: signal.strategy,
    levelName: signal.levelName,
    levelPrice: signal.levelPrice,
    riskPips: signal.riskPips,
    rewardPips: signal.rewardPips,
    reason: signal.reason,
  });
  console.log(`  📌 Pending ${signal.direction} stop armed @ ${signal.entry} (expires in ${expiresAfterBars} M5 bars).`);
  return true;
}

async function processPendingOrders(pair, state) {
  if (!AUTO_EXECUTE || state.pendingOrders.length === 0) return;
  const latest = normalizeLiveCandle(state.candleCache.at(-1));
  const latestTime = state.candleCache.at(-1)?.time;
  if (!latest) return;

  const kept = [];
  for (const order of state.pendingOrders) {
    if (latest.date.getTime() > order.expiresAtMs) {
      console.log(`  ⌛ Pending ${order.direction} stop expired @ ${order.entry}`);
      continue;
    }
    if (latestTime && order.setupCandleTime && latestTime === order.setupCandleTime) {
      kept.push(order);
      continue;
    }
    if (state.activeTrades.length >= config.maxTradesPerPair) {
      kept.push(order);
      continue;
    }
    if (getOpenTradeCount() >= getMaxTotalTrades()) {
      kept.push(order);
      continue;
    }

    const triggered = order.direction === "BUY" ? latest.high >= order.entry : latest.low <= order.entry;
    if (!triggered) {
      kept.push(order);
      continue;
    }

    await executeOrderSignal(pair, state, order);
  }

  state.pendingOrders = kept;
}

async function executeOrderSignal(pair, state, signal) {
  try {
    const gate = riskManager.canTrade();
    if (!gate.allowed) {
      console.log(`  ⛔ Risk gate blocked pending ${signal.direction}: ${gate.reason}`);
      return;
    }

    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry);
    if (units <= 0) return;

    const res = await icmarkets.openPosition(pair, signal.direction, units, signal.sl, signal.tp, signal.entry);
    if (res && res.positionId) {
      state.activeTrades.push({
        id: String(res.positionId), direction: signal.direction, pair,
        entry: signal.entry, sl: signal.sl, tp: signal.tp,
        strategy: signal.strategy, sessionKey: signal.sessionKey,
        ageBars: 0, timeExitBars: signal.timeExitBars, forceExitUTC: signal.forceExitUTC,
      });
      if (signal.sessionKey) {
        state.sessionTradeCounts.set(signal.sessionKey, (state.sessionTradeCounts.get(signal.sessionKey) ?? 0) + 1);
      }
      riskManager.onTradeOpened(String(res.positionId), pair, signal.direction, signal.entry, signal.sl, signal.tp, units);
      saveState();
      console.log(`  ✅ Pending ${signal.direction} triggered and sent as market order.`);
    }
  } catch (err) {
    console.error(`  ❌ Pending order execution failed:`, err.message);
  }
}

async function manageActiveTradeTimeExits(pair, state) {
  if (!AUTO_EXECUTE || state.activeTrades.length === 0) return;
  const latest = normalizeLiveCandle(state.candleCache.at(-1));
  if (!latest) return;
  const hour = latest.date.getUTCHours() + latest.date.getUTCMinutes() / 60;

  for (const trade of state.activeTrades) {
    if (trade.closing) continue;
    const hitTimeExit = trade.timeExitBars && (trade.ageBars ?? 0) >= trade.timeExitBars;
    const hitForceExit = Number.isFinite(trade.forceExitUTC) && hour >= trade.forceExitUTC;
    if (!hitTimeExit && !hitForceExit) continue;

    trade.closing = true;
    console.log(`  ⏱️  Closing ${pair} ${trade.direction} by ${hitForceExit ? "16:00 UTC" : "time-exit"} rule.`);
    try {
      await icmarkets.closeTrade(trade.id);
    } catch (err) {
      trade.closing = false;
      console.error(`  ❌ Time-exit close failed for ${trade.id}:`, err.message);
    }
  }
}

function normalizeLiveCandle(candle) {
  if (!candle) return null;
  const m = candle.mid ?? candle.bid ?? candle.ask;
  if (!m) return null;
  const out = {
    date: new Date(candle.time),
    open: Number(m.o),
    high: Number(m.h),
    low: Number(m.l),
    close: Number(m.c),
  };
  return [out.open, out.high, out.low, out.close].every(Number.isFinite) ? out : null;
}

function getAsianRangeFromCandles(candles, dateObj, cfg = {}) {
  const day = dateObj.toISOString().slice(0, 10);
  const start = cfg.asianStartUTC ?? 0;
  const end = cfg.asianEndUTC ?? 7;
  const asian = candles
    .map(c => ({ raw: c, norm: normalizeLiveCandle(c) }))
    .filter(({ raw, norm }) => {
      if (!norm || raw.time.slice(0, 10) !== day) return false;
      const h = norm.date.getUTCHours() + norm.date.getUTCMinutes() / 60;
      return h >= start && h < end;
    })
    .map(x => x.norm);

  if (asian.length < 12) return null;
  return {
    name: "asian_range",
    high: Math.max(...asian.map(c => c.high)),
    low: Math.min(...asian.map(c => c.low)),
    start,
    end,
  };
}

function handleExecutionEvent(payload) {
  if (payload.executionType === "DEAL_FILLED" || payload.executionType === 4) {
    const deal = payload.deal;
    if (deal && deal.closePositionDetail) {
      const positionId = String(deal.positionId);
      let matchedTrade = null;
      console.log(`  🔔  Position ${positionId} closed.`);
      for (const [, state] of pairState) {
        const found = state.activeTrades.find(t => t.id === positionId);
        if (found) matchedTrade = found;
        state.activeTrades = state.activeTrades.filter(t => t.id !== positionId);
      }
      const pnlKES = realizedPnlKES(deal);
      if (Number.isFinite(pnlKES)) {
        riskManager.onTradeClosed(positionId, pnlKES);
      }
      riskManager.syncOpenTradeCount(getOpenTradeCount());

      if (matchedTrade && config.strategy.cooldownCandlesAfterLoss > 0) {
        let exitPrice = Number(deal.executionPrice ?? 0);
        if (exitPrice > 1000) exitPrice = exitPrice / 100000;
        const pipSize = matchedTrade.pair?.includes("JPY") ? 0.01 : 0.0001;
        const epsilon = pipSize * 2;
        if (Math.abs(exitPrice - matchedTrade.sl) <= epsilon) {
          const state = getState(matchedTrade.pair);
          state.cooldownCandlesRemaining = Math.max(state.cooldownCandlesRemaining, config.strategy.cooldownCandlesAfterLoss);
        }
      }

      saveState();
    }
  }
}

function realizedPnlKES(deal) {
  const detail = deal?.closePositionDetail;
  if (!detail) return null;
  const moneyDigits = Number(detail.moneyDigits ?? deal.moneyDigits ?? 2);
  const divisor = 10 ** moneyDigits;
  const gross = Number(detail.grossProfit ?? 0);
  const swap = Number(detail.swap ?? 0);
  const commission = Number(detail.commission ?? 0);
  const conversionFee = Number(detail.pnlConversionFee ?? 0);
  const pnlDepositCurrency = (gross + swap + commission + conversionFee) / divisor;
  return pnlDepositCurrency * (config.risk.usdKesRate ?? 129.0);
}

async function reconcileAccount(pair) {
  const state = getState(pair);
  try {
    const positions = await icmarkets.reconcile();
    const symbolId = icmarkets._resolveSymbolId(pair);
    state.activeTrades = positions
      .filter(p => p.tradeData && String(p.tradeData.symbolId) === String(symbolId))
      .map(p => ({ id: String(p.positionId), direction: p.tradeData.tradeSide, pair }));
    riskManager.syncOpenTradeCount(getOpenTradeCount());
    saveState();
  } catch (err) {}
}

function getOpenTradeCount() {
  let count = 0;
  for (const [, state] of pairState) count += state.activeTrades.length;
  return count;
}

function getPendingOrderCount() {
  let count = 0;
  for (const [, state] of pairState) count += state.pendingOrders.length;
  return count;
}

function getReservedTradeSlotCount() {
  return getOpenTradeCount() + getPendingOrderCount();
}

function getMaxTotalTrades() {
  const configured = Number(config.maxTotalTrades);
  return Number.isFinite(configured) && configured > 0 ? configured : Infinity;
}

function hasAvailableTradeSlot() {
  return getReservedTradeSlotCount() < getMaxTotalTrades();
}

function saveState() {
  const allTrades = [];
  for (const [, state] of pairState) allTrades.push(...state.activeTrades);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ activeTrades: allTrades }, null, 2));
}

function getSessionKey(dateObj, activeWindow) {
  return `${dateObj.toISOString().slice(0, 10)}:${activeWindow?.name ?? "unknown"}`;
}

function getActiveSessionWindowUTC(now) {
  const windows = config.sessionWindowsUTC;
  if (!Array.isArray(windows) || windows.length === 0) {
    const h = now.getUTCHours() + (now.getUTCMinutes() / 60);
    return h >= config.sessionStartUTC && h < config.sessionEndUTC ? { name: "legacy" } : null;
  }

  const h = now.getUTCHours() + (now.getUTCMinutes() / 60);
  return windows.find(w => h >= w.start && h < w.end) || null;
}

run().catch(console.error);
