/**
 * Tick Cache Validator — checks daily tick cache coverage against local M5 history.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { TickDatabase } from "./tick-db.js";
import { getPipSize } from "./instrument-utils.js";

const args = process.argv.slice(2);
const DEFAULT_CACHE_DIR = "data/ticks";
const M5_MS = 300_000;

function argValue(name, fallback = null) {
  const eq = args.find(a => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

const pairs = (argValue("--pairs", argValue("--pair", "XAU_USD")) || "")
  .split(",")
  .map(p => p.trim())
  .filter(Boolean);
const fromArg = argValue("--from");
const toArg = argValue("--to");
const cacheDir = argValue("--cache-dir", DEFAULT_CACHE_DIR);
const tolerancePips = Number(argValue("--tolerance-pips", "1"));
const noFail = hasFlag("--no-fail");
const backtestTickSource = process.env.BACKTEST_TICK_SOURCE || "sqlite";

let TICK_DB = null;
if (backtestTickSource === "sqlite") {
  try {
    TICK_DB = new TickDatabase();
  } catch (err) {
    console.warn(`  ⚠️  Failed to initialize SQLite tick database for validation: ${err.message}.`);
  }
}

if (!fromArg || !toArg) {
  console.error("Usage: node validate-tick-cache.js --pairs XAU_USD,EUR_USD --from 2026-07-17 --to 2026-07-18");
  process.exit(1);
}

const fromMs = new Date(fromArg).getTime();
const toMs = new Date(toArg).getTime();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
  console.error("Invalid --from/--to range.");
  process.exit(1);
}

function pairKey(pair) {
  return pair.replace("/", "_");
}

function readTickDay(pair, day) {
  const file = path.join(cacheDir, pairKey(pair), `${day}.json.gz`);
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
  return {
    coverage: Array.isArray(data.coverage) ? data.coverage : [],
    ticks: Array.isArray(data.ticks) ? data.ticks.map(t => ({
      timestamp: Number(t.timestamp ?? new Date(t.time).getTime()),
      bid: Number(t.bid),
      ask: Number(t.ask),
    })).filter(t => Number.isFinite(t.timestamp) && Number.isFinite(t.bid) && Number.isFinite(t.ask)) : [],
  };
}

function isCovered(dayData, startMs, endMs) {
  return dayData?.coverage?.some(r => Number(r.from) <= startMs && Number(r.to) >= endMs) ?? false;
}

function candleBid(candle) {
  const source = candle.bid ?? candle.mid;
  if (!source) return null;
  return {
    o: Number(source.o),
    h: Number(source.h),
    l: Number(source.l),
    c: Number(source.c),
  };
}

function tickOhlc(ticks) {
  const bids = ticks.map(t => t.bid);
  return {
    o: bids[0],
    h: Math.max(...bids),
    l: Math.min(...bids),
    c: bids[bids.length - 1],
  };
}

function maxDiff(a, b) {
  return Math.max(
    Math.abs(a.o - b.o),
    Math.abs(a.h - b.h),
    Math.abs(a.l - b.l),
    Math.abs(a.c - b.c),
  );
}

let hasProblems = false;

for (const pair of pairs) {
  const historyFile = `history_${pairKey(pair)}.json`;
  if (!fs.existsSync(historyFile)) {
    console.warn(`⚠️  ${pair}: missing ${historyFile}`);
    hasProblems = true;
    continue;
  }

  const pipSize = getPipSize(pair);
  const tolerance = Math.max(0, tolerancePips) * pipSize;
  const history = JSON.parse(fs.readFileSync(historyFile, "utf8"))
    .filter(c => {
      const t = new Date(c.time).getTime();
      return t >= fromMs && t < toMs;
    });

  const dayCache = new Map();
  const getDay = (day) => {
    if (!dayCache.has(day)) dayCache.set(day, readTickDay(pair, day));
    return dayCache.get(day);
  };

  const stats = {
    candles: history.length,
    covered: 0,
    missingCoverage: 0,
    emptyTicks: 0,
    mismatchedOhlc: 0,
    maxDiffPips: 0,
  };

  for (const candle of history) {
    const start = new Date(candle.time).getTime();
    const end = start + M5_MS;

    let ticks = [];
    if (TICK_DB) {
      ticks = TICK_DB.getTicks(pair, start, end);
    }

    if (ticks.length === 0) {
      const day = new Date(start).toISOString().slice(0, 10);
      const dayData = getDay(day);
      if (!isCovered(dayData, start, end)) {
        stats.missingCoverage += 1;
        continue;
      }
      ticks = dayData.ticks.filter(t => t.timestamp >= start && t.timestamp < end);
    }

    if (ticks.length === 0) {
      stats.emptyTicks += 1;
      continue;
    }

    stats.covered += 1;
    const expected = candleBid(candle);
    if (!expected) continue;
    const diff = maxDiff(expected, tickOhlc(ticks));
    stats.maxDiffPips = Math.max(stats.maxDiffPips, diff / pipSize);
    if (diff > tolerance) stats.mismatchedOhlc += 1;
  }

  if (stats.missingCoverage > 0 || stats.emptyTicks > 0 || stats.mismatchedOhlc > 0) hasProblems = true;
  console.log(`${pair}: candles=${stats.candles} covered=${stats.covered} missing=${stats.missingCoverage} empty=${stats.emptyTicks} mismatched=${stats.mismatchedOhlc} maxDiffPips=${stats.maxDiffPips.toFixed(2)}`);
}

if (hasProblems && !noFail) process.exit(1);
