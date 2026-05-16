/**
 * Trade Performance Analyzer & Dashboard
 * Generates a Daily PnL Calendar from trades_backtest.json (5-10-20 EMA Strategy)
 */

import fs from "fs";
import { computeRobustnessReport } from "./report-metrics.js";

const FILE_PATH = "trades_backtest.json";

function formatUSD(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatPct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function formatProfitFactor(value) {
  return value === Infinity ? "∞" : Number(value || 0).toFixed(2);
}

function analyze() {
  if (!fs.existsSync(FILE_PATH)) {
    console.log("❌ No trade data found. Run a backtest first.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  const trades = data.trades || [];
  const profile = data.profile || {};

  if (trades.length === 0) {
    console.log("⚠️ No trades to analyze.");
    return;
  }

  // Group by Date
  const dailyStats = {};
  trades.forEach(t => {
    const date = t.exitTime.split("T")[0]; // YYYY-MM-DD
    if (!dailyStats[date]) {
      dailyStats[date] = { profit: 0, count: 0, wins: 0 };
    }
    dailyStats[date].profit += t.profit;
    dailyStats[date].count += 1;
    if (t.profit > 0) dailyStats[date].wins += 1;
  });

  const sortedDates = Object.keys(dailyStats).sort();

  console.log(`\n═══ 📅 DAILY PERFORMANCE DASHBOARD (${data.type.toUpperCase()}) ═══`);
  console.log(`  Strategy: 5-10-20 EMA Scalping`);
  if (profile.sessionWindowMode) {
    console.log(
      `  Profile : mode=${profile.sessionWindowMode} | ` +
      `emaSep=${profile.emaSeparationMinPips ?? 0} | ` +
      `cooldown=${profile.cooldownCandlesAfterLoss ?? 0} | ` +
      `risk=${profile.minRiskPips ?? "?"}-${profile.maxRiskPips ?? "?"} pips` +
      `${profile.positionSizing?.model ? ` | sizing=${profile.positionSizing.model}` : ""}`
    );
  }
  if (data.generatedAtUTC) {
    console.log(`  Generated: ${data.generatedAtUTC}`);
  }
  console.log(`${"═".repeat(60)}`);
  console.log(`  DATE        | TRADES | WIN % | NET PnL ($)`);
  console.log(`${"-".repeat(60)}`);

  let totalProfit = 0;
  let greenDays = 0;
  let redDays = 0;

  sortedDates.forEach(date => {
    const stats = dailyStats[date];
    const winRate = ((stats.wins / stats.count) * 100).toFixed(0);
    const profitStr = stats.profit.toFixed(2).padStart(10);
    
    // Simple color coding (ANSI)
    const color = stats.profit > 0 ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log(`  ${date}  |   ${stats.count.toString().padEnd(2)}   |  ${winRate.toString().padStart(3)}% | ${color}${profitStr}${reset}`);
    
    totalProfit += stats.profit;
    if (stats.profit > 0) greenDays++;
    else redDays++;
  });

  console.log(`${"═".repeat(60)}`);
  console.log(`  SUMMARY STATISTICS`);
  console.log(`${"-".repeat(60)}`);
  console.log(`  Total Period   : ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}`);
  console.log(`  Profitable Days: \x1b[32m${greenDays}\x1b[0m`);
  console.log(`  Losing Days    : \x1b[31m${redDays}\x1b[0m`);
  console.log(`  Batting Average: ${((greenDays / sortedDates.length) * 100).toFixed(1)}% (Green Day Ratio)`);
  console.log(`  Total Net PnL  : $${totalProfit.toFixed(2)}`);
  console.log(`${"═".repeat(60)}\n`);

  if (data.summary?.dailyRiskSimulation) {
    const risk = data.summary.dailyRiskSimulation;
    const blockedDays = data.dailyRiskSimulation?.blockedDays || [];
    console.log(`═══ 🛡️ DAILY RISK GATE SIMULATION ═══`);
    console.log(`  Blocked Days            : ${risk.blockedDays || 0}`);
    console.log(`  Blocked Signals         : ${risk.blockedSignals || 0}`);
    console.log(`  Blocked Pending Triggers: ${risk.blockedPendingTriggers || 0}`);
    if (blockedDays.length > 0) {
      console.log(`${"-".repeat(60)}`);
      for (const day of blockedDays) {
        console.log(
          `  ${day.day} | ${day.reason.padEnd(19)} | ` +
          `Profit: ${String(Math.round(day.dailyRealizedProfitKES || 0)).padStart(4)} KES | ` +
          `Loss: ${String(Math.round(day.dailyRealizedLossKES || 0)).padStart(4)} KES`
        );
      }
    }
    console.log(`${"═".repeat(60)}\n`);
  }

  const robustness = computeRobustnessReport(trades);
  const bestMonth = robustness.clustering.topMonth;

  console.log(`═══ 🧱 ROBUSTNESS REPORT ═══`);
  console.log(`  Max Drawdown          : ${formatUSD(robustness.maxDrawdown.amount)} (${formatPct(robustness.maxDrawdown.pct)})`);
  console.log(`  Longest Losing Streak : ${robustness.longestLosingStreak.count} trades (${formatUSD(robustness.longestLosingStreak.amount)})`);
  console.log(`  Best Month Share      : ${formatPct(robustness.clustering.topMonthPositiveShare)}${bestMonth ? ` (${bestMonth.period})` : ""}`);
  console.log(`  Top 3 Months Share    : ${formatPct(robustness.clustering.topThreeMonthPositiveShare)}`);
  console.log(`${"-".repeat(60)}`);
  console.log(`  Pair      | Trades | Win % | PF   | Net PnL | Max DD | Green Months`);
  console.log(`${"-".repeat(60)}`);
  for (const pair of robustness.byPair) {
    console.log(
      `  ${pair.pair.padEnd(8)} | ${String(pair.trades).padStart(6)} | ${formatPct(pair.winRate).padStart(5)} | ${formatProfitFactor(pair.profitFactor).padStart(4)} | ` +
      `${formatUSD(pair.netProfit).padStart(7)} | ${formatUSD(pair.maxDrawdown.amount).padStart(6)} | ${formatPct(pair.monthlyStability.greenMonthRate).padStart(12)}`
    );
  }
  console.log(`${"-".repeat(60)}`);
  for (const alert of robustness.clustering.alerts) {
    const prefix = alert.level === "ok" ? "✅" : alert.level === "danger" ? "❌" : "⚠️";
    console.log(`  ${prefix} ${alert.text}`);
  }
  console.log(`${"═".repeat(60)}\n`);
}

analyze();
