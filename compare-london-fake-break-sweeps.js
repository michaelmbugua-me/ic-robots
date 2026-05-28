#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const KNOWN_VALUE_ARGS = new Set(["--pairs", "--cost-pips", "--min-obs", "--top", "--json-out", "--history-dir"]);

function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function numberArg(name, fallback) {
  const raw = getArg(name, null);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function collectSweepArgs() {
  const args = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (KNOWN_VALUE_ARGS.has(arg)) {
      i++;
      continue;
    }
    if (arg === "--help") continue;
    args.push(arg);
  }
  return args;
}

function fmt(n, d = 2) {
  return Number(n || 0).toFixed(d);
}

function fmtPF(n) {
  return n === Infinity ? "∞" : fmt(n, 2);
}

function keyOf(row) {
  return [
    row.minBreakPips,
    row.confirmBars,
    row.riskBand,
    row.weekdayFilter,
    row.h1Filter,
    row.direction,
    row.target,
  ].join("|");
}

function labelOf(row) {
  return `break=${row.minBreakPips} confirm=${row.confirmBars} risk=${row.riskBand} days=${row.weekdayFilter} h1=${row.h1Filter} dir=${row.direction} target=${row.target}`;
}

function summarizeCommonRows(pairRows, pairs) {
  const byKey = new Map();
  for (const [pair, rows] of Object.entries(pairRows)) {
    for (const row of rows) {
      const key = keyOf(row);
      if (!byKey.has(key)) byKey.set(key, { template: row, byPair: {} });
      byKey.get(key).byPair[pair] = row;
    }
  }

  return Array.from(byKey.values())
    .filter(item => pairs.every(pair => item.byPair[pair]))
    .map(item => {
      const rows = pairs.map(pair => item.byPair[pair]);
      const avgNetValues = rows.map(r => r.avgNetPips);
      const pfValues = rows.map(r => r.profitFactor);
      const winValues = rows.map(r => r.winRate);
      const totalN = rows.reduce((sum, r) => sum + r.n, 0);
      const positivePairs = rows.filter(r => r.avgNetPips > 0).length;
      const minAvgNet = Math.min(...avgNetValues);
      const avgNet = avgNetValues.reduce((a, b) => a + b, 0) / rows.length;
      const minPF = Math.min(...pfValues);
      const avgPF = pfValues.reduce((a, b) => a + b, 0) / rows.length;
      const avgWin = winValues.reduce((a, b) => a + b, 0) / rows.length;
      return {
        ...item.template,
        label: labelOf(item.template),
        totalN,
        positivePairs,
        minAvgNet,
        avgNet,
        minPF,
        avgPF,
        avgWin,
        score: minAvgNet * Math.sqrt(totalN),
        byPair: item.byPair,
      };
    })
    .sort((a, b) => {
      if (b.positivePairs !== a.positivePairs) return b.positivePairs - a.positivePairs;
      if (Math.abs(b.minAvgNet - a.minAvgNet) > 1e-9) return b.minAvgNet - a.minAvgNet;
      if (Math.abs(b.avgNet - a.avgNet) > 1e-9) return b.avgNet - a.avgNet;
      return b.totalN - a.totalN;
    });
}

function printRows(title, rows, pairs, limit) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.table(rows.slice(0, limit).map(row => {
    const out = {
      minBreak: row.minBreakPips,
      confirm: row.confirmBars,
      risk: row.riskBand,
      days: row.weekdayFilter,
      h1: row.h1Filter,
      dir: row.direction,
      target: row.target,
      totalN: row.totalN,
      posPairs: `${row.positivePairs}/${pairs.length}`,
      minAvg: fmt(row.minAvgNet, 2),
      avgNet: fmt(row.avgNet, 2),
      minPF: fmtPF(row.minPF),
      avgPF: fmtPF(row.avgPF),
      avgWin: `${fmt(row.avgWin, 1)}%`,
    };
    for (const pair of pairs) {
      out[pair] = `${fmt(row.byPair[pair].avgNetPips, 2)}p PF${fmtPF(row.byPair[pair].profitFactor)} n${row.byPair[pair].n}`;
    }
    return out;
  }));
}

function main() {
  if (process.argv.includes("--help")) {
    console.log(`Usage:\n  node compare-london-fake-break-sweeps.js --pairs EUR_USD,GBP_USD,USD_JPY --min-obs 80 --top 20\n\nAny --sweep-* arguments are passed through to market-regime-analysis.js.`);
    return;
  }

  const pairs = getArg("--pairs", "EUR_USD,GBP_USD,USD_JPY").split(",").map(p => p.trim()).filter(Boolean);
  const historyDir = getArg("--history-dir", ".");
  const costPips = numberArg("--cost-pips", 0.7);
  const minObs = numberArg("--min-obs", 80);
  const top = numberArg("--top", 20);
  const jsonOut = getArg("--json-out", null);
  const sweepArgs = collectSweepArgs();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "london-fake-break-sweep-"));
  const pairRows = {};

  console.log(`London fake-break cross-pair sweep comparison`);
  console.log(`Pairs: ${pairs.join(", ")} | cost=${costPips}p | minObs=${minObs}`);
  if (sweepArgs.length) console.log(`Sweep overrides: ${sweepArgs.join(" ")}`);

  for (const pair of pairs) {
    const file = path.join(historyDir, `history_${pair}.json`);
    if (!fs.existsSync(file)) throw new Error(`Missing history file for ${pair}: ${file}`);
    const outPath = path.join(tmpDir, `${pair}.json`);
    console.log(`  → Sweeping ${pair}...`);
    execFileSync(process.execPath, [
      "market-regime-analysis.js",
      "--london-fake-break-sweep",
      "--pair", pair,
      "--file", file,
      "--cost-pips", String(costPips),
      "--min-obs", String(minObs),
      "--sweep-top", "0",
      "--sweep-json", outPath,
      ...sweepArgs,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 50 * 1024 * 1024 });
    const data = JSON.parse(fs.readFileSync(outPath, "utf8"));
    pairRows[pair] = data.rows;
    console.log(`    ${pair}: ${data.rows.length} rows >= minObs`);
  }

  const commonRows = summarizeCommonRows(pairRows, pairs);
  const robustPositive = commonRows.filter(row => row.positivePairs === pairs.length && row.minAvgNet > 0 && row.minPF > 1);

  console.log(`\nCommon filter sets across all pairs: ${commonRows.length}`);
  console.log(`Robust positive filter sets (avgNet > 0 and PF > 1 on every pair): ${robustPositive.length}`);

  printRows(`Robust positive common rows — top ${top}`, robustPositive, pairs, top);
  printRows(`Best common rows by positive-pair count — top ${top}`, commonRows, pairs, top);

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      generatedAtUTC: new Date().toISOString(),
      pairs,
      params: { costPips, minObs, top, sweepArgs },
      commonRows,
      robustPositive,
    }, null, 2));
    console.log(`\nSaved comparison JSON to ${jsonOut}`);
  }
}

main();

