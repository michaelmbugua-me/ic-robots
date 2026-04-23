#!/usr/bin/env node

import fs from "fs";
import { execSync } from "child_process";

const OUTPUT_FILE = "trades_backtest.json";
const START_BALANCE = 385;
const SNAPSHOT_PREFIX = "mode_compare";

const MODES = [
  { key: "ny_only", label: "NY Only (12:30-16:00 UTC)" },
  { key: "ny_trimmed", label: "NY Trimmed (12:45-15:45 UTC)" },
  { key: "all_windows", label: "All Windows (London + NY)" },
];

function runBacktestForMode(modeKey) {
  const env = { ...process.env, SESSION_WINDOW_MODE: modeKey };
  execSync("node backtest-multi.js", {
    env,
    stdio: "pipe",
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (!fs.existsSync(OUTPUT_FILE)) {
    throw new Error(`Expected ${OUTPUT_FILE} after backtest run`);
  }

  const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, "utf8"));
  const trades = data.trades || [];

  return summarizeTrades(trades);
}

function summarizeTrades(trades) {
  const profits = trades.map(t => Number(t.profit) || 0);
  const wins = profits.filter(p => p > 0);
  const losses = profits.filter(p => p <= 0);

  const total = profits.length;
  const winRate = total > 0 ? (wins.length / total) * 100 : 0;
  const net = profits.reduce((a, b) => a + b, 0);
  const expectancy = total > 0 ? net / total : 0;

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : 0;

  const endBalance = trades.length > 0 ? Number(trades[trades.length - 1].balance) : START_BALANCE;
  const roiPct = ((endBalance / START_BALANCE) - 1) * 100;
  const maxDrawdownPct = calculateMaxDrawdownPct(trades, START_BALANCE);

  return {
    trades: total,
    winRate,
    net,
    expectancy,
    profitFactor,
    endBalance,
    roiPct,
    maxDrawdownPct,
  };
}

function calculateMaxDrawdownPct(trades, startBalance) {
  let peak = startBalance;
  let maxDrawdown = 0;

  for (const t of trades) {
    const bal = Number(t.balance) || 0;
    if (bal > peak) peak = bal;
    const dd = peak > 0 ? ((peak - bal) / peak) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return maxDrawdown;
}

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

function timestampForFilename(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

function writeSnapshot(results, bestByPF, bestByExp) {
  const snapshot = {
    generatedAtUTC: new Date().toISOString(),
    startBalance: START_BALANCE,
    outputSource: OUTPUT_FILE,
    modes: results.map(r => ({
      key: r.key,
      label: r.label,
      ...r.stats,
    })),
    winners: {
      bestByProfitFactor: { key: bestByPF.key, label: bestByPF.label },
      bestByExpectancy: { key: bestByExp.key, label: bestByExp.label },
    },
  };

  const fileName = `${SNAPSHOT_PREFIX}_${timestampForFilename()}.json`;
  fs.writeFileSync(fileName, JSON.stringify(snapshot, null, 2));
  return fileName;
}

function main() {
  console.log("\nMODE COMPARISON: 5-10-20 EMA Session Windows");
  console.log("Running backtest for each mode...\n");

  const results = MODES.map(m => ({ ...m, stats: runBacktestForMode(m.key) }));

  console.log("Mode                           Trades  Win%   PF     Exp/Trade  Net($)   EndBal   ROI%   MaxDD%");
  console.log("-------------------------------------------------------------------------------------------------");
  for (const r of results) {
    const s = r.stats;
    const line = [
      r.label.padEnd(30),
      String(s.trades).padStart(6),
      fmt(s.winRate, 1).padStart(6),
      fmt(s.profitFactor, 3).padStart(6),
      fmt(s.expectancy, 3).padStart(10),
      fmt(s.net, 2).padStart(8),
      fmt(s.endBalance, 2).padStart(8),
      fmt(s.roiPct, 1).padStart(6),
      fmt(s.maxDrawdownPct, 1).padStart(7),
    ].join(" ");
    console.log(line);
  }

  const bestByPF = results.slice().sort((a, b) => b.stats.profitFactor - a.stats.profitFactor)[0];
  const bestByExp = results.slice().sort((a, b) => b.stats.expectancy - a.stats.expectancy)[0];
  const snapshotFile = writeSnapshot(results, bestByPF, bestByExp);

  console.log("\nBest by PF :", bestByPF.label);
  console.log("Best by Exp:", bestByExp.label);
  console.log("Snapshot   :", snapshotFile);
  console.log("\nDone.");
}

try {
  main();
} catch (err) {
  console.error("Comparison failed:", err.message);
  process.exit(1);
}



