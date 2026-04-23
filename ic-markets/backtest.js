/**
 * Single-Pair Backtest Runner — 5-10-20 EMA Scalping Strategy
 */

import fs from "fs";
import { generateSignal } from "./indicators.js";
import { config } from "./config.js";

const PAIR = config.defaultInstrument || "EUR_USD";
const HISTORY_FILE = `history_${PAIR.replace("/", "_")}.json`;
const INITIAL_BALANCE = 385;
const PIP_SIZE = PAIR.includes("JPY") ? 0.01 : 0.0001;
const SPREAD = 0.5 * PIP_SIZE;

async function main() {
  if (!fs.existsSync(HISTORY_FILE)) {
    console.error(`❌ History file not found: ${HISTORY_FILE}`);
    process.exit(1);
  }

  let allCandles = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  allCandles = allCandles.map(c => {
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

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  5-10-20 EMA SCALPING BACKTESTER (SINGLE)`);
  console.log(`  Pair      : ${PAIR}`);
  console.log(`${"═".repeat(60)}\n`);

  let balance = INITIAL_BALANCE;
  let activeTrades = [];
  let tradeHistory = [];
  let cooldownCandlesRemaining = 0;
  const windowM5 = 100;

  for (let i = windowM5; i < allCandles.length; i++) {
    const currentM5Candles = allCandles.slice(i - windowM5, i);
    const nextCandle = allCandles[i];
    const timestamp = nextCandle.time;


    // Manage Trades
    activeTrades = activeTrades.filter(trade => {
      const bidLow = parseFloat(nextCandle.mid.l) - SPREAD/2;
      const bidHigh = parseFloat(nextCandle.mid.h) - SPREAD/2;
      const askHigh = parseFloat(nextCandle.mid.h) + SPREAD/2;
      const askLow = parseFloat(nextCandle.mid.l) + SPREAD/2;

      if (trade.direction === "BUY") {
        if (bidLow <= trade.sl) { closeTrade(trade, trade.sl, "SL", timestamp); return false; }
        if (bidHigh >= trade.tp) { closeTrade(trade, trade.tp, "TP", timestamp); return false; }
      } else {
        if (askHigh >= trade.sl) { closeTrade(trade, trade.sl, "SL", timestamp); return false; }
        if (askLow <= trade.tp) { closeTrade(trade, trade.tp, "TP", timestamp); return false; }
      }
      return true;
    });

    // Session Hours (supports multi-window UTC, incl. half-hours)
    const dateObj = new Date(timestamp);
    if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6 || !isTradeWindowUTC(dateObj)) continue;

    if (cooldownCandlesRemaining > 0) {
      cooldownCandlesRemaining -= 1;
      continue;
    }

    // Signal Generation
    const signal = generateSignal(currentM5Candles, {
      pipBuffer: config.strategy.pipBuffer,
      rrRatio:   config.strategy.rrRatio,
      minRiskPips: config.strategy.minRiskPips,
      maxRiskPips: config.strategy.maxRiskPips,
      emaSeparationMinPips: config.strategy.emaSeparationMinPips,
      isJPY:     PAIR.includes("JPY"),
    });

    if (signal.signal === 'none' || activeTrades.length >= config.maxTradesPerPair) continue;

    const action = signal.signal.toUpperCase();
    const units = Math.min(10000, Math.floor((INITIAL_BALANCE * 0.02) / (signal.riskPips * (10/100000))));

    const trade = {
      direction: action,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      units,
      id: `T${tradeHistory.length + 1}`,
      pair: PAIR,
      reason: signal.reason,
    };
    activeTrades.push(trade);
  }

  function closeTrade(trade, exitPrice, reason, time) {
    const diff = trade.direction === "BUY" ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
    const pips = diff / PIP_SIZE;
    const profit = (pips * (10/100000)) * trade.units;
    balance += profit;
    if (reason === "SL" && config.strategy.cooldownCandlesAfterLoss > 0) {
      cooldownCandlesRemaining = Math.max(cooldownCandlesRemaining, config.strategy.cooldownCandlesAfterLoss);
    }
    tradeHistory.push({ ...trade, profit, reason, time, exitTime: time, exit: exitPrice, balance });
    console.log(`  ✅ [${time}] ${reason} at ${exitPrice.toFixed(5)} | Net: $${profit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  const wins = tradeHistory.filter(t => t.profit > 0);
  const finalStats = {
    type: "backtest",
    generatedAtUTC: new Date().toISOString(),
    pair: PAIR,
    profile: {
      sessionWindowMode: config.sessionWindowMode,
      sessionWindowsUTC: config.sessionWindowsUTC,
      emaSeparationMinPips: config.strategy.emaSeparationMinPips,
      cooldownCandlesAfterLoss: config.strategy.cooldownCandlesAfterLoss,
      minRiskPips: config.strategy.minRiskPips,
      maxRiskPips: config.strategy.maxRiskPips,
    },
    trades: tradeHistory,
    summary: {
      total: tradeHistory.length,
      wins: wins.length,
      losses: tradeHistory.length - wins.length,
      winRate: tradeHistory.length > 0 ? ((wins.length / tradeHistory.length) * 100).toFixed(1) : 0,
      netProfit: balance - INITIAL_BALANCE,
      finalBalance: balance,
    }
  };

  fs.writeFileSync("trades_backtest.json", JSON.stringify(finalStats, null, 2));

  console.log(`\n  📊 FINAL: $${balance.toFixed(2)} | Trades: ${tradeHistory.length} | Win Rate: ${finalStats.summary.winRate}%`);
  console.log(`  💾 Data saved to trades_backtest.json\n`);
}

function isTradeWindowUTC(dateObj) {
  const windows = config.sessionWindowsUTC;
  const h = dateObj.getUTCHours() + (dateObj.getUTCMinutes() / 60);

  if (Array.isArray(windows) && windows.length > 0) {
    return windows.some(w => h >= w.start && h < w.end);
  }

  return h >= config.sessionStartUTC && h < config.sessionEndUTC;
}

main().catch(console.error);
