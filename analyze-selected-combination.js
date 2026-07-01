#!/usr/bin/env node

import fs from "fs";
import { spawnSync } from "child_process";

const REPORT_MD = "analysis/selected_combined_profile.md";
const SELECTED_JSON = "analysis/selected_combined_profile.json";
const SELECTED_PROFILE = {
  nyPairs: ["EUR_USD", "GBP_USD", "USD_JPY"],
  londonPairs: ["EUR_USD", "USD_JPY"],
  londonAllowedWeekdays: ["Wed"],
  londonWindowUTC: "07:00-09:00",
  londonMaxLossesPerDay: 1,
};
const COST_PROFILE = {
  BACKTEST_SPREAD_PIPS: process.env.BACKTEST_SPREAD_PIPS ?? "0.7",
  BACKTEST_SLIPPAGE_PIPS: process.env.BACKTEST_SLIPPAGE_PIPS ?? "0.3",
};
const CASES = [
  {
    key: "ny_selected",
    label: "NY only current basket",
    env: {
      TRADING_PAIRS: SELECTED_PROFILE.nyPairs.join(","),
      STRATEGY_MODE: "ny_asian_continuation",
      SESSION_WINDOW_MODE: "all_windows",
    },
  },
  {
    key: "london_selected",
    label: "London selected module only",
    env: selectedLondonEnv({
      TRADING_PAIRS: SELECTED_PROFILE.londonPairs.join(","),
      STRATEGY_MODE: "london_asian_fake_break_reversal",
      SESSION_WINDOW_MODE: "london_only",
    }),
  },
  {
    key: "combined_selected",
    label: "NY basket + selected London",
    env: selectedLondonEnv({
      TRADING_PAIRS: SELECTED_PROFILE.nyPairs.join(","),
      STRATEGY_MODE: "combined_ny_london",
      SESSION_WINDOW_MODE: "all_windows",
      LONDON_FAKE_BREAK_ALLOWED_PAIRS: SELECTED_PROFILE.londonPairs.join(","),
    }),
  },
];

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function selectedLondonEnv(env) {
  return {
    LONDON_MONITOR_ENABLED: "true",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: SELECTED_PROFILE.londonAllowedWeekdays.join(","),
    LONDON_FAKE_BREAK_ALLOWED_PAIRS: SELECTED_PROFILE.londonPairs.join(","),
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_MAX_LOSSES_PER_DAY: String(SELECTED_PROFILE.londonMaxLossesPerDay),
    LONDON_FAKE_BREAK_MAX_ASIAN_RANGE_PIPS: "60",
    ...env,
  };
}

function runBacktest(testCase) {
  const result = spawnSync(process.execPath, ["backtest-multi.js"], {
    env: { ...process.env, ...COST_PROFILE, ...testCase.env },
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 120 * 1024 * 1024,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${testCase.key} backtest failed`);
  }
  const output = JSON.parse(fs.readFileSync("trades_backtest.json", "utf8"));
  fs.writeFileSync(`analysis/${testCase.key}.json`, JSON.stringify(output, null, 2));
  return { ...output, consoleTail: result.stdout.split("\n").slice(-12).join("\n") };
}

function tradeTime(trade) {
  return trade.exitTime || trade.time || trade.setupTime || "";
}

function monthKey(trade) {
  return tradeTime(trade).slice(0, 7) || "unknown";
}

function yearKey(trade) {
  return tradeTime(trade).slice(0, 4) || "unknown";
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

function byPairAndModule(trades) {
  const rows = new Map();
  for (const trade of trades) {
    const key = `${trade.pair || "unknown"}:${trade.strategy || trade.module || "unknown"}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(trade);
  }
  return Array.from(rows.entries())
    .map(([key, grouped]) => {
      const [pair, module] = key.split(":");
      return { pair, module, ...summarizeTrades(grouped) };
    })
    .sort((a, b) => a.module.localeCompare(b.module) || a.pair.localeCompare(b.pair));
}

function maxDrawdownFromTrades(trades) {
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...trades].sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)))) {
    equity += Number(trade.profit || 0);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
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
  return periodDistribution(trades, monthKey, "month");
}

function yearlyDistribution(trades) {
  return periodDistribution(trades, yearKey, "year");
}

