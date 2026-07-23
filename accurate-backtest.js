/**
 * Accurate Backtest Orchestrator
 *
 * Downloads tick data, validates coverage, then runs a strict tick-mode backtest.
 */
import { spawnSync } from "child_process";
import fs from "fs";

const FX_PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const GOLD_PAIRS = ["XAU_USD"];
const ALL_PAIRS = [...GOLD_PAIRS, ...FX_PAIRS];

// Base strategy/session env for each preset, mirroring the `backtest:gold` /
// `backtest:fx` npm scripts. Kept here (rather than relying on the
// package.json script strings) so BACKTEST_START_DATE/END_DATE/FIXED_BALANCE
// overrides from this CLI always take effect: npm script strings assign
// their own env vars inline, which otherwise shadow anything passed in via
// spawnSync's `env` option for that same variable name.
const GOLD_ENV = {
  TRADING_PAIRS: "XAU_USD",
  STRATEGY_MODE: "ny_asian_continuation",
  SESSION_WINDOW_MODE: "all_windows",
  NY_ASIAN_ALLOWED_SESSIONS: "london_open,ny_overlap",
  NY_ASIAN_MAX_TRADES_PER_SESSION: "2",
  NY_ASIAN_MIN_BREAK_PIPS: "100",
  NY_ASIAN_ENTRY_BUFFER_PIPS: "10",
  NY_ASIAN_STOP_BUFFER_PIPS: "10",
  NY_ASIAN_MIN_RISK_PIPS: "200",
  NY_ASIAN_MAX_RISK_PIPS: "2000",
  NY_ASIAN_RR_RATIO: "3.0",
  NY_ASIAN_REQUIRE_H1_ALIGNMENT: "false",
  NY_ASIAN_TRADE_START_UTC: "7",
  NY_ASIAN_TRADE_END_UTC: "16",
  NY_ASIAN_FORCE_EXIT_UTC: "16",
  NY_ASIAN_PREFER_AFTER_UTC: "7",
  BACKTEST_SPREAD_PIPS: "40",
  BACKTEST_SLIPPAGE_PIPS: "5",
};
// Matches the live `ic-scalping-bot` FX PM2 process (ecosystem.config.cjs):
// combined_ny_london runs NY Asian continuation outside London hours and the
// London Asian fake-break reversal strategy during the London window.
const FX_ENV = {
  TRADING_PAIRS: "EUR_USD,GBP_USD,USD_JPY",
  STRATEGY_MODE: "combined_ny_london",
  SESSION_WINDOW_MODE: "all_windows",
  LONDON_MONITOR_ENABLED: "true",
  LONDON_LIVE_EXECUTION_ENABLED: "true",
  LONDON_FAKE_BREAK_ALLOWED_PAIRS: "EUR_USD,USD_JPY",
  LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS: "Tue,Wed,Thu",
  LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS: "EUR_USD:Thu",
  LONDON_FAKE_BREAK_TRADE_END_UTC: "9.0",
  LONDON_MAX_LOSSES_PER_DAY: "1",
  LONDON_FAKE_BREAK_TARGET_MODE: "asian_opposite",
};

const args = process.argv.slice(2);

