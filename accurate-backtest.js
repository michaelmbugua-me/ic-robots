/**
 * Accurate Backtest Orchestrator
 *
 * Downloads tick data, validates coverage, then runs a strict tick-mode backtest.
 */
import { spawnSync } from "child_process";

const FX_PAIRS = ["EUR_USD", "GBP_USD", "USD_JPY"];
const GOLD_PAIRS = ["XAU_USD"];
const ALL_PAIRS = [...GOLD_PAIRS, ...FX_PAIRS];

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
  --preset gold|gold-fixed|ny|all   Backtest preset to run. Default: gold
  --pair XAU_USD                    Download/validate one pair instead of preset pairs
  --pairs XAU_USD,EUR_USD           Download/validate custom pairs instead of preset pairs
  --from YYYY-MM-DD                 Inclusive UTC start
  --to YYYY-MM-DD                   Exclusive UTC end
  --fixed-balance 1191.99           Use fixed-balance sizing
  --report                          Generate report.html after single-preset backtests
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

function pairsForPreset(preset) {
  if (preset === "gold" || preset === "gold-fixed") return GOLD_PAIRS;
  if (preset === "ny") return FX_PAIRS;
  if (preset === "all") return ALL_PAIRS;
  fail(`Unknown --preset '${preset}'.`);
}

function backtestScriptForPreset(preset) {
  if (preset === "gold" || preset === "gold-fixed") return "backtest:gold";
  if (preset === "ny") return "backtest:ny";
  if (preset === "all") return "backtest:all";
  fail(`Unknown --preset '${preset}'.`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
  process.exit(0);
}

const preset = String(argValue("--preset", argValue("--target", "gold"))).toLowerCase();
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

const fixedBalance = argValue("--fixed-balance", preset === "gold-fixed" ? "1191.99" : null);
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

run("npm", ["run", backtestScriptForPreset(preset)], { env });

if (hasFlag("--report") && preset !== "all") {
  run(process.execPath, ["generate-report.js"]);
}