function periodDistribution(trades, keyFn, keyName) {
  const byMonth = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!byMonth.has(key)) byMonth.set(key, { [keyName]: key, trades: 0, wins: 0, losses: 0, net: 0 });
    const row = byMonth.get(key);
    const profit = Number(trade.profit || 0);
    row.trades += 1;
    row.net += profit;
    if (profit > 0) row.wins += 1;
    else row.losses += 1;
  }
  return Array.from(byMonth.values())
    .sort((a, b) => a[keyName].localeCompare(b[keyName]))
    .map(row => ({ ...row, winRate: row.trades ? row.wins / row.trades * 100 : 0 }));
}

function summarizePeriodStability(rows, keyName) {
  const activeRows = rows.filter(row => row.trades > 0);
  const positive = activeRows.filter(row => row.net > 0);
  const negative = activeRows.filter(row => row.net < 0);
  const worst = [...activeRows].sort((a, b) => a.net - b.net)[0] ?? null;
  const best = [...activeRows].sort((a, b) => b.net - a.net)[0] ?? null;
  return {
    periods: activeRows.length,
    positivePeriods: positive.length,
    negativePeriods: negative.length,
    positiveRate: activeRows.length ? positive.length / activeRows.length * 100 : 0,
    worstPeriod: worst ? { period: worst[keyName], net: worst.net, trades: worst.trades, winRate: worst.winRate } : null,
    bestPeriod: best ? { period: best[keyName], net: best.net, trades: best.trades, winRate: best.winRate } : null,
  };
}

function markdownMonthlyTable(rows) {
  return [
    "| Month | Trades | Win rate | Net |",
    "|---|---:|---:|---:|",
    ...rows.map(row => `| ${row.month} | ${row.trades} | ${pct(row.winRate)} | ${money(row.net)} |`),
  ].join("\n");
}

function markdownBreakdownTable(rows) {
  return [
    "| Pair | Module | Trades | Win rate | Net | PF | Expectancy |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...rows.map(row => `| ${row.pair} | \`${row.module}\` | ${row.trades} | ${pct(row.winRate)} | ${money(row.net)} | ${Number(row.profitFactor).toFixed(3)} | ${money(row.expectancy)} |`),
  ].join("\n");
}

function markdownStabilityTable(rows) {
  return [
    "| Profile | Trades | Net | PF | Max DD | Max losses | Positive months | Worst month | Positive years | Worst year |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(row => `| ${row.profile} | ${row.trades.trades} | ${money(row.trades.net)} | ${Number(row.trades.profitFactor).toFixed(3)} | ${money(row.maxDrawdown)} | ${row.trades.maxConsecutiveLosses} | ${row.monthly.positivePeriods}/${row.monthly.periods} (${pct(row.monthly.positiveRate)}) | ${row.monthly.worstPeriod?.period ?? "n/a"} ${money(row.monthly.worstPeriod?.net ?? 0)} | ${row.yearly.positivePeriods}/${row.yearly.periods} (${pct(row.yearly.positiveRate)}) | ${row.yearly.worstPeriod?.period ?? "n/a"} ${money(row.yearly.worstPeriod?.net ?? 0)} |`),
  ].join("\n");
}

function robustnessVerdict({ addedTrades, addedNet, combined, nyStability, leakagePassed }) {
  const drawdownDelta = combined.maxDrawdown - nyStability.maxDrawdown;
  const lossStreakDelta = combined.trades.maxConsecutiveLosses - nyStability.trades.maxConsecutiveLosses;
  const positiveTradeExpansion = addedTrades > 0 && addedNet > 0;
  const acceptableDrawdownExpansion = drawdownDelta <= Math.max(50, nyStability.maxDrawdown * 0.25);
  const acceptableLossStreakExpansion = lossStreakDelta <= 3;
  const acceptableMonthStability = combined.monthly.positiveRate >= 55;
  const passed = positiveTradeExpansion && acceptableDrawdownExpansion && acceptableLossStreakExpansion && acceptableMonthStability && leakagePassed;
  return {
    passed,
    drawdownDelta,
    lossStreakDelta,
    checks: {
      positiveTradeExpansion,
      acceptableDrawdownExpansion,
      acceptableLossStreakExpansion,
      acceptableMonthStability,
      leakagePassed,
    },
    label: passed ? "PASS — robust enough for monitor/demo validation" : "WATCH — needs more filtering before live auto-execution",
  };
}

