/**
 * Trade Performance Analyzer & Dashboard
 * Generates a Daily PnL Calendar from trades_backtest.json (5-10-20 EMA Strategy)
 */

import fs from "fs";

const FILE_PATH = "trades_backtest.json";

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
      `risk=${profile.minRiskPips ?? "?"}-${profile.maxRiskPips ?? "?"} pips`
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
}

analyze();
