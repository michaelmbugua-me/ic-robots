#!/usr/bin/env node

import fs from "fs";
import { spawnSync } from "child_process";

const base = {
  STRATEGY_MODE: "london_asian_fake_break_reversal",
  SESSION_WINDOW_MODE: "london_only",
  LONDON_FAKE_BREAK_PROFILE: "candidate_b",
};

const cases = [
  ["USDJPY_B_default", { TRADING_PAIRS: "USD_JPY" }],
  ["USDJPY_B_time_exit", { TRADING_PAIRS: "USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit" }],
  ["USDJPY_B_h1_reversal_time", { TRADING_PAIRS: "USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit", LONDON_FAKE_BREAK_H1_FILTER: "reversal_with_h1" }],
  ["USDJPY_B_min5_risk6_12_time", { TRADING_PAIRS: "USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit", LONDON_FAKE_BREAK_MIN_BREAK_PIPS: "5", LONDON_FAKE_BREAK_MIN_RISK_PIPS: "6", LONDON_FAKE_BREAK_MAX_RISK_PIPS: "12" }],
  ["USDJPY_B_all_weekdays_time", { TRADING_PAIRS: "USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit", LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Mon,Tue,Wed,Thu,Fri" }],
  ["EU_UJ_B_default", { TRADING_PAIRS: "EUR_USD,USD_JPY" }],
  ["EU_UJ_B_time_exit", { TRADING_PAIRS: "EUR_USD,USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit" }],
  ["EU_UJ_B_h1_reversal_time", { TRADING_PAIRS: "EUR_USD,USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit", LONDON_FAKE_BREAK_H1_FILTER: "reversal_with_h1" }],
  ["EU_UJ_B_min5_risk6_12_time", { TRADING_PAIRS: "EUR_USD,USD_JPY", LONDON_FAKE_BREAK_TARGET_MODE: "time_exit", LONDON_FAKE_BREAK_MIN_BREAK_PIPS: "5", LONDON_FAKE_BREAK_MIN_RISK_PIPS: "6", LONDON_FAKE_BREAK_MAX_RISK_PIPS: "12" }],
];

function summarize(data) {
  const trades = data.trades || [];
  const exits = {};
  for (const trade of trades) exits[trade.reason] = (exits[trade.reason] || 0) + 1;
  return {
    total: data.summary.total,
    winRate: data.summary.winRate,
    net: Number(data.summary.netProfit).toFixed(2),
    final: Number(data.summary.finalBalance).toFixed(2),
    blockedDays: data.summary.dailyRiskSimulation?.blockedDays ?? 0,
    byPair: Object.fromEntries(Object.entries(data.byPair || {}).map(([pair, stats]) => [pair, {
      n: stats.total,
      winRate: stats.winRate,
      pf: stats.profitFactor,
      net: stats.netProfit,
      expectancy: stats.expectancy,
    }])),
    exits,
  };
}

const results = [];
for (const [name, extraEnv] of cases) {
  const env = { ...process.env, ...base, ...extraEnv };
  const run = spawnSync(process.execPath, ["backtest-multi.js"], {
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (run.status !== 0) {
    console.error(run.stdout);
    console.error(run.stderr);
    throw new Error(`${name} failed`);
  }
  const data = JSON.parse(fs.readFileSync("trades_backtest.json", "utf8"));
  results.push({ name, ...summarize(data) });
}

console.table(results.map(r => ({
  case: r.name,
  trades: r.total,
  win: r.winRate,
  net: r.net,
  final: r.final,
  blockedDays: r.blockedDays,
  exits: JSON.stringify(r.exits),
  pairs: Object.entries(r.byPair).map(([pair, s]) => `${pair}:PF${s.pf}/net${s.net}/n${s.n}`).join("; "),
})));

fs.writeFileSync("london_variant_analysis.json", JSON.stringify({ generatedAtUTC: new Date().toISOString(), results }, null, 2));
console.log("Saved london_variant_analysis.json");