function main() {
  fs.mkdirSync("analysis", { recursive: true });
  console.log("Running selected NY + London combined profile backtests...");
  const datasets = Object.fromEntries(CASES.map(testCase => {
    console.log(`Running ${testCase.label}...`);
    return [testCase.key, runBacktest(testCase)];
  }));

  const nyTrades = (datasets.ny_selected.trades || []).map(trade => ({ ...trade, module: "ny_asian_continuation" }));
  const londonTrades = (datasets.london_selected.trades || []).map(trade => ({ ...trade, module: "london_asian_fake_break_reversal" }));
  const combinedTrades = (datasets.combined_selected.trades || [])
    .map(trade => ({ ...trade, module: trade.strategy || "unknown" }))
    .sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));
  const ny = summarizeTrades(nyTrades);
  const london = summarizeTrades(londonTrades);
  const combinedTradeStats = summarizeTrades(combinedTrades);
  const monthly = monthlyDistribution(combinedTrades);
  const yearly = yearlyDistribution(combinedTrades);
  const positiveMonths = monthly.filter(row => row.net > 0).length;
  const negativeMonths = monthly.filter(row => row.net < 0).length;
  const moduleBreakdown = byPairAndModule(combinedTrades);
  const nyStability = {
    profile: "NY only",
    trades: ny,
    maxDrawdown: maxDrawdownFromTrades(nyTrades),
    monthly: summarizePeriodStability(monthlyDistribution(nyTrades), "month"),
    yearly: summarizePeriodStability(yearlyDistribution(nyTrades), "year"),
  };
  const londonStability = {
    profile: "London selected",
    trades: london,
    maxDrawdown: maxDrawdownFromTrades(londonTrades),
    monthly: summarizePeriodStability(monthlyDistribution(londonTrades), "month"),
    yearly: summarizePeriodStability(yearlyDistribution(londonTrades), "year"),
  };
  const combinedStability = {
    profile: "Combined",
    trades: combinedTradeStats,
    maxDrawdown: maxDrawdownFromTrades(combinedTrades),
    monthly: summarizePeriodStability(monthly, "month"),
    yearly: summarizePeriodStability(yearly, "year"),
  };
  const stabilityRows = [nyStability, londonStability, combinedStability];
  const combinedDrawdown = combinedStability.maxDrawdown;
  const addedTrades = combinedTradeStats.trades - ny.trades;
  const addedNet = combinedTradeStats.net - ny.net;
  const tradeIncreasePct = ny.trades ? addedTrades / ny.trades * 100 : 0;
  const selectedLondonLeakage = moduleBreakdown
    .filter(row => row.module === "london_asian_fake_break_reversal" && !SELECTED_PROFILE.londonPairs.includes(row.pair));
  const leakageVerdict = selectedLondonLeakage.length === 0
    ? "PASS — combined London trades only appear on selected London pairs"
    : `FAIL — unexpected London trades found on ${selectedLondonLeakage.map(row => row.pair).join(", ")}`;
  const robustness = robustnessVerdict({
    addedTrades,
    addedNet,
    combined: combinedStability,
    nyStability,
    leakagePassed: selectedLondonLeakage.length === 0,
  });

  const md = `# Selected Combined Research Profile

Generated: ${new Date().toISOString()}

## Selected profile

| Field | Value |
|---|---|
| NY module | \`ny_asian_continuation\` current basket |
| London module | \`london_asian_fake_break_reversal\` Candidate B |
| London pairs | \`EUR_USD,USD_JPY\` |
| London window | \`07:00–09:00 UTC\` |
| London brake | \`LONDON_MAX_LOSSES_PER_DAY=1\` |
| Live status | Monitor/demo first; no live auto-execute yet |

## Backtest result

| Metric | NY only | London only | Combined |
|---|---:|---:|---:|
| Pairs | \`${SELECTED_PROFILE.nyPairs.join(",")}\` | \`${SELECTED_PROFILE.londonPairs.join(",")}\` | \`${SELECTED_PROFILE.nyPairs.join(",")}\` |
| Trades | ${ny.trades} | ${london.trades} | ${combinedTradeStats.trades} |
| Win rate | ${pct(ny.winRate)} | ${pct(london.winRate)} | ${pct(combinedTradeStats.winRate)} |
| Net | ${money(ny.net)} | ${money(london.net)} | ${money(combinedTradeStats.net)} |
| Profit factor | ${Number(ny.profitFactor).toFixed(3)} | ${Number(london.profitFactor).toFixed(3)} | ${Number(combinedTradeStats.profitFactor).toFixed(3)} |
| Expectancy | ${money(ny.expectancy)} | ${money(london.expectancy)} | ${money(combinedTradeStats.expectancy)} |
| Trade-level max DD | ${money(maxDrawdownFromTrades(nyTrades))} | ${money(maxDrawdownFromTrades(londonTrades))} | ${money(combinedDrawdown)} |

## Trade-count increase ranking

| Candidate | Added trades vs NY | Trade increase | Added net vs NY | Verdict |
|---|---:|---:|---:|---|
| Selected London module | +${addedTrades} | ${pct(tradeIncreasePct)} | ${money(addedNet)} | ${robustness.label} |

Allowed-pair leakage check: **${leakageVerdict}**.

## Robustness ranking

${markdownStabilityTable(stabilityRows)}

Robustness checks:

| Check | Result |
|---|---|
| Added trades and net are positive | ${robustness.checks.positiveTradeExpansion ? "PASS" : "FAIL"} |
| Drawdown expansion vs NY is acceptable | ${robustness.checks.acceptableDrawdownExpansion ? "PASS" : "WATCH"} (${money(robustness.drawdownDelta)}) |
| Loss-streak expansion vs NY is acceptable | ${robustness.checks.acceptableLossStreakExpansion ? "PASS" : "WATCH"} (+${robustness.lossStreakDelta}) |
| Combined positive-month rate >= 55% | ${robustness.checks.acceptableMonthStability ? "PASS" : "WATCH"} (${pct(combinedStability.monthly.positiveRate)}) |
| London allowed-pair leakage absent | ${robustness.checks.leakagePassed ? "PASS" : "FAIL"} |
| Overall | **${robustness.label}** |

## Combined trade-level metrics

These metrics come from the direct \`combined_ny_london\` backtest, not from manually merging separate result files.

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

## Combined module breakdown

${markdownBreakdownTable(moduleBreakdown)}

## Monthly distribution of combined profits

${markdownMonthlyTable(monthly)}

## Decision

This is the current working combined research candidate only if the added-trade row remains positive and the leakage check passes after future data refreshes.

Continue with:

\`\`\`bash
npm run research:combined:selected
npm run start:london
\`\`\`

Do **not** enable London live execution until monitor-only/demo validation has collected enough sessions.
`;

  fs.writeFileSync(REPORT_MD, md);
  fs.writeFileSync(SELECTED_JSON, JSON.stringify({
    generatedAtUTC: new Date().toISOString(),
    selected: SELECTED_PROFILE,
    cases: CASES,
    ny,
    london,
    combinedTradeStats,
    combinedDrawdown,
    robustness,
    stability: {
      ny: nyStability,
      london: londonStability,
      combined: combinedStability,
    },
    tradeCountIncrease: {
      addedTrades,
      tradeIncreasePct,
      addedNet,
      leakageVerdict,
      selectedLondonLeakage,
    },
    moduleBreakdown,
    monthlyDistribution: monthly,
    yearlyDistribution: yearly,
    datasetFiles: Object.fromEntries(CASES.map(testCase => [testCase.key, `analysis/${testCase.key}.json`])),
  }, null, 2));
  console.log(`\nSelected combined profile`);
  console.log(`NY trades: ${ny.trades} | London trades: ${london.trades} | Combined trades: ${combinedTradeStats.trades}`);
  console.log(`Added trades vs NY: +${addedTrades} (${pct(tradeIncreasePct)}) | Added net: ${money(addedNet)}`);
  console.log(`Combined net: ${money(combinedTradeStats.net)} | Trade-level DD: ${money(combinedDrawdown)} | London net: ${money(london.net)}`);
  console.log(`Combined win rate: ${pct(combinedTradeStats.winRate)} | Combined PF: ${Number(combinedTradeStats.profitFactor).toFixed(3)} | Max consecutive losses: ${combinedTradeStats.maxConsecutiveLosses}`);
  console.log(`Robustness: ${robustness.label}`);
  console.log(`Allowed-pair leakage check: ${leakageVerdict}`);
  console.log(`Saved ${REPORT_MD}`);
  console.log(`Saved ${SELECTED_JSON}`);
}

main();
