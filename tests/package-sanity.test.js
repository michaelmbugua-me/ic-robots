import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../config.js";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const sourceFiles = fs.readdirSync(".").filter(name => /\.(js|cjs)$/.test(name));
const sourceText = sourceFiles.map(name => fs.readFileSync(name, "utf8")).join("\n");

for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
  for (const match of command.matchAll(/node\s+([^\s&;]+)/g)) {
    assert.ok(fs.existsSync(match[1]), `script ${name} points at missing file ${match[1]}`);
  }
}

assert.ok(pkg.scripts.auto.includes("STRATEGY_MODE=ny_asian_continuation"), "auto script should explicitly use the current strategy");
assert.ok(!pkg.scripts.auto.includes("EMA_SEPARATION_MIN_PIPS"), "auto script should not advertise EMA-only filters for NY Asian mode");
assert.ok(!pkg.scripts["backtest-mock"], "stale backtest-mock script should stay removed");
assert.ok(!pkg.scripts["backtest-multi-mock"], "stale backtest-multi-mock script should stay removed");
assert.deepEqual(config.strategy.supportedModes, ["ny_asian_continuation"], "only the active strategy mode should be supported");
assert.equal(config.backtest.spreadPips, 0.5, "backtest spread default should stay explicit and configurable");
assert.equal(config.backtest.slippagePips, 0.2, "backtest slippage default should stay explicit and configurable");
assert.doesNotMatch(sourceText, /\bema_pullback\b|EMA_SEPARATION_MIN_PIPS|emaSeparationMinPips|generateSignal|detectTrend|hasPullback|hasEarlyTrigger|calcTradeParams/, "removed EMA pullback code should stay removed");
assert.doesNotMatch(sourceText, /config\.strategy\.(nyOrb|sessionSweep|smashBuy|smashSell)/, "removed dormant strategy config refs should stay removed");
assert.doesNotMatch(sourceText, /generate(NYOpeningRange|SessionSweep|Smash)/, "removed dormant strategy functions should stay removed");
assert.doesNotMatch(sourceText, /\b(ny_orb|session_sweep|smash_buy|smash_sell|smash)\b/, "removed dormant strategy mode names should stay removed");

console.log("package sanity tests passed");





