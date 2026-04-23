/**
 * Backtest Runner — 5-10-20 EMA Scalping Strategy (Multi-Pair)
 */

import fs from "fs";
import { generateSignal } from "./indicators.js";
import { config } from "./config.js";

const INITIAL_BALANCE = 385; 
const COMMISSION_SIDE_USD = 3.00;
const SPREAD_PIPS = 0.5; 
const SLIPPAGE_PIPS = 0.2;

let balance = INITIAL_BALANCE;
const pairData = {};
const PAIRS = config.tradingPairs;

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  🤖  5-10-20 EMA SCALPING BACKTESTER (MULTI-PAIR)`);
  console.log(`  Pairs    : ${PAIRS.join(", ")}`);
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
        isJPY: pair.includes("JPY"),
        pipSize: pair.includes("JPY") ? 0.01 : 0.0001,
        activeTrades: [],
        tradeHistory: [],
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
      
      const midOpen = parseFloat(nextCandle.mid.o);
      const midHigh = parseFloat(nextCandle.mid.h);
      const midLow  = parseFloat(nextCandle.mid.l);

      const spread = SPREAD_PIPS * p.pipSize;
      const bidLow  = midLow - spread/2;
      const bidHigh = midHigh - spread/2;
      const askHigh = midHigh + spread/2;
      const askLow  = midLow + spread/2;

      // Manage trades
      p.activeTrades = p.activeTrades.filter(trade => {
        if (trade.direction === "BUY") {
          if (bidLow <= trade.sl) { closeTrade(pair, trade, trade.sl, "SL", timestamp); return false; }
          if (bidHigh >= trade.tp) { closeTrade(pair, trade, trade.tp, "TP", timestamp); return false; }
        } else {
          if (askHigh >= trade.sl) { closeTrade(pair, trade, trade.sl, "SL", timestamp); return false; }
          if (askLow <= trade.tp) { closeTrade(pair, trade, trade.tp, "TP", timestamp); return false; }
        }
        return true;
      });

      // Session Hours (supports multi-window UTC, incl. half-hours)
      const dateObj = new Date(timestamp);
      if (dateObj.getUTCDay() === 0 || dateObj.getUTCDay() === 6 || !isTradeWindowUTC(dateObj)) continue;

      // Signal Generation
      const signal = generateSignal(currentM5Candles, {
        pipBuffer: config.strategy.pipBuffer,
        rrRatio:   config.strategy.rrRatio,
        isJPY:     p.isJPY,
      });

      if (signal.signal === 'none' || p.activeTrades.length >= config.maxTradesPerPair) continue;

      handleSignal(pair, signal, midOpen, timestamp);
    }
  }

  function handleSignal(pair, signal, price, time) {
    const p = pairData[pair];
    const action = signal.signal.toUpperCase();
    const units = Math.min(10000, Math.floor((INITIAL_BALANCE * 0.02) / (signal.riskPips * (10/100000))));

    p.activeTrades.push({
      direction: action,
      entry: signal.entry,
      sl: signal.sl,
      tp: signal.tp,
      units,
      time,
      pair,
      reason: signal.reason,
    });
  }

  function closeTrade(pair, trade, exitPrice, reason, exitTime) {
    const p = pairData[pair];
    const diff = trade.direction === "BUY" ? (exitPrice - trade.entry) : (trade.entry - exitPrice);
    const pips = diff / p.pipSize;
    const profit = (pips * (10/100000)) * trade.units;
    balance += profit;
    p.tradeHistory.push({ ...trade, exit: exitPrice, exitTime, reason, profit, balance });
    console.log(`  ✅ [${exitTime}] ${pair} ${reason} | Net: $${profit.toFixed(2)} | Bal: $${balance.toFixed(2)}`);
  }

  const allHistory = Object.values(pairData).flatMap(p => p.tradeHistory);
  const wins = allHistory.filter(t => t.profit > 0);

  const finalStats = {
    type: "backtest",
    pairs: PAIRS,
    trades: allHistory,
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
