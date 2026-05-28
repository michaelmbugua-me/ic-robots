#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const OUTPUT_DIR = "analysis";
const REPORT_JSON = path.join(OUTPUT_DIR, "london_improvement_backtests.json");
const REPORT_MD = path.join(OUTPUT_DIR, "london_improvement_backtests.md");
const LONDON_RISK_FACTOR = Number(process.env.LONDON_RESEARCH_RISK_FACTOR ?? 0.25);

const COST_PROFILE = {
  BACKTEST_SPREAD_PIPS: process.env.BACKTEST_SPREAD_PIPS ?? "0.7",
  BACKTEST_SLIPPAGE_PIPS: process.env.BACKTEST_SLIPPAGE_PIPS ?? "0.3",
};

const nyCase = {
  key: "ny_only",
  label: "NY only",
  env: {
	TRADING_PAIRS: "EUR_USD,GBP_USD,USD_JPY",
	STRATEGY_MODE: "ny_asian_continuation",
	SESSION_WINDOW_MODE: "all_windows",
  },
};

const baseLondonEnv = {
  TRADING_PAIRS: "EUR_USD,USD_JPY",
  STRATEGY_MODE: "london_asian_fake_break_reversal",
  SESSION_WINDOW_MODE: "london_only",
  LONDON_FAKE_BREAK_PROFILE: "candidate_b",
  LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
  LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS: "EUR_USD:Thu",
  LONDON_MAX_LOSSES_PER_DAY: "1",
};

