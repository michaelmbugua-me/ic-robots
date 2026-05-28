#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const OUTPUT_DIR = "analysis";
const COST_PROFILE = {
  BACKTEST_SPREAD_PIPS: process.env.BACKTEST_SPREAD_PIPS ?? "0.7",
  BACKTEST_SLIPPAGE_PIPS: process.env.BACKTEST_SLIPPAGE_PIPS ?? "0.3",
};

const CASES = [
  {
    key: "ny_current",
    label: "NY Asian current basket",
    env: {
      TRADING_PAIRS: "EUR_USD,GBP_USD,USD_JPY",
      STRATEGY_MODE: "ny_asian_continuation",
      SESSION_WINDOW_MODE: "all_windows",
    },
  },
  {
    key: "london_usdjpy",
    label: "London Candidate B USD_JPY",
    env: {
      TRADING_PAIRS: "USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    },
  },
  {
    key: "london_usdjpy_max_1_loss",
    label: "London Candidate B USD_JPY max 1 loss/day",
    env: {
      TRADING_PAIRS: "USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
      LONDON_MAX_LOSSES_PER_DAY: "1",
    },
  },
  {
    key: "london_usdjpy_cleaned",
    label: "London Candidate B USD_JPY cleaned 07-09 max 1 loss/day",
    env: {
      TRADING_PAIRS: "USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
      LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
      LONDON_MAX_LOSSES_PER_DAY: "1",
    },
  },
  {
    key: "london_eurusd_usdjpy",
    label: "London Candidate B EUR_USD+USD_JPY",
    env: {
      TRADING_PAIRS: "EUR_USD,USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    },
  },
  {
    key: "london_eurusd_usdjpy_cleaned",
    label: "London Candidate B EUR_USD+USD_JPY cleaned 07-09 max 1 loss/day",
    env: {
      TRADING_PAIRS: "EUR_USD,USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
      LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
      LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS: "EUR_USD:Thu",
      LONDON_MAX_LOSSES_PER_DAY: "1",
    },
  },
  {
    key: "london_eurusd_usdjpy_max_1_loss",
    label: "London Candidate B EUR_USD+USD_JPY max 1 loss/day",
    env: {
      TRADING_PAIRS: "EUR_USD,USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
      LONDON_MAX_LOSSES_PER_DAY: "1",
    },
  },
];

function dayOf(value) {
  return String(value || "").slice(0, 10);
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function maxDrawdown(values) {
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return maxDd;
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i] - mx;
    const y = ys[i] - my;
    num += x * y;
    dx += x * x;
    dy += y * y;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

function dailyPnl(trades) {
  const byDay = new Map();
  for (const trade of trades) {
    const day = dayOf(trade.exitTime || trade.time || trade.setupTime);
    if (!day) continue;
    byDay.set(day, (byDay.get(day) || 0) + Number(trade.profit || 0));
  }
  return byDay;
}

function groupTradesByDay(trades) {
  const byDay = new Map();
  for (const trade of trades) {
    const day = dayOf(trade.exitTime || trade.time || trade.setupTime);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(trade);
  }
  for (const dayTrades of byDay.values()) {
    dayTrades.sort((a, b) => new Date(a.exitTime || a.time || 0) - new Date(b.exitTime || b.time || 0));
  }
  return byDay;
}

function applyLondonBrake(trades, { maxDailyLossUSD = Infinity, maxConsecutiveLosses = Infinity } = {}) {
  const kept = [];
  for (const dayTrades of groupTradesByDay(trades).values()) {
    let dailyPnl = 0;
    let consecutiveLosses = 0;
    for (const trade of dayTrades) {
      if (dailyPnl <= -Math.abs(maxDailyLossUSD)) continue;
      if (consecutiveLosses >= maxConsecutiveLosses) continue;

      kept.push(trade);
      const pnl = Number(trade.profit || 0);
      dailyPnl += pnl;
      consecutiveLosses = pnl <= 0 ? consecutiveLosses + 1 : 0;
    }
  }
  return kept;
}

function summarizeTrades(trades) {
  const profits = trades.map(t => Number(t.profit || 0));
  const wins = profits.filter(v => v > 0);
  const losses = profits.filter(v => v <= 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    net: sum(profits),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? sum(profits) / trades.length : 0,
  };
}

function summarizeDaily(map) {
  const days = Array.from(map.keys()).sort();
  const values = days.map(day => map.get(day) || 0);
  return {
    activeDays: values.filter(v => v !== 0).length,
    greenDays: values.filter(v => v > 0).length,
    redDays: values.filter(v => v < 0).length,
    net: sum(values),
    avgActiveDay: mean(values.filter(v => v !== 0)),
    maxDailyLoss: values.length ? Math.min(...values) : 0,
    maxDailyWin: values.length ? Math.max(...values) : 0,
    maxDrawdown: maxDrawdown(values),
  };
}

function combineMaps(a, b) {
  const out = new Map(a);
  for (const [day, value] of b.entries()) out.set(day, (out.get(day) || 0) + value);
  return out;
}

function compareDaily(nyMap, londonMap) {
  const unionDays = Array.from(new Set([...nyMap.keys(), ...londonMap.keys()])).sort();
  const overlapDays = unionDays.filter(day => nyMap.has(day) && londonMap.has(day));
  const unionNy = unionDays.map(day => nyMap.get(day) || 0);
  const unionLondon = unionDays.map(day => londonMap.get(day) || 0);
  const overlapNy = overlapDays.map(day => nyMap.get(day) || 0);
  const overlapLondon = overlapDays.map(day => londonMap.get(day) || 0);

  const londonLosingDays = unionDays.filter(day => (londonMap.get(day) || 0) < 0);
  const londonWinningDays = unionDays.filter(day => (londonMap.get(day) || 0) > 0);
  const bothActive = overlapDays.length;
  const bothWin = overlapDays.filter(day => (nyMap.get(day) || 0) > 0 && (londonMap.get(day) || 0) > 0).length;
  const bothLose = overlapDays.filter(day => (nyMap.get(day) || 0) < 0 && (londonMap.get(day) || 0) < 0).length;
  const londonLoseNyWin = overlapDays.filter(day => (londonMap.get(day) || 0) < 0 && (nyMap.get(day) || 0) > 0).length;
  const londonWinNyLose = overlapDays.filter(day => (londonMap.get(day) || 0) > 0 && (nyMap.get(day) || 0) < 0).length;

  return {
    unionDays: unionDays.length,
    overlapDays: bothActive,
    correlationUnionZeroFilled: pearson(unionNy, unionLondon),
    correlationActiveOverlap: pearson(overlapNy, overlapLondon),
    avgNyOnLondonLosingDays: mean(londonLosingDays.map(day => nyMap.get(day) || 0)),
    avgNyOnLondonWinningDays: mean(londonWinningDays.map(day => nyMap.get(day) || 0)),
    bothWin,
    bothLose,
    londonLoseNyWin,
    londonWinNyLose,
  };
}

function runBacktest(testCase) {
  const env = { ...process.env, ...COST_PROFILE, ...testCase.env };
  const run = spawnSync(process.execPath, ["backtest-multi.js"], {
    env,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    throw new Error(`${testCase.key} backtest failed`);
  }
  const data = JSON.parse(fs.readFileSync("trades_backtest.json", "utf8"));
  fs.writeFileSync(path.join(OUTPUT_DIR, `${testCase.key}.json`), JSON.stringify(data, null, 2));
  return data;
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const datasets = Object.fromEntries(CASES.map(testCase => {
    console.log(`Running ${testCase.label}...`);
    return [testCase.key, runBacktest(testCase)];
  }));

  const nyTrades = datasets.ny_current.trades || [];
  const nyDaily = dailyPnl(nyTrades);
  const londonCases = [
    "london_usdjpy",
    "london_usdjpy_max_1_loss",
    "london_usdjpy_cleaned",
    "london_eurusd_usdjpy",
    "london_eurusd_usdjpy_max_1_loss",
    "london_eurusd_usdjpy_cleaned",
  ];
  const brakeConfigs = [
    { name: "no_brake", maxDailyLossUSD: Infinity, maxConsecutiveLosses: Infinity },
    { name: "max_1_loss", maxDailyLossUSD: Infinity, maxConsecutiveLosses: 1 },
    { name: "max_2_losses", maxDailyLossUSD: Infinity, maxConsecutiveLosses: 2 },
    { name: "max_daily_loss_10", maxDailyLossUSD: 10, maxConsecutiveLosses: Infinity },
    { name: "max_daily_loss_20", maxDailyLossUSD: 20, maxConsecutiveLosses: Infinity },
    { name: "max_daily_loss_30", maxDailyLossUSD: 30, maxConsecutiveLosses: Infinity },
  ];

  const results = [];
  for (const londonKey of londonCases) {
    const londonTrades = datasets[londonKey].trades || [];
    for (const brake of brakeConfigs) {
      const filteredLondonTrades = applyLondonBrake(londonTrades, brake);
      const londonDaily = dailyPnl(filteredLondonTrades);
      const combinedDaily = combineMaps(nyDaily, londonDaily);
      results.push({
        londonCase: londonKey,
        brake: brake.name,
        nyTrades: summarizeTrades(nyTrades),
        londonTrades: summarizeTrades(filteredLondonTrades),
        nyDaily: summarizeDaily(nyDaily),
        londonDaily: summarizeDaily(londonDaily),
        combinedDaily: summarizeDaily(combinedDaily),
        relationship: compareDaily(nyDaily, londonDaily),
      });
    }
  }

  console.log("\nLondon vs NY combined/correlation summary");
  console.log("----------------------------------------");
  console.table(results.map(row => ({
    london: row.londonCase,
    brake: row.brake,
    londonTrades: row.londonTrades.trades,
    londonNet: formatMoney(row.londonTrades.net),
    combinedNet: formatMoney(row.combinedDaily.net),
    combinedDD: formatMoney(row.combinedDaily.maxDrawdown),
    corrOverlap: row.relationship.correlationActiveOverlap.toFixed(3),
    bothLose: row.relationship.bothLose,
    avgNyAfterLondonLossDay: formatMoney(row.relationship.avgNyOnLondonLosingDays),
  })));

  const report = {
    generatedAtUTC: new Date().toISOString(),
    cases: CASES,
    results,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, "london_ny_correlation.json"), JSON.stringify(report, null, 2));
  console.log(`\nSaved ${path.join(OUTPUT_DIR, "london_ny_correlation.json")}`);
}

main();




