#!/usr/bin/env node

import fs from "fs";
import { spawnSync } from "child_process";

const REPORT_JSON = "analysis/london_ny_correlation.json";
const REPORT_MD = "analysis/selected_combined_profile.md";
const SELECTED_JSON = "analysis/selected_combined_profile.json";
const NY_DATA_JSON = "analysis/ny_current.json";
const LONDON_DATA_JSON = "analysis/london_eurusd_usdjpy_cleaned.json";
const SELECTED_LONDON_CASE = "london_eurusd_usdjpy_cleaned";
const SELECTED_BRAKE = "max_1_loss";

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function runCorrelationAnalysis() {
  const result = spawnSync("npm", ["run", "research:london-ny:correlation"], {
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 120 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error("London/NY correlation analysis failed");
  }
  return result.stdout;
}

function tradeTime(trade) {
  return trade.exitTime || trade.time || trade.setupTime || "";
}

function monthKey(trade) {
  return tradeTime(trade).slice(0, 7) || "unknown";
}

function applyMaxOneLossPerDay(trades) {
  const byDay = new Map();
  for (const trade of trades) {
    const day = tradeTime(trade).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(trade);
  }

  const kept = [];
  for (const dayTrades of byDay.values()) {
    dayTrades.sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));
    let losses = 0;
    for (const trade of dayTrades) {
      if (losses >= 1) continue;
      kept.push(trade);
      if (Number(trade.profit || 0) <= 0) losses += 1;
    }
  }
  return kept.sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));
}

function summarizeTrades(trades) {
  const profits = trades.map(t => Number(t.profit || 0));
  const wins = profits.filter(v => v > 0);
  const losses = profits.filter(v => v <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    grossProfit,
    grossLoss,
    net: profits.reduce((a, b) => a + b, 0),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy: trades.length ? profits.reduce((a, b) => a + b, 0) / trades.length : 0,
    maxConsecutiveLosses: maxConsecutiveLosses(trades),
  };
}

function maxConsecutiveLosses(trades) {
  let current = 0;
  let max = 0;
  for (const trade of trades) {
    if (Number(trade.profit || 0) <= 0) {
      current += 1;
      max = Math.max(max, current);
    } else {
      current = 0;
    }
  }
  return max;
}