const londonCases = [
  {
	key: "london_25_base",
	label: "NY + London 25%",
	env: {},
	notes: "Current cleaned London profile, scaled to 25% risk in the combined portfolio.",
  },
  {
	key: "london_25_no_thursday",
	label: "NY + London 25% + no Thursday",
	env: { LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Tue,Wed" },
	notes: "Excludes all Thursday London trades, not only EUR_USD Thursday.",
  },
  {
	key: "london_25_wednesday_only",
	label: "NY + London 25% + Wednesday only",
	env: { LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed" },
	notes: "Keeps only Wednesday London setups.",
  },
  {
	key: "london_25_trend_no_fade",
	label: "NY + London 25% + trend no-fade filter",
	env: { LONDON_FAKE_BREAK_NO_FADE_H1_ALIGNED: "true" },
	notes: "Blocks fake-break reversals when the Asian-range break is aligned with H1 trend.",
  },
  {
	key: "london_25_asian_range_filter",
	label: "NY + London 25% + Asian range filter",
	env: {
	  LONDON_FAKE_BREAK_MIN_ASIAN_RANGE_PIPS: process.env.LONDON_RESEARCH_MIN_ASIAN_RANGE_PIPS ?? "15",
	  LONDON_FAKE_BREAK_MAX_ASIAN_RANGE_PIPS: process.env.LONDON_RESEARCH_MAX_ASIAN_RANGE_PIPS ?? "60",
	},
	notes: "Initial range-quality filter: Asian range must be between 15 and 60 pips unless overridden by env.",
  },
  {
	key: "london_25_reclaim_confirmation",
	label: "NY + London 25% + reclaim-inside-range confirmation",
	env: { LONDON_FAKE_BREAK_MIN_CONFIRMATION_BARS_AFTER_BREAK: "1" },
	notes: "Requires the reclaim close to occur after the break candle; same-candle fake breaks are ignored.",
  },
];

function tradeTime(trade) {
  return trade.exitTime || trade.time || trade.setupTime || "";
}

function cloneTrade(trade) {
  return JSON.parse(JSON.stringify(trade));
}

function scaleTrades(trades, factor, moduleName) {
  return trades.map(trade => {
	const out = { ...cloneTrade(trade), module: moduleName, researchRiskFactor: factor };
	for (const key of ["profit", "grossProfit", "commission"]) {
	  if (Number.isFinite(Number(out[key]))) out[key] = Number(out[key]) * factor;
	}
	if (out.dailyRisk) out.dailyRisk = { ...out.dailyRisk, researchScaled: true };
	return out;
  });
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(sum(values.map(value => (value - avg) ** 2)) / (values.length - 1));
}

function maxDrawdown(values) {
  let equity = 0;
  let peak = 0;
  let dd = 0;
  for (const value of values) {
	equity += value;
	peak = Math.max(peak, equity);
	dd = Math.max(dd, peak - equity);
  }
  return dd;
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

function dailyPnl(trades) {
  const map = new Map();
  for (const trade of trades) {
	const day = tradeTime(trade).slice(0, 10);
	if (!day) continue;
	map.set(day, (map.get(day) || 0) + Number(trade.profit || 0));
  }
  return map;
}

function monthlyDistribution(trades) {
  const map = new Map();
  for (const trade of trades) {
	const month = tradeTime(trade).slice(0, 7) || "unknown";
	if (!map.has(month)) map.set(month, { month, trades: 0, wins: 0, losses: 0, net: 0 });
	const row = map.get(month);
	const profit = Number(trade.profit || 0);
	row.trades += 1;
	row.net += profit;
	if (profit > 0) row.wins += 1;
	else row.losses += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month)).map(row => ({
	...row,
	winRate: row.trades ? row.wins / row.trades * 100 : 0,
  }));
}

function summarizeTrades(trades) {
  const sorted = [...trades].sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));
  const profits = sorted.map(trade => Number(trade.profit || 0));
  const wins = profits.filter(value => value > 0);
  const losses = profits.filter(value => value <= 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  return {
	trades: sorted.length,
	wins: wins.length,
	losses: losses.length,
	winRate: sorted.length ? wins.length / sorted.length * 100 : 0,
	grossProfit,
	grossLoss,
	net: sum(profits),
	profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
	expectancy: sorted.length ? sum(profits) / sorted.length : 0,
	maxConsecutiveLosses: maxConsecutiveLosses(sorted),
  };
}

function summarizeDaily(trades) {
  const map = dailyPnl(trades);
  const days = Array.from(map.keys()).sort();
  const values = days.map(day => map.get(day) || 0);
  const activeValues = values.filter(value => value !== 0);
  const avg = mean(activeValues);
  const sd = stddev(activeValues);
  return {
	activeDays: activeValues.length,
	greenDays: activeValues.filter(value => value > 0).length,
	redDays: activeValues.filter(value => value < 0).length,
	net: sum(values),
	avgActiveDay: avg,
	activeDayStdDev: sd,
	activeDaySharpe: sd > 0 ? avg / sd : 0,
	maxDailyLoss: values.length ? Math.min(...values) : 0,
	maxDailyWin: values.length ? Math.max(...values) : 0,
	maxDrawdown: maxDrawdown(values),
  };
}

function runBacktest(testCase) {
  const env = { ...process.env, ...COST_PROFILE, ...testCase.env };
  const run = spawnSync(process.execPath, ["backtest-multi.js"], {
	env,
	encoding: "utf8",
	maxBuffer: 120 * 1024 * 1024,
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

function money(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function metricRow(result) {
  const s = result.combinedTradeStats;
  const d = result.combinedDaily;
  return {
	variant: result.label,
	trades: s.trades,
	winRate: pct(s.winRate),
	net: money(s.net),
	profitFactor: Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(3) : "∞",
	expectancy: money(s.expectancy),
	dailyDD: money(d.maxDrawdown),
	maxDailyLoss: money(d.maxDailyLoss),
	activeSharpe: d.activeDaySharpe.toFixed(3),
  };
}

function makeMarkdown(report) {
  const rows = report.results.map(metricRow);
  return `# London Improvement Backtests

Generated: ${report.generatedAtUTC}

## Assumptions

- NY is run at full current risk.
- London is combined at ${LONDON_RISK_FACTOR * 100}% of current risk by scaling London trade P/L.
- London base profile: Candidate B, EUR_USD + USD_JPY, 07:00–09:00 UTC, EUR_USD:Thu excluded, max 1 London loss/day.
- Asian range filter uses ${report.assumptions.asianRangeFilter.minPips}–${report.assumptions.asianRangeFilter.maxPips} pips for this first pass.

## Combined results

| Variant | Trades | Win rate | Net | PF | Exp/trade | Daily DD | Max daily loss | Active-day Sharpe |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${rows.map(row => `| ${row.variant} | ${row.trades} | ${row.winRate} | ${row.net} | ${row.profitFactor} | ${row.expectancy} | ${row.dailyDD} | ${row.maxDailyLoss} | ${row.activeSharpe} |`).join("\n")}

## London-only contribution at 25% risk

| Variant | Trades | Win rate | Net | PF | Daily DD |
|---|---:|---:|---:|---:|---:|
${report.results.filter(result => result.londonTradeStats).map(result => `| ${result.label.replace("NY + ", "")} | ${result.londonTradeStats.trades} | ${pct(result.londonTradeStats.winRate)} | ${money(result.londonTradeStats.net)} | ${Number.isFinite(result.londonTradeStats.profitFactor) ? result.londonTradeStats.profitFactor.toFixed(3) : "∞"} | ${money(result.londonDaily.maxDrawdown)} |`).join("\n")}

## Notes

${report.results.filter(result => result.notes).map(result => `- **${result.label}**: ${result.notes}`).join("\n")}
`;
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`Running ${nyCase.label}...`);
  const nyData = runBacktest(nyCase);
  const nyTrades = (nyData.trades || []).map(trade => ({ ...cloneTrade(trade), module: "ny_asian_continuation", researchRiskFactor: 1 }));

  const results = [{
	key: "ny_only",
	label: "NY only",
	notes: "Benchmark; no London trades included.",
	env: nyCase.env,
	combinedTradeStats: summarizeTrades(nyTrades),
	combinedDaily: summarizeDaily(nyTrades),
	monthlyDistribution: monthlyDistribution(nyTrades),
  }];

  for (const londonCase of londonCases) {
	console.log(`Running ${londonCase.label}...`);
	const rawLondonData = runBacktest({
	  key: londonCase.key,
	  env: { ...baseLondonEnv, ...londonCase.env },
	});
	const londonTrades = scaleTrades(rawLondonData.trades || [], LONDON_RISK_FACTOR, "london_asian_fake_break_reversal");
	const combinedTrades = [...nyTrades, ...londonTrades].sort((a, b) => new Date(tradeTime(a)) - new Date(tradeTime(b)));

	results.push({
	  key: londonCase.key,
	  label: londonCase.label,
	  notes: londonCase.notes,
	  env: { ...baseLondonEnv, ...londonCase.env },
	  londonRawSummary: rawLondonData.summary,
	  londonTradeStats: summarizeTrades(londonTrades),
	  londonDaily: summarizeDaily(londonTrades),
	  combinedTradeStats: summarizeTrades(combinedTrades),
	  combinedDaily: summarizeDaily(combinedTrades),
	  monthlyDistribution: monthlyDistribution(combinedTrades),
	});
  }

  const report = {
	generatedAtUTC: new Date().toISOString(),
	assumptions: {
	  londonRiskFactor: LONDON_RISK_FACTOR,
	  asianRangeFilter: {
		minPips: Number(londonCases.find(c => c.key === "london_25_asian_range_filter").env.LONDON_FAKE_BREAK_MIN_ASIAN_RANGE_PIPS),
		maxPips: Number(londonCases.find(c => c.key === "london_25_asian_range_filter").env.LONDON_FAKE_BREAK_MAX_ASIAN_RANGE_PIPS),
	  },
	},
	results,
  };

  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD, makeMarkdown(report));

  console.table(results.map(metricRow));
  console.log(`Saved ${REPORT_JSON}`);
  console.log(`Saved ${REPORT_MD}`);
}

main();

