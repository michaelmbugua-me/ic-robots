#!/usr/bin/env node

/**
 * 5-10-20 EMA Scalping Strategy
 * M5 Execution on EURUSD — IC Markets cTrader
 */

import fs from "fs";
import { ICMarketsClient } from "./icmarkets.js";
import { config } from "./config.js";
import { generateSignal } from "./indicators.js";
import { RiskManager } from "./risk-manager.js";

const STATE_FILE = "state.json";
const AUTO_EXECUTE = process.argv.includes("--auto-execute");
const PAIRS = config.tradingPairs;

const icmarkets = new ICMarketsClient();
const riskManager = new RiskManager(config);
const pairState = new Map();

function getState(pair) {
  if (!pairState.has(pair)) {
    pairState.set(pair, {
      candleCache: [],
      activeTrades: [],
      lastLogTime: 0,
      needsRefresh: true
    });
  }
  return pairState.get(pair);
}

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  📊 5-10-20 EMA SCALPING BOT — EURUSD M5`);
  console.log(`  Mode: ${AUTO_EXECUTE ? "🚀 AUTO-EXECUTE" : "💡 MONITOR ONLY"}`);
  console.log(`${"═".repeat(60)}\n`);

  await icmarkets.connect();
  await icmarkets.authenticate();

  loadState();

  for (const pair of PAIRS) {
    await reconcileAccount(pair);
    await icmarkets.subscribeTicks(pair);
  }

  icmarkets.on(2126, (payload) => handleExecutionEvent(payload));

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

  // 1. Fetch candles (rolling 100-candle window)
  if (state.needsRefresh || state.candleCache.length < 30) {
    state.candleCache = await icmarkets.getCandles(pair, config.granularity, 100);
    state.needsRefresh = false;
  }

  if (state.candleCache.length < 22) return;

  // 2. Generate signal
  const signal = generateSignal(state.candleCache, {
    pipBuffer: config.strategy.pipBuffer,
    rrRatio:   config.strategy.rrRatio,
    isJPY,
  });

  // Log status every minute
  if (now - (state.lastLogTime || 0) > 60000) {
    console.log(
      `[${timestamp}] ${pair} | Trend: ${signal.trend.toUpperCase()} | ` +
      `EMA5: ${signal.ema5} EMA10: ${signal.ema10} EMA20: ${signal.ema20} | ` +
      `Signal: ${signal.signal.toUpperCase()}`
    );
    if (signal.signal !== 'none') console.log(`  → ${signal.reason}`);
    state.lastLogTime = now;
  }

  if (signal.signal === 'none') return;

  // 3. Trade gate
  if (state.activeTrades.length >= config.maxTradesPerPair) return;

  const action = signal.signal.toUpperCase(); // 'BUY' | 'SELL'

  console.log(
    `\n⚡ [${timestamp}] ${pair} ${action} | ` +
    `Entry: ${signal.entry} SL: ${signal.sl} TP: ${signal.tp} | ` +
    `Risk: ${signal.riskPips}p Reward: ${signal.rewardPips}p`
  );

  if (!AUTO_EXECUTE) return;

  try {
    const units = riskManager.calculateVolume(pair, signal.riskPips, signal.entry);
    if (units <= 0) return;

    const res = await icmarkets.openPosition(pair, action, units, signal.sl, signal.tp);
    if (res && res.positionId) {
      state.activeTrades.push({ id: String(res.positionId), direction: action, pair, entry: signal.entry });
      saveState();
    }
  } catch (err) {
    console.error(`  ❌ Trade failed:`, err.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function handleExecutionEvent(payload) {
  if (payload.executionType === "DEAL_FILLED" || payload.executionType === 4) {
    const deal = payload.deal;
    if (deal && deal.closePositionDetail) {
      const positionId = String(deal.positionId);
      console.log(`  🔔  Position ${positionId} closed.`);
      for (const [, state] of pairState) {
        state.activeTrades = state.activeTrades.filter(t => t.id !== positionId);
      }
      saveState();
    }
  }
}

async function reconcileAccount(pair) {
  const state = getState(pair);
  try {
    const positions = await icmarkets.reconcile();
    const symbolId = icmarkets._resolveSymbolId(pair);
    state.activeTrades = positions
      .filter(p => p.tradeData && String(p.tradeData.symbolId) === String(symbolId))
      .map(p => ({ id: String(p.positionId), direction: p.tradeData.tradeSide, pair }));
    saveState();
  } catch (err) {}
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (data.activeTrades) {
        // Migration: flat activeTrades array — no per-pair state needed
      }
    } catch (err) {}
  }
}

function saveState() {
  const allTrades = [];
  for (const [, state] of pairState) allTrades.push(...state.activeTrades);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ activeTrades: allTrades }, null, 2));
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
