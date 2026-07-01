#!/usr/bin/env node

/**
 * NY Asian Range Continuation Strategy
 * M5 Execution on IC Markets cTrader
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";
import { detectHigherTimeframeTrend, generateLondonAsianFakeBreakReversalSignal, generateNYAsianContinuationSignal } from "./indicators.js";
import { RiskManager } from "./risk-manager.js";
import { getPipSize, getPriceDecimals, formatPrice, getInstrumentType } from "./instrument-utils.js";

const STATE_FILE = "state.json";
const AUTO_EXECUTE = process.argv.includes("--auto-execute");
const PAIRS = config.tradingPairs;
const SPOT_EVENT = 2131;
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
const riskManager = new RiskManager();
const pairState = new Map();
const symbolIdToPair = new Map();
const savedActiveTradesById = loadSavedActiveTradesById();
const savedPendingOrdersById = loadSavedPendingOrdersById();
const londonModuleRisk = loadSavedLondonModuleRisk();
let tickInProgress = false;

function getState(pair) {
  if (!pairState.has(pair)) {
    pairState.set(pair, {
      candleCache: [],
      higherTimeframeCandleCache: [],
      activeTrades: [],
      pendingOrders: [],
      sessionTradeCounts: new Map(),
      cooldownCandlesRemaining: 0,
      latestQuote: null,
      pendingOrdersProcessing: false,
      lastCandleTime: null,
      lastEntryCandleFetchAt: 0,
      lastHigherTimeframeCandleFetchAt: 0,
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
    console.log(`  🔎 Resolving broker symbol for ${pair}...`);
    try {
      await icmarkets.getSymbol(pair);
    } catch (err) {
      console.warn(`  ⚠️  ${pair} symbol lookup failed; using configured symbol ID: ${err.message}`);
    }
    console.log(`  🔄 Reconciling account state for ${pair}...`);
    await reconcileAccount(pair);
    symbolIdToPair.set(String(icmarkets._resolveSymbolId(pair)), pair);
    console.log(`  📡 Subscribing to live ticks for ${pair}...`);
    await icmarkets.subscribeTicks(pair);
  }

  icmarkets.on(SPOT_EVENT, (payload) => handleSpotEvent(payload));
  icmarkets.on(2126, (payload) => handleExecutionEvent(payload));

  console.log(`  ⏱️ Poll loop started (${config.pollIntervalSeconds}s interval).`);
  await scheduledTick();
  setInterval(() => {
    scheduledTick().catch(err => console.error(`  ❌ Poll loop error:`, err.message));
  }, config.pollIntervalSeconds * 1000);
}

async function scheduledTick() {
  if (tickInProgress) {
    console.log(`  ⏭️  Previous poll still running; skipping this interval.`);
    return;
  }

  tickInProgress = true;
  try {
    await tick();
  } finally {
    tickInProgress = false;
  }
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
  const pipSize = getPipSize(pair);
  const instrumentType = getInstrumentType(pair);

  // 1. Refresh candles only when a new closed candle can exist.
  const candleCount = Math.max(
    config.strategy.nyAsianContinuation?.lookbackCandles ?? 220,
    config.strategy.londonAsianFakeBreakReversal?.lookbackCandles ?? 220,
  );
  if (shouldRefreshClosedCandles(state.candleCache, config.granularity, now, state.lastEntryCandleFetchAt)) {
    state.lastEntryCandleFetchAt = now;
    try {
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
  }

  const htfConfig = config.strategy.higherTimeframeTrend ?? {};
  let higherTimeframe = { trend: 'neutral', ema: null, close: null, reason: 'Higher-timeframe filter disabled' };
  if (htfConfig.enabled) {
    try {
      const htfGranularity = htfConfig.granularity || config.higherTimeframe || "H1";
      const htfCandleCount = htfConfig.lookbackCandles || 250;
      if (shouldRefreshClosedCandles(state.higherTimeframeCandleCache, htfGranularity, now, state.lastHigherTimeframeCandleFetchAt)) {
        state.lastHigherTimeframeCandleFetchAt = now;
        const htfCandles = await getLiveMidCandles(
          pair,
          htfGranularity,
          htfCandleCount + 2,
        );
        const closedHtfCandles = onlyClosedCandles(htfCandles, htfGranularity, now);
        if (closedHtfCandles.length > 0) {
          state.higherTimeframeCandleCache = closedHtfCandles.slice(-htfCandleCount);
        }
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
  await processPendingOrders(pair, state, { source: "poll" });
  if (state.activeTrades.length >= config.maxTradesPerPair) return;
  if (!hasAvailableTradeSlot()) return;

  // 2. Generate signal
  const activeWindow = getActiveSessionWindowUTC(new Date());
  const signal = normalizeSignal(generateStrategySignal(pair, state, higherTimeframe, activeWindow));

  // Log status every minute
  if (now - (state.lastLogTime || 0) > 60000) {
    console.log(
      `[${timestamp}] ${pair} | Trend: ${upper(signal.trend, "neutral")} | ` +
      `HTF: ${upper(higherTimeframe.trend, "neutral")} | ` +
      `Strategy: ${signal.strategy || config.strategy.mode} | Pending: ${state.pendingOrders.length} | ` +
      `Signal: ${upper(signal.signal, "none")}`
    );
    if (signal.signal !== 'none' || config.strategy.mode === "london_asian_fake_break_reversal") console.log(`  → ${signal.reason}`);
    state.lastLogTime = now;
  }

  if (signal.signal === 'none') return;

  if (signal.monitorOnly) {
    const quote = getFreshQuote(pair, state);
    const londonCfg = config.strategy.londonAsianFakeBreakReversal ?? {};
    console.log(
      `  👀 London monitor-only signal for ${pair}: ${signal.direction || upper(signal.signal)} | ` +
      `Spread: ${quote ? `${quote.spreadPips.toFixed(1)}p` : "n/a"} | ` +
      `Brake: maxLosses/day=${londonCfg.maxLossesPerDay ?? 0}, maxDailyLossUSD=${londonCfg.maxDailyLossUSD ?? 0} | ` +
      `${signal.reason}`
    );
    return;
  }

  const londonGate = canLondonLiveTrade(signal);
  if (!londonGate.allowed) {
    console.log(`  ⛔ London module brake blocked ${pair}: ${londonGate.reason}`);
    return;
  }

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
    await armPendingStopOrder(pair, state, signal);
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

    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry, undefined, signal.convictionMultiplier ?? 1.0);
    if (units <= 0) return;

    const spreadGate = validateExecutionSpread(pair, getState(pair));
    if (!spreadGate.allowed) {
      console.log(`  ⛔ Spread gate blocked trade: ${spreadGate.reason}`);
      return;
    }

    // Use the signal's entry price for more accurate relative SL/TP if possible,
    // though icmarkets.openPosition will fetch current market price for reliability.
    const res = await icmarkets.openPosition(pair, action, units, signal.sl, signal.tp, signal.entry);
    if (res && res.positionId) {
      state.activeTrades.push({
        id: String(res.positionId),
        direction: action,
        pair,
        entry: signal.entry,
        sl: signal.sl,
        tp: signal.tp,
        strategy: signal.strategy,
        sessionKey: signal.sessionKey,
        ageBars: 0,
        timeExitBars: signal.timeExitBars,
        forceExitUTC: signal.forceExitUTC,
      });
      if (signal.sessionKey) {
        state.sessionTradeCounts.set(signal.sessionKey, (state.sessionTradeCounts.get(signal.sessionKey) ?? 0) + 1);
      }
      riskManager.onTradeOpened(String(res.positionId), pair, action, signal.entry, signal.sl, signal.tp, units);
      saveState();
    }
  } catch (err) {
    console.error(`  ❌ Trade failed:`, err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateStrategySignal(pair, state, higherTimeframe, activeWindow) {
  const mode = config.strategy.mode;
  if (mode === "combined_ny_london") {
    return generateCombinedStrategySignal(pair, state, higherTimeframe, activeWindow);
  }

  if (mode === "london_asian_fake_break_reversal") {
    return generateLondonMonitorSignal(pair, state, higherTimeframe, activeWindow);
  }

  if (mode !== "ny_asian_continuation") {
    return noSignal(`${mode} is not supported by live routing`);
  }

  return generateNYAsianContinuationSignalForPair(pair, state, higherTimeframe, activeWindow);
}

function generateCombinedStrategySignal(pair, state, higherTimeframe, activeWindow) {
  const signals = [
    generateNYAsianContinuationSignalForPair(pair, state, higherTimeframe, activeWindow),
    generateLondonMonitorSignal(pair, state, higherTimeframe, activeWindow),
  ].map(normalizeSignal);

  const actionable = signals.find(signal => signal.signal !== "none");
  if (actionable) return actionable;

  return noSignal(
    signals
      .map(signal => `${signal.strategy || "unknown"}: ${signal.reason}`)
      .join(" | ")
  );
}

function generateNYAsianContinuationSignalForPair(pair, state, higherTimeframe, activeWindow) {
  const htfConfig = config.strategy.higherTimeframeTrend ?? {};
  const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;

  const cfg = config.strategy.nyAsianContinuation ?? {};
  if (Array.isArray(cfg.allowedSessionNames) && cfg.allowedSessionNames.length > 0 && !cfg.allowedSessionNames.includes(activeWindow?.name)) {
    return noSignal(`NY Asian continuation blocked outside allowed session (${activeWindow?.name ?? "none"})`, "ny_asian_continuation");
  }

  const sessionKey = getSessionKey(new Date(), activeWindow);
  if ((state.sessionTradeCounts.get(sessionKey) ?? 0) >= (cfg.maxTradesPerSession ?? 1)) {
    return noSignal(`NY Asian continuation max trades reached for ${sessionKey}`, "ny_asian_continuation");
  }

  const signal = generateNYAsianContinuationSignal(state.candleCache, {
    ...cfg,
    asianRange: getAsianRangeFromCandles(state.candleCache, new Date(), cfg),
    higherTimeframeTrend: htfTrend,
    pair,
  });
  return signal.signal === "none" ? { ...signal, strategy: "ny_asian_continuation" } : signal;
}

function generateLondonMonitorSignal(pair, state, higherTimeframe, activeWindow) {
  const cfg = config.strategy.londonAsianFakeBreakReversal ?? {};
  if (!cfg.monitorEnabled) {
    return noSignal(`London fake-break monitor is disabled; set LONDON_MONITOR_ENABLED=true to observe signals`, "london_asian_fake_break_reversal");
  }

  if (Array.isArray(cfg.allowedPairs) && cfg.allowedPairs.length > 0 && !cfg.allowedPairs.includes(pair)) {
    return noSignal(`London fake-break blocked outside allowed pairs (${pair})`, "london_asian_fake_break_reversal");
  }

  if (Array.isArray(cfg.allowedSessionNames) && cfg.allowedSessionNames.length > 0 && !cfg.allowedSessionNames.includes(activeWindow?.name)) {
    return noSignal(`London fake-break blocked outside allowed session (${activeWindow?.name ?? "none"})`, "london_asian_fake_break_reversal");
  }

  const excludedDay = cfg.excludedPairWeekdays?.[pair];
  if (excludedDay && excludedDay === weekdayUTC(new Date())) {
    return noSignal(`London fake-break blocked by pair/day exclusion ${pair}:${excludedDay}`, "london_asian_fake_break_reversal");
  }

  const now = new Date();
  const sessionKey = getSessionKey(now, activeWindow);
  if ((state.sessionTradeCounts.get(sessionKey) ?? 0) >= (cfg.maxTradesPerSession ?? 1)) {
    return noSignal(`London fake-break max trades reached for ${sessionKey}`, "london_asian_fake_break_reversal");
  }

  const htfConfig = config.strategy.higherTimeframeTrend ?? {};
  const htfTrend = htfConfig.enabled ? higherTimeframe.trend : null;
  const signal = generateLondonAsianFakeBreakReversalSignal(state.candleCache, {
    ...cfg,
    asianRange: getAsianRangeFromCandles(state.candleCache, now, cfg),
    higherTimeframeTrend: htfTrend,
    pair,
  });

  if (signal.signal === "none") return { ...signal, strategy: "london_asian_fake_break_reversal" };
  return {
    ...signal,
    sessionKey,
    monitorOnly: !cfg.liveExecutionEnabled,
    liveExecutionEnabled: Boolean(cfg.liveExecutionEnabled),
    reason: `${signal.reason} | London monitor-only=${!cfg.liveExecutionEnabled}`,
  };
}

function noSignal(reason, strategy = null) {
  return { signal: "none", trend: "neutral", entry: null, sl: null, tp: null, riskPips: null, rewardPips: null, strategy, reason };
}

function normalizeSignal(signal) {
  const src = signal && typeof signal === "object" ? signal : {};
  const signalName = typeof src.signal === "string" && src.signal ? src.signal : "none";
  const direction = typeof src.direction === "string" ? src.direction.toUpperCase() : null;
  const trend = typeof src.trend === "string" && src.trend
    ? src.trend
    : direction === "BUY"
      ? "bull"
      : direction === "SELL"
        ? "bear"
        : "neutral";

  return {
    signal: signalName,
    trend,
    direction,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    reason: "Signal generator returned no actionable setup",
    ...src
  };
}

function upper(value, fallback = "unknown") {
  return String(value ?? fallback).toUpperCase();
}

async function getLiveMidCandles(pair, granularity, count) {
  const [bidCandles, askCandles] = await Promise.all([
    icmarkets.getCandles(pair, granularity, count, null, null, 1),
    icmarkets.getCandles(pair, granularity, count, null, null, 2),
  ]);
  return mergeBidAskCandles(bidCandles, askCandles, pair);
}

function mergeBidAskCandles(bidCandles = [], askCandles = [], pair = null) {
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
        bid: formatPriceFields(bid, pair),
        ask: formatPriceFields(ask, pair),
        mid: formatPriceFields({
          o: (bid.o + ask.o) / 2,
          h: (bid.h + ask.h) / 2,
          l: (bid.l + ask.l) / 2,
          c: (bid.c + ask.c) / 2,
        }, pair),
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

function formatPriceFields(prices, pair) {
  const d = pair ? getPriceDecimals(pair) : 5;
  return {
    o: prices.o.toFixed(d),
    h: prices.h.toFixed(d),
    l: prices.l.toFixed(d),
    c: prices.c.toFixed(d),
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

function shouldRefreshClosedCandles(cache, granularity, nowMs = Date.now(), lastFetchMs = 0) {
  const periodMs = GRANULARITY_MS[String(granularity || "").toUpperCase()] ?? GRANULARITY_MS.M5;
  const retryMs = Math.min(30_000, Math.max(10_000, Math.floor(periodMs / 4)));

  if (!Array.isArray(cache) || cache.length === 0) {
    return nowMs - (lastFetchMs || 0) >= retryMs;
  }

  const lastClosedOpenMs = new Date(cache.at(-1)?.time).getTime();
  if (!Number.isFinite(lastClosedOpenMs)) {
    return nowMs - (lastFetchMs || 0) >= retryMs;
  }

  // If the latest cached closed candle opened at T, the next closed candle is
  // not available until T + 2 periods (plus a small broker timestamp grace).
  return nowMs >= lastClosedOpenMs + (periodMs * 2) + 2_000;
}

async function armPendingStopOrder(pair, state, signal) {
  if (config.execution?.useBrokerStopOrders !== false) {
    const armed = await armBrokerStopOrder(pair, state, signal);
    if (armed || !config.execution?.fallbackToLocalStops) return;
    console.warn(`  ⚠️  Falling back to local ${signal.direction} stop simulation for ${pair}.`);
  }

  if (!addPendingOrder(state, signal)) return;
  saveState();
  await processPendingOrders(pair, state, { source: "poll" });
}

async function armBrokerStopOrder(pair, state, signal) {
  if (!hasAvailableTradeSlot()) {
    console.log(`  ⛔ Broker ${signal.direction} stop not placed: active + pending = ${getReservedTradeSlotCount()}/${getMaxTotalTrades()}`);
    return true;
  }

  try {
    const gate = riskManager.canTrade();
    if (!gate.allowed) {
      console.log(`  ⛔ Risk gate blocked broker stop: ${gate.reason}`);
      return true;
    }

    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry, undefined, signal.convictionMultiplier ?? 1.0);
    if (units <= 0) return true;

    const pendingOrder = buildPendingOrder(state, signal, {
      brokerManaged: true,
      units,
      clientOrderId: makeClientOrderId(pair, signal.direction),
    });

    const res = await icmarkets.placeStopOrder({
      pair,
      direction: signal.direction,
      units,
      entry: signal.entry,
      stopLoss: signal.sl,
      takeProfit: signal.tp,
      expiresAtMs: pendingOrder.expiresAtMs,
      clientOrderId: pendingOrder.clientOrderId,
      comment: `${signal.strategy ?? "ny_asian"} ${signal.levelName ?? "range"}`,
    });

    if (res.positionId) {
      adoptFilledPendingOrder(pair, state, { ...pendingOrder, brokerOrderId: res.orderId }, res.positionId, res.price);
      console.log(`  ✅ Broker ${signal.direction} stop filled immediately @ ${signal.entry}.`);
      return true;
    }

    if (!res.orderId) throw new Error("broker did not return orderId for accepted stop order");
    pendingOrder.brokerOrderId = String(res.orderId);
    state.pendingOrders.push(pendingOrder);
    saveState();
    console.log(`  📌 Broker ${signal.direction} stop placed @ ${signal.entry} (order ${pendingOrder.brokerOrderId}, expires ${new Date(pendingOrder.expiresAtMs).toISOString()}).`);
    return true;
  } catch (err) {
    console.error(`  ❌ Broker stop placement failed for ${pair}:`, err.message);
    return false;
  }
}

function addPendingOrder(state, signal) {
  if (!hasAvailableTradeSlot()) {
    console.log(`  ⛔ Pending ${signal.direction} stop not armed: active + pending = ${getReservedTradeSlotCount()}/${getMaxTotalTrades()}`);
    return false;
  }

  state.pendingOrders.push(buildPendingOrder(state, signal, { brokerManaged: false }));
  console.log(`  📌 Local pending ${signal.direction} stop armed @ ${signal.entry} (expires in ${signal.pendingExpiryBars ?? 3} M5 bars).`);
  return true;
}

function buildPendingOrder(state, signal, extras = {}) {
  const latest = state.candleCache.at(-1);
  const setupMs = latest?.time ? new Date(latest.time).getTime() : Date.now();
  const expiresAfterBars = signal.pendingExpiryBars ?? 3;
  const activeWindow = getActiveSessionWindowUTC(new Date());
  const sessionKey = getSessionKey(new Date(), activeWindow);

  return {
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
    ...extras,
  };
}

async function processPendingOrders(pair, state, { source = "poll" } = {}) {
  if (!AUTO_EXECUTE || state.pendingOrders.length === 0) return;
  if (state.pendingOrdersProcessing) return;

  state.pendingOrdersProcessing = true;
  try {
    const trigger = getPendingTriggerSnapshot(pair, state, source);
    const latest = trigger?.candle ?? normalizeLiveCandle(state.candleCache.at(-1));
    const latestTime = state.candleCache.at(-1)?.time;

    const kept = [];
    for (const order of state.pendingOrders) {
      const nowMs = order.brokerManaged ? Date.now() : (trigger?.timeMs ?? latest?.date?.getTime() ?? Date.now());
      if (nowMs > order.expiresAtMs) {
        const removed = await expirePendingOrder(pair, order);
        if (!removed) kept.push(order);
        continue;
      }

      if (order.brokerManaged) {
        kept.push(order);
        continue;
      }

      if (!trigger && !latest) {
        kept.push(order);
        continue;
      }

      if (source !== "quote" && latestTime && order.setupCandleTime && latestTime === order.setupCandleTime) {
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

      const triggered = isPendingOrderTriggered(order, trigger, latest);
      if (!triggered) {
        kept.push(order);
        continue;
      }

      const result = await executeOrderSignal(pair, state, order);
      if (!result.opened && result.keep) kept.push(order);
    }

    state.pendingOrders = kept;
  } finally {
    state.pendingOrdersProcessing = false;
  }
}

async function expirePendingOrder(pair, order) {
  if (order.brokerManaged && order.brokerOrderId) {
    try {
      await icmarkets.cancelOrder(order.brokerOrderId);
      console.log(`  ⌛ Broker ${order.direction} stop expired/cancelled @ ${order.entry} (order ${order.brokerOrderId}).`);
      return true;
    } catch (err) {
      console.error(`  ⚠️  Failed to cancel expired broker stop ${order.brokerOrderId} for ${pair}: ${err.message}`);
      return false;
    }
  }

  console.log(`  ⌛ Local pending ${order.direction} stop expired @ ${order.entry}`);
  return true;
}

async function executeOrderSignal(pair, state, signal) {
  try {
    const londonGate = canLondonLiveTrade(signal);
    if (!londonGate.allowed) {
      console.log(`  ⛔ London module brake blocked pending ${signal.direction}: ${londonGate.reason}`);
      return { opened: false, keep: false };
    }

    const gate = riskManager.canTrade();
    if (!gate.allowed) {
      console.log(`  ⛔ Risk gate blocked pending ${signal.direction}: ${gate.reason}`);
      return { opened: false, keep: false };
    }

    const spreadGate = validateExecutionSpread(pair, state);
    if (!spreadGate.allowed) {
      console.log(`  ⛔ Spread gate blocked pending ${signal.direction}: ${spreadGate.reason}`);
      return { opened: false, keep: true };
    }

    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry, undefined, signal.convictionMultiplier ?? 1.0);
    if (units <= 0) return { opened: false, keep: false };

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
      return { opened: true, keep: false };
    }
  } catch (err) {
    console.error(`  ❌ Pending order execution failed:`, err.message);
    return { opened: false, keep: true };
  }

  return { opened: false, keep: true };
}

function adoptFilledPendingOrder(pair, state, order, positionId, fillPrice = null) {
  const id = String(positionId);
  if (state.activeTrades.some(trade => trade.id === id)) return;

  state.activeTrades.push({
    id,
    direction: order.direction,
    pair,
    entry: Number.isFinite(Number(fillPrice)) && Number(fillPrice) > 0 ? Number(fillPrice) : order.entry,
    plannedEntry: order.entry,
    sl: order.sl,
    tp: order.tp,
    strategy: order.strategy,
    sessionKey: order.sessionKey,
    ageBars: 0,
    timeExitBars: order.timeExitBars,
    forceExitUTC: order.forceExitUTC,
    brokerOrderId: order.brokerOrderId,
    clientOrderId: order.clientOrderId,
  });

  state.pendingOrders = state.pendingOrders.filter(pending => {
    if (order.brokerOrderId && pending.brokerOrderId === order.brokerOrderId) return false;
    if (order.clientOrderId && pending.clientOrderId === order.clientOrderId) return false;
    return pending !== order;
  });

  if (order.sessionKey) {
    state.sessionTradeCounts.set(order.sessionKey, (state.sessionTradeCounts.get(order.sessionKey) ?? 0) + 1);
  }
  riskManager.onTradeOpened(id, pair, order.direction, order.entry, order.sl, order.tp, order.units ?? 0);
  saveState();
}

function makeClientOrderId(pair, direction) {
  const compactPair = String(pair).replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase();
  const compactDirection = direction === "BUY" ? "B" : "S";
  return `kb${Date.now().toString(36)}${compactPair}${compactDirection}`.slice(0, 50);
}

function getPendingTriggerSnapshot(pair, state, source = "poll") {
  const quote = getFreshQuote(pair, state);
  if (quote) {
    return {
      source: "quote",
      bid: quote.bid,
      ask: quote.ask,
      spreadPips: quote.spreadPips,
      timeMs: quote.timeMs,
      candle: null,
    };
  }

  if (source === "quote") return null;

  const candle = normalizeLiveCandle(state.candleCache.at(-1));
  if (!candle) return null;
  return { source: "candle", candle, timeMs: candle.date.getTime() };
}

function isPendingOrderTriggered(order, trigger, latest) {
  if (trigger?.source === "quote") {
    return order.direction === "BUY" ? trigger.ask >= order.entry : trigger.bid <= order.entry;
  }

  if (!latest) return false;
  return order.direction === "BUY" ? latest.high >= order.entry : latest.low <= order.entry;
}

function validateExecutionSpread(pair, state) {
  const quote = getFreshQuote(pair, state);
  if (!quote) return { allowed: false, reason: `no fresh ${pair} bid/ask quote available` };

  const maxSpreadPips = Number(config.execution?.maxSpreadPips ?? Infinity);
  if (Number.isFinite(maxSpreadPips) && quote.spreadPips > maxSpreadPips) {
    return { allowed: false, reason: `spread ${quote.spreadPips.toFixed(1)}p > max ${maxSpreadPips}p` };
  }

  return { allowed: true, reason: "OK" };
}

function getFreshQuote(pair, state) {
  const quote = state?.latestQuote;
  if (!quote || quote.pair !== pair) return null;

  const maxAgeMs = Number(config.execution?.maxQuoteAgeMs ?? 5_000);
  if (Number.isFinite(maxAgeMs) && Date.now() - quote.timeMs > maxAgeMs) return null;
  if (![quote.bid, quote.ask, quote.spreadPips].every(Number.isFinite) || quote.bid <= 0 || quote.ask <= 0 || quote.ask < quote.bid) return null;

  return quote;
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

function handleSpotEvent(payload) {
  const pair = symbolIdToPair.get(String(payload?.symbolId));
  if (!pair) return;

  const state = getState(pair);
  const previous = state.latestQuote ?? {};
  // Spot events from cTrader are always int64 scaled by 100000
  const bid = payload.bid != null ? Number(payload.bid) / 100000 : null;
  const ask = payload.ask != null ? Number(payload.ask) / 100000 : null;
  const bidVal = Number.isFinite(bid) && bid > 0 ? bid : previous.bid;
  const askVal = Number.isFinite(ask) && ask > 0 ? ask : previous.ask;
  if (!Number.isFinite(bidVal) || !Number.isFinite(askVal) || bidVal <= 0 || askVal <= 0 || askVal < bidVal) return;

  const pipSize = getPipSize(pair);
  state.latestQuote = {
    pair,
    bid: bidVal,
    ask: askVal,
    mid: (bidVal + askVal) / 2,
    spreadPips: (askVal - bidVal) / pipSize,
    timeMs: Date.now(),
  };

  if (!AUTO_EXECUTE || state.pendingOrders.length === 0 || !isTradingWindowOpenNow()) return;
  processPendingOrders(pair, state, { source: "quote" })
    .catch(err => console.error(`  ❌ ${pair} live pending trigger error:`, err.message));
}

function normalizeSpotPrice(value, pair) {
  if (value === undefined || value === null) return null;
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) return null;

  // If the price is a small decimal, return as-is.
  if (price < 100) return price;

  // High-value instruments (Gold, Indices, Crypto) come as doubles — don't scale.
  if (pair) {
    const type = getInstrumentType(pair);
    if (type === "metal" || type === "index" || type === "crypto") return price;
  }

  // FX pairs: if > 1000, it's cTrader's int64 × 100000.
  return price > 1000 ? price / 100000 : price;
}

function isTradingWindowOpenNow(now = new Date()) {
  const day = now.getUTCDay();
  return day !== 0 && day !== 6 && Boolean(getActiveSessionWindowUTC(now));
}

function handleExecutionEvent(payload) {
  handleBrokerPendingOrderEvent(payload);

  if (["ORDER_FILLED", "DEAL_FILLED", 3, 4].includes(payload.executionType)) {
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
        if (matchedTrade?.strategy === "london_asian_fake_break_reversal") {
          updateLondonModuleRisk(pnlKES);
        }
      }
      riskManager.syncOpenTradeCount(getOpenTradeCount());

      if (matchedTrade && config.strategy.cooldownCandlesAfterLoss > 0) {
        const matchedPair = matchedTrade.pair;
        let exitPrice = Number(deal.executionPrice ?? 0);
        // Scale only if it looks like cTrader int64 and not a high-value instrument
        if (exitPrice > 1000 && matchedPair) {
          const type = getInstrumentType(matchedPair);
          if (type === "forex") exitPrice = exitPrice / 100000;
        }
        const pipSize = getPipSize(matchedPair || "EUR_USD");
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

function handleBrokerPendingOrderEvent(payload) {
  const executionType = payload?.executionType;
  const order = payload?.order;
  const orderId = order?.orderId ? String(order.orderId) : null;
  const clientOrderId = order?.clientOrderId ?? null;
  if (!orderId && !clientOrderId) return;

  const match = findPendingOrder(orderId, clientOrderId);
  if (!match) return;

  const { pair, state, pendingOrder } = match;
  if (executionType === "ORDER_FILLED" || executionType === 3) {
    const positionId = payload.position?.positionId ?? payload.deal?.positionId;
    if (!positionId) return;
    let fillPrice = Number(payload.deal?.executionPrice ?? order.executionPrice ?? payload.position?.price ?? 0);
    if (fillPrice > 1000 && getInstrumentType(pair) === "forex") fillPrice = fillPrice / 100000;
    adoptFilledPendingOrder(pair, state, pendingOrder, String(positionId), fillPrice);
    console.log(`  ✅ Broker ${pendingOrder.direction} stop filled for ${pair} @ ${Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : pendingOrder.entry}.`);
    return;
  }

  if (["ORDER_CANCELLED", "ORDER_EXPIRED", "ORDER_REJECTED", 5, 6, 7].includes(executionType)) {
    state.pendingOrders = state.pendingOrders.filter(order => order !== pendingOrder);
    saveState();
    console.log(`  ℹ️  Broker pending ${pendingOrder.direction} stop ${executionType} for ${pair} (order ${pendingOrder.brokerOrderId ?? orderId}).`);
  }
}

function findPendingOrder(orderId, clientOrderId) {
  for (const [pair, state] of pairState) {
    const pendingOrder = state.pendingOrders.find(order => {
      if (orderId && order.brokerOrderId && String(order.brokerOrderId) === String(orderId)) return true;
      if (clientOrderId && order.clientOrderId && order.clientOrderId === clientOrderId) return true;
      return false;
    });
    if (pendingOrder) return { pair, state, pendingOrder };
  }
  return null;
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
    const accountState = await icmarkets.reconcile();
    const positions = accountState.positions ?? [];
    const orders = accountState.orders ?? [];
    const symbolId = icmarkets._resolveSymbolId(pair);
    state.activeTrades = positions
      .filter(p => p.tradeData && String(p.tradeData.symbolId) === String(symbolId))
      .map(p => {
        const id = String(p.positionId);
        const saved = savedActiveTradesById.get(id) ?? {};
        return {
          ...saved,
          id,
          direction: saved.direction ?? p.tradeData.tradeSide,
          pair,
          brokerReconciled: true,
        };
      });
    state.pendingOrders = orders
      .filter(order => order.tradeData && String(order.tradeData.symbolId) === String(symbolId))
      .filter(order => ["ORDER_STATUS_ACCEPTED", 1].includes(order.orderStatus))
      .map(order => {
        const orderId = String(order.orderId);
        const saved = savedPendingOrdersById.get(orderId) ?? {};
        return {
          ...saved,
          brokerManaged: true,
          brokerReconciled: true,
          brokerOrderId: orderId,
          clientOrderId: saved.clientOrderId ?? order.clientOrderId,
          direction: saved.direction ?? order.tradeData.tradeSide,
          pair,
          entry: saved.entry ?? order.stopPrice,
          sl: saved.sl ?? order.stopLoss,
          tp: saved.tp ?? order.takeProfit,
          units: saved.units ?? Math.floor((Number(order.tradeData.volume) || 0) / 100),
          expiresAtMs: saved.expiresAtMs ?? Number(order.expirationTimestamp ?? 0),
        };
      })
      .filter(order => order.direction && Number.isFinite(Number(order.entry)) && Number.isFinite(Number(order.expiresAtMs)));
    if (state.activeTrades.length > 0) {
      console.log(`  ✅ Adopted ${state.activeTrades.length} open ${pair} position(s) from broker reconciliation.`);
    }
    if (state.pendingOrders.length > 0) {
      console.log(`  ✅ Adopted ${state.pendingOrders.length} pending ${pair} broker stop order(s) from reconciliation.`);
    }
    riskManager.syncOpenTradeCount(getOpenTradeCount());
    saveState();
  } catch (err) {
    console.error(`  ⚠️  ${pair} reconciliation failed: ${err.message}`);
  }
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
  const pendingOrders = [];
  for (const [, state] of pairState) {
    allTrades.push(...state.activeTrades);
    pendingOrders.push(...state.pendingOrders);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ savedAtUTC: new Date().toISOString(), activeTrades: allTrades, pendingOrders, londonModuleRisk }, null, 2));
}

function loadSavedActiveTradesById() {
  if (!fs.existsSync(STATE_FILE)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const trades = Array.isArray(data.activeTrades) ? data.activeTrades : [];
    const byId = new Map(trades.filter(t => t?.id).map(t => [String(t.id), t]));
    if (byId.size > 0) console.log(`  📂 Loaded ${byId.size} saved active trade metadata record(s).`);
    return byId;
  } catch (err) {
    console.error(`  ⚠️  Failed to load ${STATE_FILE}: ${err.message}`);
    return new Map();
  }
}

function loadSavedPendingOrdersById() {
  if (!fs.existsSync(STATE_FILE)) return new Map();
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const orders = Array.isArray(data.pendingOrders) ? data.pendingOrders : [];
    const byId = new Map(orders.filter(order => order?.brokerOrderId).map(order => [String(order.brokerOrderId), order]));
    if (byId.size > 0) console.log(`  📂 Loaded ${byId.size} saved pending broker order metadata record(s).`);
    return byId;
  } catch (err) {
    console.error(`  ⚠️  Failed to load pending orders from ${STATE_FILE}: ${err.message}`);
    return new Map();
  }
}

function loadSavedLondonModuleRisk() {
  const fallback = {
    currentDayUTC: new Date().toISOString().slice(0, 10),
    dailyLosses: 0,
    dailyLossUSD: 0,
  };
  if (!fs.existsSync(STATE_FILE)) return fallback;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const saved = data.londonModuleRisk;
    if (!saved || typeof saved !== "object") return fallback;
    if (saved.currentDayUTC !== fallback.currentDayUTC) return fallback;
    return {
      currentDayUTC: saved.currentDayUTC,
      dailyLosses: Number(saved.dailyLosses) || 0,
      dailyLossUSD: Number(saved.dailyLossUSD) || 0,
    };
  } catch (err) {
    console.error(`  ⚠️  Failed to load London module risk from ${STATE_FILE}: ${err.message}`);
    return fallback;
  }
}

function resetLondonModuleRiskIfNeeded(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (londonModuleRisk.currentDayUTC === day) return;
  londonModuleRisk.currentDayUTC = day;
  londonModuleRisk.dailyLosses = 0;
  londonModuleRisk.dailyLossUSD = 0;
  saveState();
}

function canLondonLiveTrade(signal, now = new Date()) {
  if (signal?.strategy !== "london_asian_fake_break_reversal") return { allowed: true, reason: "OK" };
  resetLondonModuleRiskIfNeeded(now);

  const cfg = config.strategy.londonAsianFakeBreakReversal ?? {};
  const maxLosses = Number(cfg.maxLossesPerDay ?? 0);
  if (Number.isFinite(maxLosses) && maxLosses > 0 && londonModuleRisk.dailyLosses >= maxLosses) {
    return {
      allowed: false,
      reason: `max London losses/day reached: ${londonModuleRisk.dailyLosses}/${maxLosses}`,
    };
  }

  const maxDailyLossUSD = Number(cfg.maxDailyLossUSD ?? 0);
  if (Number.isFinite(maxDailyLossUSD) && maxDailyLossUSD > 0 && londonModuleRisk.dailyLossUSD >= maxDailyLossUSD) {
    return {
      allowed: false,
      reason: `max London daily loss reached: $${londonModuleRisk.dailyLossUSD.toFixed(2)}/$${maxDailyLossUSD.toFixed(2)}`,
    };
  }

  return { allowed: true, reason: "OK" };
}

function updateLondonModuleRisk(pnlKES, now = new Date()) {
  resetLondonModuleRiskIfNeeded(now);
  const pnlUSD = pnlKES / (config.risk.usdKesRate ?? 129.0);
  if (pnlUSD <= 0) {
    londonModuleRisk.dailyLosses += 1;
    londonModuleRisk.dailyLossUSD += Math.abs(pnlUSD);
    console.log(`  🛑 London module risk: loss ${londonModuleRisk.dailyLosses}, daily loss $${londonModuleRisk.dailyLossUSD.toFixed(2)}`);
  }
  saveState();
}

function getSessionKey(dateObj, activeWindow) {
  return `${dateObj.toISOString().slice(0, 10)}:${activeWindow?.name ?? "unknown"}`;
}

function weekdayUTC(dateObj) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dateObj.getUTCDay()];
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