function argValue(name, fallback = null) {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function printHelp() {
  console.log(`
Usage:
  npm run backtest:accurate -- --preset gold --from 2020-01-01 --to 2020-01-08

Options:
  --preset gold|gold-fixed|fx|fx-fixed|ny|ny-fixed|all
                                     Backtest preset to run. Default: gold
                                     (ny is an alias for fx, kept for backward compatibility)
  --pair XAU_USD                    Download/validate one pair instead of preset pairs
  --pairs XAU_USD,EUR_USD           Download/validate custom pairs instead of preset pairs
  --from YYYY-MM-DD                 Inclusive UTC start
  --to YYYY-MM-DD                   Exclusive UTC end
  --fixed-balance 1191.99           Use fixed-balance sizing
  --report                          Generate report.html after the backtest
  --fallback                        Allow M5 fallback if ticks are missing
  --skip-download                   Reuse existing tick cache
  --skip-validate                   Skip tick coverage validation
  --force                           Redownload and overwrite/merge cached tick days
`);
}

function fail(message) {
  console.error(`\nERROR: ${message}`);
  printHelp();
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  console.log(`\n$ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function normalizePreset(preset) {
  if (preset === "ny") return "fx";
  if (preset === "ny-fixed") return "fx-fixed";
  return preset;
}

function pairsForPreset(preset) {
  if (preset === "gold" || preset === "gold-fixed") return GOLD_PAIRS;
  if (preset === "fx" || preset === "fx-fixed") return FX_PAIRS;
  if (preset === "all") return ALL_PAIRS;
  fail(`Unknown --preset '${preset}'.`);
}

function baseEnvForPreset(preset) {
  if (preset === "gold" || preset === "gold-fixed") return GOLD_ENV;
  if (preset === "fx" || preset === "fx-fixed") return FX_ENV;
  fail(`Unknown --preset '${preset}'.`);
}

function runBacktest(preset, env) {
  run(process.execPath, ["--max-old-space-size=8192", "backtest-multi.js"], { env: { ...baseEnvForPreset(preset), ...env } });
}

if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
  process.exit(0);
}

const preset = normalizePreset(String(argValue("--preset", argValue("--target", "gold"))).toLowerCase());
const from = argValue("--from");
const to = argValue("--to");
if (!from || !to) fail("Both --from and --to are required.");

const fromMs = new Date(from).getTime();
const toMs = new Date(to).getTime();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
  fail("Invalid --from/--to range. Remember --to is exclusive.");
}

const customPairs = argValue("--pairs", argValue("--pair", null));
const pairs = (customPairs ? customPairs.split(",").map(p => p.trim()).filter(Boolean) : pairsForPreset(preset));
if (pairs.length === 0) fail("No pairs selected.");

const fixedBalance = argValue("--fixed-balance", (preset === "gold-fixed" || preset === "fx-fixed") ? "1191.99" : null);
const strictMode = hasFlag("--fallback") ? "fallback" : "strict";

console.log(`
Accurate backtest
  Preset : ${preset}
  Pairs  : ${pairs.join(", ")}
  From   : ${new Date(fromMs).toISOString()}
  To     : ${new Date(toMs).toISOString()} (exclusive)
  Ticks  : ${strictMode}
`);

if (!hasFlag("--skip-download")) {
  const downloadArgs = [
    "download-ticks.js",
    "--pairs", pairs.join(","),
    "--from", from,
    "--to", to,
  ];
  if (hasFlag("--force")) downloadArgs.push("--force");
  run(process.execPath, downloadArgs);
}

if (!hasFlag("--skip-validate")) {
  const validateArgs = [
    "validate-tick-cache.js",
    "--pairs", pairs.join(","),
    "--from", from,
    "--to", to,
  ];
  if (hasFlag("--fallback")) validateArgs.push("--no-fail");
  run(process.execPath, validateArgs);
}

const env = {
  BACKTEST_INTRABAR_MODE: "tick",
  BACKTEST_TICK_MISSING: strictMode,
  BACKTEST_START_DATE: from,
  BACKTEST_END_DATE: to,
};
if (fixedBalance) env.BACKTEST_FIXED_BALANCE_USD = fixedBalance;

if (preset === "all") {
  runBacktest("fx", env);
  fs.copyFileSync("trades_backtest.json", "trades_backtest_fx.json");
  runBacktest("gold", env);
  fs.copyFileSync("trades_backtest.json", "trades_backtest_gold.json");
  run(process.execPath, ["generate-report-data.js"]);
  run(process.execPath, ["build-report.cjs"]);
} else {
  runBacktest(preset, env);
  if (hasFlag("--report")) {
    run(process.execPath, ["generate-report.js"]);
  }
}
