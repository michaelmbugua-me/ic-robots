#!/usr/bin/env node

import fs from "fs";
import { spawnSync } from "child_process";

const CASES = [
  {
    key: "london_usdjpy",
    label: "London Candidate B USD_JPY only",
    env: {
      TRADING_PAIRS: "USD_JPY",
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
      LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    },
  },
  {
    key: "london_eurusd_usdjpy_braked",
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

function hourBucket(time) {
  const d = new Date(time);
  const h = d.getUTCHours();
  return `${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`;
}

function weekday(time) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(time).getUTCDay()];
}

function riskBand(riskPips) {
  const r = Number(riskPips);
  if (!Number.isFinite(r)) return "unknown";
  if (r < 5) return "<5";
  if (r <= 6) return "5-6";
  if (r <= 8) return "6-8";
  if (r <= 10) return "8-10";
  return ">10";
}

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}

function summarize(trades) {
  const profits = trades.map(t => Number(t.profit || 0));
  const wins = profits.filter(p => p > 0);
  const losses = profits.filter(p => p <= 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  return {
    n: trades.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    net: sum(profits),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? sum(profits) / trades.length : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
  };
}

function grouped(trades, keyFn) {
  const groups = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }
  return Array.from(groups.entries())
    .map(([key, rows]) => ({ key, ...summarize(rows) }))
    .sort((a, b) => b.net - a.net);
}

function fmt(n, d = 2) {
  return Number(n || 0).toFixed(d);
}

function fmtPf(value) {
  return value === Infinity ? "∞" : fmt(value, 2);
}

function printTable(title, rows) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.table(rows.map(row => ({
    bucket: row.key,
    n: row.n,
    win: `${fmt(row.winRate, 1)}%`,
    pf: fmtPf(row.profitFactor),
    net: fmt(row.net, 2),
    exp: fmt(row.expectancy, 2),
    avgWin: fmt(row.avgWin, 2),
    avgLoss: fmt(row.avgLoss, 2),
  })));
}

function runBacktest(testCase) {
  const env = { ...process.env, ...testCase.env };
  const run = spawnSync(process.execPath, ["backtest-multi.js"], {
    env,
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    throw new Error(`${testCase.key} failed`);
  }
  return JSON.parse(fs.readFileSync("trades_backtest.json", "utf8"));
}

function diagnosticsFor(testCase, data) {
  const trades = data.trades || [];
  console.log(`\n${"═".repeat(80)}`);
  console.log(testCase.label);
  console.log(`${"═".repeat(80)}`);
  console.log("Summary:", {
    total: data.summary.total,
    winRate: data.summary.winRate,
    net: fmt(data.summary.netProfit, 2),
    finalBalance: fmt(data.summary.finalBalance, 2),
    byPair: data.byPair,
  });

  printTable("By pair", grouped(trades, t => t.pair || "unknown"));
  printTable("By weekday", grouped(trades, t => weekday(t.time || t.exitTime)));
  printTable("By London hour", grouped(trades, t => hourBucket(t.time || t.exitTime)));
  printTable("By break direction", grouped(trades, t => t.breakDirection || `${t.direction === "SELL" ? "break_up" : "break_down"}_inferred`));
  printTable("By risk band", grouped(trades, t => riskBand(t.riskPips)));
  printTable("By exit reason", grouped(trades, t => t.reason || "unknown"));
  printTable("By pair + hour", grouped(trades, t => `${t.pair || "unknown"} ${hourBucket(t.time || t.exitTime)}`));
  printTable("By pair + weekday", grouped(trades, t => `${t.pair || "unknown"} ${weekday(t.time || t.exitTime)}`));
}

const report = { generatedAtUTC: new Date().toISOString(), cases: [] };
for (const testCase of CASES) {
  const data = runBacktest(testCase);
  diagnosticsFor(testCase, data);
  report.cases.push({
    key: testCase.key,
    label: testCase.label,
    summary: data.summary,
    byPair: data.byPair,
    diagnostics: {
      byPair: grouped(data.trades || [], t => t.pair || "unknown"),
      byWeekday: grouped(data.trades || [], t => weekday(t.time || t.exitTime)),
      byHour: grouped(data.trades || [], t => hourBucket(t.time || t.exitTime)),
      byBreakDirection: grouped(data.trades || [], t => t.breakDirection || `${t.direction === "SELL" ? "break_up" : "break_down"}_inferred`),
      byRiskBand: grouped(data.trades || [], t => riskBand(t.riskPips)),
      byExitReason: grouped(data.trades || [], t => t.reason || "unknown"),
      byPairHour: grouped(data.trades || [], t => `${t.pair || "unknown"} ${hourBucket(t.time || t.exitTime)}`),
      byPairWeekday: grouped(data.trades || [], t => `${t.pair || "unknown"} ${weekday(t.time || t.exitTime)}`),
    },
  });
}

fs.mkdirSync("analysis", { recursive: true });
fs.writeFileSync("analysis/london_diagnostics.json", JSON.stringify(report, null, 2));
console.log("\nSaved analysis/london_diagnostics.json");