function monthlyDistribution(trades) {
  const byMonth = new Map();
  for (const trade of trades) {
    const month = monthKey(trade);
    if (!byMonth.has(month)) byMonth.set(month, { month, trades: 0, wins: 0, losses: 0, net: 0 });
    const row = byMonth.get(month);
    const profit = Number(trade.profit || 0);
    row.trades += 1;
    row.net += profit;
    if (profit > 0) row.wins += 1;
    else row.losses += 1;
  }
  return Array.from(byMonth.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(row => ({ ...row, winRate: row.trades ? row.wins / row.trades * 100 : 0 }));
}

function markdownMonthlyTable(rows) {
  return [
    "| Month | Trades | Win rate | Net |",
    "|---|---:|---:|---:|",
    ...rows.map(row => `| ${row.month} | ${row.trades} | ${pct(row.winRate)} | ${money(row.net)} |`),
  ].join("\n");
}

function main() {
  fs.mkdirSync("analysis", { recursive: true });
  console.log("Running selected NY + cleaned London profile analysis...");
  const rawOutput = runCorrelationAnalysis();
  const report = JSON.parse(fs.readFileSync(REPORT_JSON, "utf8"));
  const selected = report.results.find(row => row.londonCase === SELECTED_LONDON_CASE && row.brake === SELECTED_BRAKE);
  if (!selected) throw new Error(`Selected row not found: ${SELECTED_LONDON_CASE} / ${SELECTED_BRAKE}`);

  const ny = selected.nyTrades;
  const london = selected.londonTrades;
  const combined = selected.combinedDaily;
  const relationship = selected.relationship;
  const nyData = JSON.parse(fs.readFileSync(NY_DATA_JSON, "utf8"));
  const londonData = JSON.parse(fs.readFileSync(LONDON_DATA_JSON, "utf8"));
  const nyTrades = (nyData.trades || []).map(trade => ({ ...trade, module: "ny_asian_continuation" }));
  const selectedLondonTrades = applyMaxOneLossPerDay(londonData.trades || [])
    .map(trade => ({ ...trade, module: "london_asian_fake_break_reversal" }));
  const combinedTrades = [...nyTrades, ...selectedLondonTrades]
    .sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));
  const combinedTradeStats = summarizeTrades(combinedTrades);
  const monthly = monthlyDistribution(combinedTrades);
  const positiveMonths = monthly.filter(row => row.net > 0).length;
  const negativeMonths = monthly.filter(row => row.net < 0).length;

  const md = `# Selected Combined Research Profile

Generated: ${new Date().toISOString()}

## Selected profile

| Field | Value |
|---|---|
| NY module | \`ny_asian_continuation\` current basket |
| London module | \`london_asian_fake_break_reversal\` Candidate B |
| London pairs | \`EUR_USD,USD_JPY\` |
| London window | \`07:00–09:00 UTC\` |
| London pair/day exclusion | \`EUR_USD:Thu\` |
| London brake | \`LONDON_MAX_LOSSES_PER_DAY=1\` |
| Live status | Monitor/demo first; no live auto-execute yet |

## Backtest/correlation result

| Metric | NY only | London only | Combined |
|---|---:|---:|---:|
| Trades | ${ny.trades} | ${london.trades} | — |
| Win rate | ${pct(ny.winRate)} | ${pct(london.winRate)} | — |
| Net | ${money(ny.net)} | ${money(london.net)} | ${money(combined.net)} |
| Profit factor | ${Number(ny.profitFactor).toFixed(3)} | ${Number(london.profitFactor).toFixed(3)} | — |
| Expectancy | ${money(ny.expectancy)} | ${money(london.expectancy)} | — |
| Daily-equity max DD | ${money(selected.nyDaily.maxDrawdown)} | ${money(selected.londonDaily.maxDrawdown)} | ${money(combined.maxDrawdown)} |

## Combined trade-level metrics

These metrics merge NY trades and the selected London trades chronologically.

| Metric | Value |
|---|---:|
| Combined trades | ${combinedTradeStats.trades} |
| Combined wins | ${combinedTradeStats.wins} |
| Combined losses | ${combinedTradeStats.losses} |
| Combined win rate | ${pct(combinedTradeStats.winRate)} |
| Combined gross profit | ${money(combinedTradeStats.grossProfit)} |
| Combined gross loss | ${money(combinedTradeStats.grossLoss)} |
| Combined net | ${money(combinedTradeStats.net)} |
| Combined profit factor | ${Number(combinedTradeStats.profitFactor).toFixed(3)} |
| Combined expectancy/trade | ${money(combinedTradeStats.expectancy)} |
| Combined max consecutive losses | ${combinedTradeStats.maxConsecutiveLosses} |
| Positive months | ${positiveMonths} |
| Negative months | ${negativeMonths} |

## London/NY relationship

| Metric | Value |
|---|---:|
| Active overlap days | ${relationship.overlapDays} |
| Correlation on active overlap days | ${Number(relationship.correlationActiveOverlap).toFixed(3)} |
| Both-loss days | ${relationship.bothLose} |
| London-loss / NY-win days | ${relationship.londonLoseNyWin} |
| NY average on London losing days | ${money(relationship.avgNyOnLondonLosingDays)} |

## Monthly distribution of combined profits

${markdownMonthlyTable(monthly)}

## Decision

This is the current working combined research candidate because it produced the best selected total net while keeping drawdown materially lower than the earlier uncleaned two-pair London basket.

Continue with:

\`\`\`bash
npm run research:combined:selected
npm run start:london-monitor:cleaned
\`\`\`

Do **not** enable London live execution until monitor-only/demo validation has collected enough sessions.
`;

  fs.writeFileSync(REPORT_MD, md);
  fs.writeFileSync(SELECTED_JSON, JSON.stringify({
    generatedAtUTC: new Date().toISOString(),
    selected: {
      londonCase: SELECTED_LONDON_CASE,
      brake: SELECTED_BRAKE,
    },
    combinedTradeStats,
    monthlyDistribution: monthly,
    selectedCorrelationRow: selected,
  }, null, 2));
  console.log(rawOutput.split("\n").slice(-40).join("\n"));
  console.log(`\nSelected row: ${SELECTED_LONDON_CASE} / ${SELECTED_BRAKE}`);
  console.log(`Combined net: ${money(combined.net)} | Combined DD: ${money(combined.maxDrawdown)} | London net: ${money(london.net)}`);
  console.log(`Combined win rate: ${pct(combinedTradeStats.winRate)} | Combined PF: ${Number(combinedTradeStats.profitFactor).toFixed(3)} | Max consecutive losses: ${combinedTradeStats.maxConsecutiveLosses}`);
  console.log(`Saved ${REPORT_MD}`);
  console.log(`Saved ${SELECTED_JSON}`);
}

main();


