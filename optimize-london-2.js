import fs from "fs";
import { spawnSync } from "child_process";

const runs = [];

// Run 1: Wednesday-only (THIS was the 48-trade $213 winner)
runs.push({
  key: "wed_only_classic",
  label: "Wed only, 07-09, Asian opposite TP, max 1 loss",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Run 2: Wed-only + drop 07:00 hour
runs.push({
  key: "wed_8_9",
  label: "Wed only, 08-09 only, Asian opposite TP",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_FAKE_BREAK_TRADE_START_UTC: "8",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Run 3: Wed + Thu (drop Tue which has worst WR)
runs.push({
  key: "wed_thu",
  label: "Wed+Thu, 07-09, Asian opposite TP, max 1 loss",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed,Thu",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Run 4: Wed only + time exit (no Asian opposite TP)
runs.push({
  key: "wed_time_exit",
  label: "Wed only, 07-09, time exit, max 1 loss",
  env: {
    TRADING_PAIRS: "EUR_USD,USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_FAKE_BREAK_TARGET_MODE: "time_exit",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Run 5: EUR_USD only - check if a specific pair works better
runs.push({
  key: "eur_usd_only",
  label: "EUR_USD only, Wed, 07-09, max 1 loss",
  env: {
    TRADING_PAIRS: "EUR_USD",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

// Run 6: USD_JPY only
runs.push({
  key: "usd_jpy_only",
  label: "USD_JPY only, Wed, 07-09, max 1 loss",
  env: {
    TRADING_PAIRS: "USD_JPY",
    STRATEGY_MODE: "london_asian_fake_break_reversal",
    SESSION_WINDOW_MODE: "london_only",
    LONDON_FAKE_BREAK_PROFILE: "candidate_b",
    LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Wed",
    LONDON_FAKE_BREAK_TRADE_END_UTC: "9",
    LONDON_MAX_LOSSES_PER_DAY: "1",
  },
});

function runBacktest(env, label) {
  const result = spawnSync("node", ["backtest-multi.js"], {
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120000,
  });

  const output = result.stdout + result.stderr;
  const finalLine = output.match(/FINAL:[^$]*\$([\d.]+).*Trades:\s*(\d+).*Win Rate:\s*([\d.]+)%/);
  const pairLines = [];
  const pairRegex = /(.{8})\s+Trades:\s*(\d+)\s+\|\s+Win:\s*([\d.]+)%\s+\|\s+PF:\s*([\d.]+|∞)\s+\|\s+Net:\s*\$?(-?[\d.]+)/g;
  let m;
  while ((m = pairRegex.exec(output)) !== null) {
    pairLines.push({ pair: m[1].trim(), trades: parseInt(m[2]), winRate: parseFloat(m[3]), pf: m[4], net: parseFloat(m[5]) });
  }

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
  } catch (e) {}

  return {
    label,
    finalBalance: finalLine ? parseFloat(finalLine[1]) : null,
    totalTrades: finalLine ? parseInt(finalLine[2]) : 0,
    winRate: finalLine ? parseFloat(finalLine[3]) : 0,
    pairs: pairLines,
    tradesData,
  };
}

console.log("═".repeat(70));
console.log("LONDON OPTIMIZATION — TARGETED RUNS");
console.log("═".repeat(70));

const results = [];
for (const run of runs) {
  console.log(`\n--- ${run.label} ---`);
  const r = runBacktest(run.env, run.label);
  results.push(r);
  console.log(`  Trades: ${r.totalTrades} | WR: ${r.winRate}% | Bal: $${(r.finalBalance||0).toFixed(2)}`);
  for (const p of r.pairs) {
    console.log(`    ${p.pair}: ${p.trades}T ${p.winRate}%WR PF:${p.pf} Net:$${p.net.toFixed(2)}`);
  }
  if (r.tradesData?.exitAnalysis) {
    Object.entries(r.tradesData.exitAnalysis).forEach(([reason, d]) => {
      console.log(`    ${reason}: ${d.count}T ${d.wins}W Net:$${d.net.toFixed(2)}`);
    });
  }
}

console.log("\n" + "═".repeat(70));
console.log("SUMMARY");
console.log("═".repeat(70));
console.log(`  ${"Variant".padEnd(35)} | ${"Trades".padEnd(6)} | ${"WR".padEnd(6)} | Bal$`);
console.log("─".repeat(70));
for (const r of results) {
  console.log(`  ${r.label.padEnd(35)} | ${String(r.totalTrades).padEnd(6)} | ${r.winRate.toFixed(1).padEnd(6)} | $${(r.finalBalance||0).toFixed(2)}`);
}
console.log("═".repeat(70));
