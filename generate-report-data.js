#!/usr/bin/env node
/**
 * Generates /tmp/report_data.json for build-report.cjs
 * Reads trades_backtest_fx.json + trades_backtest_gold.json,
 * computes combined trades with proper shared-balance tracking.
 */
import fs from 'fs';
import { computeRobustnessReport } from './report-metrics.js';

const FX_FILE = 'trades_backtest_fx.json';
const GOLD_FILE = 'trades_backtest_gold.json';
const OUTPUT = '/tmp/report_data.json';

if (!fs.existsSync(FX_FILE) || !fs.existsSync(GOLD_FILE)) {
  console.error('Run backtest first: npm run backtest:all');
  process.exit(1);
}

const fxData = JSON.parse(fs.readFileSync(FX_FILE, 'utf8'));
const goldData = JSON.parse(fs.readFileSync(GOLD_FILE, 'utf8'));

// Sort by exitTime — trades in the JSON files are grouped by pair, not chronologically
const sortByTime = (a, b) => new Date(a.exitTime || a.time || 0) - new Date(b.exitTime || b.time || 0);
const fxTrades = (fxData.trades || []).slice().sort(sortByTime);
const goldTrades = (goldData.trades || []).slice().sort(sortByTime);

// Each strategy's cumulative P&L is tracked independently,
// then combined: balance = initBalance + fxCum + goldCum
const initBal = (fxTrades[0]?.balance ?? 1172) - (fxTrades[0]?.profit ?? 0);

let fxCum = 0;
let goldCum = 0;
const allTrades = [
  ...fxTrades.map(t => ({ ...t, _s: 'fx' })),
  ...goldTrades.map(t => ({ ...t, _s: 'gold' })),
].sort((a, b) => new Date(a.exitTime || a.time || 0) - new Date(b.exitTime || b.time || 0));

const combinedTrades = allTrades.map(t => {
  if (t._s === 'fx') fxCum += t.profit;
  else goldCum += t.profit;
  const { _s, ...clean } = t;
  return { ...clean, balance: initBal + fxCum + goldCum };
});

const fxRobustness = computeRobustnessReport(fxTrades);
const goldRobustness = computeRobustnessReport(goldTrades);
const combinedRobustness = computeRobustnessReport(combinedTrades);

const data = {
  fx: { trades: fxTrades, robustness: fxRobustness },
  gold: { trades: goldTrades, robustness: goldRobustness },
  combined: { trades: combinedTrades, robustness: combinedRobustness },
};

fs.writeFileSync(OUTPUT, JSON.stringify(data));
console.log(`Wrote ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1024).toFixed(0)} KB)`);
