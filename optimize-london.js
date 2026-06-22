import fs from "fs";
import { spawnSync } from "child_process";

const runs = [];

// Test 1: Current cleaned profile (baseline)
runs.push({
  key: "baseline_cleaned",
  label: "Current cleaned (07-09, Asian opposite TP, max 1 loss)",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 2: Time exit instead of Asian range target
runs.push({
  key: "time_exit",
  label: "Time exit + 08-09 only",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 3: Candidate A profile (already time exit + 3-bar confirmation)
runs.push({
  key: "candidate_a",
  label: "Candidate A (time exit, 3-bar conf, H1 reversal filter)",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_a_time_exit",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 4: Candidate A + 08-09 only
runs.push({
  key: "candidate_a_8_9",
  label: "Candidate A + 08-09 only",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_a_time_exit",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 5: Asian range target + 08-09 only (current but tighter hours)
runs.push({
  key: "asian_opposite_8_9",
  label: "Asian opposite TP + 08-09 only",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 6: Long-only (since BUY had 62.5% WR)
runs.push({
  key: "long_only_8_9",
  label: "BUY only + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_FAKE_BREAK_H1_FILTER: "bull",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 7: Higher min break pips to filter weak breakouts
runs.push({
  key: "min_break_6",
  label: "6p min break + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_MIN_BREAK_PIPS: "6",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 8: Min break 2p to catch more setups
runs.push({
  key: "min_break_2",
  label: "2p min break + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_MIN_BREAK_PIPS: "2",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 9: Wider Asian range filter (15-60 pips)
runs.push({
  key: "asian_range_filter",
  label: "Asian range 15-60p + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_FAKE_BREAK_MIN_ASIAN_RANGE_PIPS: "15",
    LONDON_FAKE_BREAK_MAX_ASIAN_RANGE_PIPS: "60",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 10: Wednesday only (from improvement backtests this looked good)
runs.push({
  key: "wed_only",
  label: "Wed only + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Test 11: Reclaim-inside-range confirmation (must close back inside range after break candle)
runs.push({
  key: "reclaim_inside",
  label: "Reclaim inside range + 08-09 + time exit",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_FAKE_BREAK_MIN_CONFIRMATION_BARS_AFTER_BREAK: "1",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

function runBacktest(env, label) {
  const envVars = { ...process.env, ...env };
  const result = spawnSync("node", ["backtest-multi.js"], {
    env: envVars,
    cwd: process.cwd(),
    encoding: "utf8",
  });

  const output = result.stdout + result.stderr;

  // Parse the results from output
  const finalLine = output.match(/FINAL:[^$]*\$([\d.]+).*Trades:\s*(\d+).*Win Rate:\s*([\d.]+)%/);
  const pairLines = [];
  const pairRegex = /(.{8})\s+Trades:\s*(\d+)\s+\|\s+Win:\s*([\d.]+)%\s+\|\s+PF:\s*([\d.]+|∞)\s+\|\s+Net:\s*\$?(-?[\d.]+)/g;
  let m;
  while ((m = pairRegex.exec(output)) !== null) {
    pairLines.push({ pair: m[1].trim(), trades: parseInt(m[2]), winRate: parseFloat(m[3]), pf: m[4], net: parseFloat(m[5]) });
  }

  // Read the trades_backtest.json for detailed analysis
  let tradesData = null;
  try {
    tradesData = JSON.parse(fs.readFileSync("trades_backtest.json", "utf8"));
    const history = tradesData.trades || [];
    const byExit = {};
    history.forEach(t => {
      const r = t.reason || "UNKNOWN";
      if (!byExit[r]) byExit[r] = { count: 0, wins: 0, net: 0 };
      byExit[r].count++;
      if (t.profit > 0) byExit[r].wins++;
      byExit[r].net += t.profit;
    });
    tradesData.exitAnalysis = byExit;
  } catch (e) { /* ignore */ }

  return {
    label,
    finalBalance: finalLine ? parseFloat(finalLine[1]) : null,
    totalTrades: finalLine ? parseInt(finalLine[2]) : 0,
    winRate: finalLine ? parseFloat(finalLine[3]) : 0,
    pairs: pairLines,
    netProfit: finalLine && tradesData ? parseFloat(finalLine[1]) - 2072.07 : null,
    tradesData,
  };
}

console.log("═".repeat(70));
console.log("LONDON STRATEGY OPTIMIZATION RUN");
console.log("═".repeat(70));

const results = [];
for (const run of runs) {
  console.log(`\n--- ${run.label} ---`);
  const r = runBacktest(run.env, run.label);
  results.push(r);

  console.log(`  Trades: ${r.totalTrades} | WR: ${r.winRate}% | Net: $${(r.netProfit || 0).toFixed(2)}`);
  for (const p of r.pairs) {
    console.log(`    ${p.pair}: ${p.trades}T ${p.winRate}%WR PF:${p.pf} Net:$${p.net.toFixed(2)}`);
  }
  if (r.tradesData?.exitAnalysis) {
    const ex = r.tradesData.exitAnalysis;
    Object.entries(ex).forEach(([reason, d]) => {
      console.log(`    ${reason}: ${d.count}T ${d.wins}W Net:$${d.net.toFixed(2)}`);
    });
  }
}

// Summary table
console.log("\n" + "═".repeat(70));
console.log("SUMMARY");
console.log("═".repeat(70));
console.log(`  ${"Variant".padEnd(35)} | ${"Trades".padEnd(6)} | ${"WR".padEnd(6)} | ${"Net$".padEnd(8)} | PF`);
console.log("─".repeat(70));
for (const r of results) {
  const net = r.netProfit || 0;
  const pf = r.tradesData?.summary?.profitFactor || r.tradesData?.profitFactor || "?";
  console.log(`  ${r.label.padEnd(35)} | ${String(r.totalTrades).padEnd(6)} | ${r.winRate.toFixed(1).padEnd(6)} | $${net.toFixed(2).padStart(6)} | ${typeof pf === 'number' ? pf.toFixed(2) : pf}`);
}
console.log("═".repeat(70));
