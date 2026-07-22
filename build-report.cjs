#!/usr/bin/env node
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('/tmp/report_data.json', 'utf8'));

function processRobustness(rob) {
  return {
    trades: rob.trades,
    equity: rob.trades.map((t, i) => ({ x: i + 1, y: Math.round(t.balance * 129) })),
    dates: rob.trades.map(t => t.exitTime.slice(0, 10)),
    monthly: rob.robustness.monthly.map(m => ({
      period: m.period, trades: m.trades, wins: m.wins, losses: m.losses,
      winRate: m.winRate, netProfit: Math.round(m.netProfit * 129), profitFactor: m.profitFactor,
    })),
    yearly: rob.robustness.yearly.map(y => ({
      period: y.period, trades: y.trades, wins: y.wins, losses: y.losses,
      winRate: y.winRate, netProfit: Math.round(y.netProfit * 129), profitFactor: y.profitFactor,
    })),
    summary: rob.robustness.summary,
    byPair: rob.robustness.byPair.map(p => ({
      pair: p.pair, winRate: p.winRate, trades: p.trades, wins: p.wins, losses: p.losses,
      netProfit: Math.round(p.netProfit * 129), profitFactor: p.profitFactor,
      maxDrawdown: p.maxDrawdown, longestLosingStreak: p.longestLosingStreak,
    })),
    maxDrawdown: rob.robustness.maxDrawdown,
    longestStreak: rob.robustness.longestLosingStreak,
  };
}

const fx = processRobustness(raw.fx);
const gold = processRobustness(raw.gold);
const combined = processRobustness(raw.combined);

function buildTabContent(id, d) {
  const summary = d.summary;
  const cagr = ((summary.netProfit / 1181) * 100 / 6.5).toFixed(1);
  const pf = summary.profitFactor ? summary.profitFactor.toFixed(2) : 'N/A';
  const avgRR = summary.avgWin && summary.avgLoss ? (Math.abs(summary.avgWin) / Math.abs(summary.avgLoss)).toFixed(2) : 'N/A';
  const avgWin = summary.avgWin ? Math.round(summary.avgWin * 129) : 0;
  const avgLoss = summary.avgLoss ? Math.round(summary.avgLoss * 129) : 0;

  const monthlyRows = d.monthly.map(m => {
    const color = m.netProfit >= 0 ? 'var(--green)' : 'var(--red)';
    return `<tr data-period="${m.period}">
      <td style="font-weight:600">${m.period}</td>
      <td>${m.trades}</td>
      <td>${m.winRate.toFixed(1)}%</td>
      <td style="color:${color};font-weight:700">${m.netProfit >= 0 ? '+' : ''}${fmtKES(m.netProfit)}</td>
      <td>${m.profitFactor ? m.profitFactor.toFixed(2) : 'N/A'}</td>
    </tr>`;
  }).join('\n');

  const tradeRows = d.trades.slice().reverse().map(t => {
    const tradeTime = t.time || t.setupTime || t.exitTime;
    const date = new Date(t.exitTime);
    const day = date.getDate();
    const month = date.toLocaleString('en-GB', { month: 'short' });
    const year = date.getFullYear();
    const j = day % 10, k = day % 100;
    let suffix = 'th';
    if (j === 1 && k !== 11) suffix = 'st';
    if (j === 2 && k !== 12) suffix = 'nd';
    if (j === 3 && k !== 13) suffix = 'rd';
    const dateStr = day + suffix + ' ' + month + ' ' + year;
    const openedEat = formatTimeEAT(tradeTime);
    const profitKES = Math.round(t.profit * 129);
    const typeClass = t.direction === 'BUY' ? 'badge-buy' : 'badge-sell';
    const exitDate = t.exitTime.slice(0, 10);
    return `<tr data-date="${exitDate}">
      <td>${dateStr}</td>
      <td>${openedEat}</td>
      <td><span class="badge badge-pair">${t.pair || 'N/A'}</span></td>
      <td><span class="badge ${typeClass}">${t.direction}</span></td>
      <td><span class="badge badge-reason">${t.reason}</span></td>
      <td style="color:${profitKES >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${profitKES >= 0 ? '+' : ''}${fmtKES(profitKES)}</td>
      <td>${fmtKES(Math.round(t.balance * 129))}</td>
    </tr>`;
  }).join('\n');

  // Date range: first and last trade dates
  const firstDate = d.trades[0]?.exitTime?.slice(0, 10) || '2020-01-01';
  const lastDate = d.trades[d.trades.length - 1]?.exitTime?.slice(0, 10) || '2026-12-31';

  return `
    <div class="tab-content" id="tab-${id}">
      <div class="date-filter">
        <label>Date Range:</label>
        <input type="date" id="date-start-${id}" value="${firstDate}" min="${firstDate}" max="${lastDate}" onchange="onDateChange('${id}')">
        <span class="date-sep">to</span>
        <input type="date" id="date-end-${id}" value="${lastDate}" min="${firstDate}" max="${lastDate}" onchange="onDateChange('${id}')">
        <button class="date-reset" onclick="resetDates('${id}')">Reset</button>
      </div>

      <div class="metrics-grid" id="metrics-${id}">
        <div class="metric-card"><div class="metric-label">Total Trades</div><div class="metric-value" data-metric="trades">${summary.trades}</div></div>
        <div class="metric-card"><div class="metric-label">Win Rate</div><div class="metric-value" data-metric="winRate">${summary.winRate.toFixed(1)}%</div></div>
        <div class="metric-card"><div class="metric-label">Net Profit</div><div class="metric-value green" data-metric="netProfit">${fmtKES(summary.netProfit * 129)}</div></div>
        <div class="metric-card"><div class="metric-label">Profit Factor</div><div class="metric-value" data-metric="profitFactor">${pf}</div></div>
        <div class="metric-card"><div class="metric-label">Avg R:R</div><div class="metric-value" data-metric="avgRR">${avgRR}</div></div>
        <div class="metric-card"><div class="metric-label">CAGR</div><div class="metric-value" data-metric="cagr">${cagr}%</div></div>
        <div class="metric-card"><div class="metric-label">Max Drawdown</div><div class="metric-value red" data-metric="maxDD">${d.maxDrawdown.pct.toFixed(1)}%</div></div>
        <div class="metric-card"><div class="metric-label">Avg Win</div><div class="metric-value green" data-metric="avgWin">${fmtKES(avgWin)}</div></div>
        <div class="metric-card"><div class="metric-label">Avg Loss</div><div class="metric-value red" data-metric="avgLoss">${fmtKES(avgLoss)}</div></div>
        <div class="metric-card"><div class="metric-label">Max Consec. Losses</div><div class="metric-value" data-metric="maxStreak">${d.longestStreak.count}</div></div>
      </div>

      <div class="chart-row">
        <div class="chart-container chart-wide">
          <h3>Equity Curve (KES)</h3>
          <div id="equity-${id}" class="chart-box"></div>
        </div>
      </div>

      <div class="chart-row">
        <div class="chart-container"><h3>Monthly P&L</h3><div id="monthly-${id}" class="chart-box"></div></div>
        <div class="chart-container"><h3>Yearly P&L</h3><div id="yearly-${id}" class="chart-box"></div></div>
      </div>

      <div class="chart-row">
        <div class="chart-container"><h3>Win Rate by Pair</h3><div id="pairwr-${id}" class="chart-box"></div></div>
        <div class="chart-container"><h3>Net Profit by Pair</h3><div id="pairpnl-${id}" class="chart-box"></div></div>
      </div>

      <div class="section-divider">Monthly P&L Table</div>
      <div class="search-bar"><input type="text" placeholder="Search months..." oninput="filterTable('monthly-table-${id}', this.value)"></div>
      <div class="table-wrap">
        <table class="data-table" id="monthly-table-${id}">
          <thead><tr><th>Month</th><th>Trades</th><th>Win%</th><th>Net P&L</th><th>PF</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
      </div>

      <div class="section-divider">Trade Log</div>
      <div class="search-bar"><input type="text" placeholder="Search trades..." oninput="filterTable('trade-table-${id}', this.value)"></div>
      <div class="table-wrap">
        <table class="data-table" id="trade-table-${id}">
          <thead><tr><th>Date</th><th>Opened (EAT)</th><th>Pair</th><th>Dir</th><th>Exit</th><th>P&L</th><th>Balance</th></tr></thead>
          <tbody>${tradeRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function fmtKES(v) { return 'KSh ' + Math.round(v).toLocaleString('en-US'); }
function formatTimeEAT(dateLike) {
  if (!dateLike) return 'N/A';
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

const fxTab = buildTabContent('fx', fx);
const goldTab = buildTabContent('gold', gold);
const combinedTab = buildTabContent('combined', combined);

// Chart data: include dates for equity filtering
const chartData = {
  fx: { equity: fx.equity, dates: fx.dates, monthly: fx.monthly, yearly: fx.yearly, byPair: fx.byPair, firstDate: fx.dates[0], lastDate: fx.dates[fx.dates.length - 1] },
  gold: { equity: gold.equity, dates: gold.dates, monthly: gold.monthly, yearly: gold.yearly, byPair: gold.byPair, firstDate: gold.dates[0], lastDate: gold.dates[gold.dates.length - 1] },
  combined: { equity: combined.equity, dates: combined.dates, monthly: combined.monthly, yearly: combined.yearly, byPair: combined.byPair, firstDate: combined.dates[0], lastDate: combined.dates[combined.dates.length - 1] },
};

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NY Asian Continuation — Backtest Report</title>
<script src="https://cdn.jsdelivr.net/npm/apexcharts@3.44.0/dist/apexcharts.min.js"><\/script>
<style>
:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface2: #232736;
  --border: #2d3148;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --green: #22c55e;
  --red: #ef4444;
  --blue: #38bdf8;
  --purple: #a78bfa;
  --orange: #fb923c;
  --cyan: #34d399;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}
.header {
  text-align: center;
  padding: 32px 20px 16px;
  border-bottom: 1px solid var(--border);
}
.header h1 { font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
.header p { color: var(--muted); font-size: 13px; margin-top: 4px; }

/* Tabs */
.tabs {
  display: flex;
  justify-content: center;
  gap: 4px;
  padding: 16px 20px 0;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 100;
}
.tab-btn {
  padding: 10px 28px;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
}
.tab-btn:hover { color: var(--text); }
.tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); }

/* Content */
.tab-content { display: none; padding: 24px 20px; max-width: 1400px; margin: 0 auto; }
.tab-content.active { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

/* Date Filter */
.date-filter {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.date-filter label {
  font-size: 13px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.date-filter input[type="date"] {
  padding: 6px 12px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s;
}
.date-filter input[type="date"]:focus { border-color: var(--blue); }
.date-filter input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.7); cursor: pointer; }
.date-sep { color: var(--muted); font-size: 13px; }
.date-reset {
  padding: 6px 14px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.date-reset:hover { color: var(--text); border-color: var(--blue); }

/* Metrics */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}
.metric-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  text-align: center;
}
.metric-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
.metric-value { font-size: 20px; font-weight: 700; transition: color 0.2s; }
.metric-value.green { color: var(--green); }
.metric-value.red { color: var(--red); }

/* Charts */
.chart-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
.chart-row:has(.chart-wide) { grid-template-columns: 1fr; }
.chart-container {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.chart-container h3 { font-size: 14px; color: var(--muted); margin-bottom: 12px; font-weight: 600; }
.chart-box { width: 100%; height: 320px; }
.chart-wide .chart-box { height: 380px; }

/* Tables */
.section-divider {
  font-size: 14px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 20px 0 12px;
  border-top: 1px solid var(--border);
}
.search-bar { margin-bottom: 12px; }
.search-bar input {
  width: 100%;
  padding: 10px 16px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
.search-bar input:focus { border-color: var(--blue); }
.search-bar input::placeholder { color: var(--muted); }
.table-wrap {
  max-height: 500px;
  overflow-y: auto;
  border-radius: 12px;
  border: 1px solid var(--border);
}
.table-wrap::-webkit-scrollbar { width: 6px; }
.table-wrap::-webkit-scrollbar-track { background: var(--surface); }
.table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.data-table th {
  position: sticky;
  top: 0;
  background: var(--surface2);
  color: var(--muted);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 11px;
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--border); }
.data-table tbody tr:hover { background: var(--surface2); }
.badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
.badge-buy { background: rgba(34,197,94,0.15); color: var(--green); }
.badge-sell { background: rgba(239,68,68,0.15); color: var(--red); }
.badge-pair { background: rgba(56,189,248,0.15); color: var(--blue); }
.badge-reason { background: rgba(148,163,184,0.15); color: var(--muted); }

/* Chart legend overrides */
.apexcharts-legend-text { color: #e2e8f0 !important; font-weight: 500 !important; }
.apexcharts-legend-series { cursor: default !important; }
.apexcharts-tooltip { border-radius: 8px !important; box-shadow: 0 4px 20px rgba(0,0,0,0.4) !important; }
.apexcharts-tooltip-title { background: #232736 !important; border-bottom: 1px solid #2d3148 !important; }

@media (max-width: 768px) {
  .chart-row { grid-template-columns: 1fr; }
  .metrics-grid { grid-template-columns: repeat(2, 1fr); }
  .date-filter { gap: 8px; }
}
</style>
</head>
<body>

<div class="header">
  <h1>NY Asian Continuation — Backtest Report</h1>
  <p>Strategy: ny_asian_continuation | Mode: all_windows | Cooldown: 1 | Risk: 5–15 pips (FX) / 200–2000 pips (Gold) | Date range: 2020-01 to 2026-06 | Currency: KES @ 129</p>
</div>

<div class="tabs">
  <button class="tab-btn active" onclick="switchTab('fx', this)">FX (EUR/GBP/JPY)</button>
  <button class="tab-btn" onclick="switchTab('gold', this)">Gold (XAU/USD)</button>
  <button class="tab-btn" onclick="switchTab('combined', this)">Combined</button>
</div>

${fxTab}
${goldTab}
${combinedTab}

<script>
const CHART_DATA = ${JSON.stringify(chartData)};
const chartInstances = {};

function switchTab(id, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  btn.classList.add('active');
  if (!window['charts_' + id]) {
    window['charts_' + id] = true;
    renderCharts(id);
  }
}

function filterTable(tableId, query) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  const q = query.toLowerCase();
  rows.forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

function filterTableByDate(tableId, start, end) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach(row => {
    const dateAttr = row.getAttribute('data-date');
    const periodAttr = row.getAttribute('data-period');
    const val = dateAttr || periodAttr || '';
    if (!val) { row.style.display = ''; return; }
    row.style.display = (val >= start && val <= end) ? '' : 'none';
  });
}

function onDateChange(id) {
  const start = document.getElementById('date-start-' + id).value;
  const end = document.getElementById('date-end-' + id).value;
  if (!start || !end) return;

  // Filter tables
  filterTableByDate('monthly-table-' + id, start.slice(0, 7), end.slice(0, 7));
  filterTableByDate('trade-table-' + id, start, end);

  // Re-render charts with filtered data
  renderCharts(id, start, end);
}

function resetDates(id) {
  const d = CHART_DATA[id];
  document.getElementById('date-start-' + id).value = d.firstDate;
  document.getElementById('date-end-' + id).value = d.lastDate;
  onDateChange(id);
}

const COLORS = {
  equity: '#38bdf8',
  positive: '#22c55e',
  negative: '#ef4444',
  pairs: ['#38bdf8', '#a78bfa', '#fb923c', '#34d399'],
};

const chartTheme = {
  chart: { background: 'transparent', foreColor: '#94a3b8', toolbar: { show: true, tools: { zoom: true, zoomin: true, zoomout: true, pan: true, reset: true } } },
  grid: { borderColor: 'rgba(255,255,255,0.06)' },
  tooltip: { theme: 'dark', style: { fontSize: '13px' } },
  xaxis: { labels: { style: { colors: '#94a3b8', fontSize: '11px' } } },
  yaxis: { labels: { style: { colors: '#94a3b8', fontSize: '11px' } } },
  legend: { labels: { colors: '#e2e8f0', useSeriesColors: false }, fontSize: '13px', fontWeight: 500 },
};

function fmtK(v) { return 'KSh ' + Math.round(v).toLocaleString('en-US'); }
function pctK(v) { return v + '%'; }

function destroyCharts(id) {
  const prefixes = ['equity-', 'monthly-', 'yearly-', 'pairwr-', 'pairpnl-'];
  prefixes.forEach(p => {
    const el = document.getElementById(p + id);
    if (el) el.innerHTML = '';
  });
}

function renderCharts(id, startDate, endDate) {
  const raw = CHART_DATA[id];

  // Filter equity by date range
  let equity = raw.equity;
  let dates = raw.dates;
  if (startDate && endDate) {
    const filtered = [];
    const filteredDates = [];
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] >= startDate && dates[i] <= endDate) {
        filtered.push(equity[i]);
        filteredDates.push(dates[i]);
      }
    }
    // Re-index equity x values
    equity = filtered.map((e, i) => ({ x: i + 1, y: e.y }));
    dates = filteredDates;
  }

  // Filter monthly by date range
  const startMonth = startDate ? startDate.slice(0, 7) : '0000-00';
  const endMonth = endDate ? endDate.slice(0, 7) : '9999-99';
  const monthly = raw.monthly.filter(m => m.period >= startMonth && m.period <= endMonth);

  // Filter yearly
  const startYear = startDate ? startDate.slice(0, 4) : '0000';
  const endYear = endDate ? endDate.slice(0, 4) : '9999';
  const yearly = raw.yearly.filter(y => y.period >= startYear && y.period <= endYear);

  // Update metric cards with filtered stats
  updateMetrics(id, monthly);

  // Destroy existing charts
  destroyCharts(id);

  // Equity curve
  new ApexCharts(document.getElementById('equity-' + id), {
    ...chartTheme,
    chart: { ...chartTheme.chart, type: 'area', height: 350, zoom: { enabled: true, type: 'x' } },
    series: [{ name: 'Balance (KES)', data: equity }],
    stroke: { curve: 'smooth', width: 2.5 },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.05, colorStops: [{ offset: 0, color: COLORS.equity, opacity: 0.35 }, { offset: 100, color: COLORS.equity, opacity: 0.02 }] } },
    colors: [COLORS.equity],
    legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: '#e2e8f0' } },
    xaxis: { title: { text: 'Trade #', style: { color: '#94a3b8', fontSize: '12px' } }, labels: { show: false } },
    yaxis: { title: { text: 'Balance (KES)', style: { color: '#94a3b8', fontSize: '12px' } }, labels: { formatter: fmtK } },
    tooltip: { y: { formatter: fmtK } },
  }).render();

  // Monthly P&L
  new ApexCharts(document.getElementById('monthly-' + id), {
    ...chartTheme,
    chart: { ...chartTheme.chart, type: 'bar', height: 320 },
    series: [{ name: 'Net P&L', data: monthly.map(m => m.netProfit) }],
    colors: [COLORS.positive],
    plotOptions: { bar: { borderRadius: 4, colors: { ranges: [{ from: -999999, to: 0, color: COLORS.negative }, { from: 0, to: 999999, color: COLORS.positive }] } } },
    legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: '#e2e8f0' } },
    xaxis: { categories: monthly.map(m => m.period), labels: { rotate: -45, style: { fontSize: '10px', colors: '#94a3b8' } } },
    yaxis: { labels: { formatter: fmtK } },
    tooltip: { y: { formatter: fmtK } },
  }).render();

  // Yearly P&L
  new ApexCharts(document.getElementById('yearly-' + id), {
    ...chartTheme,
    chart: { ...chartTheme.chart, type: 'bar', height: 320 },
    series: [{ name: 'Net P&L', data: yearly.map(y => y.netProfit) }],
    colors: [COLORS.positive],
    plotOptions: { bar: { borderRadius: 6, colors: { ranges: [{ from: -999999, to: 0, color: COLORS.negative }, { from: 0, to: 999999, color: COLORS.positive }] } } },
    legend: { show: true, position: 'top', horizontalAlign: 'right', labels: { colors: '#e2e8f0' } },
    xaxis: { categories: yearly.map(y => y.period), labels: { style: { colors: '#94a3b8' } } },
    yaxis: { labels: { formatter: fmtK } },
    tooltip: { y: { formatter: fmtK } },
  }).render();

  // Win rate by pair
  new ApexCharts(document.getElementById('pairwr-' + id), {
    ...chartTheme,
    chart: { ...chartTheme.chart, type: 'radialBar', height: 320 },
    series: raw.byPair.map(p => p.winRate),
    labels: raw.byPair.map(p => p.pair.replace('_', '/')),
    colors: COLORS.pairs.slice(0, raw.byPair.length),
    legend: {
      show: true, position: 'right', fontSize: '13px', fontWeight: 600,
      labels: { colors: '#e2e8f0', useSeriesColors: true },
      markers: { width: 10, height: 10, radius: 2 },
      itemMargin: { vertical: 4 },
    },
    plotOptions: {
      radialBar: {
        hollow: { size: '35%', background: 'transparent' },
        track: { background: '#2d3148', strokeWidth: '100%' },
        dataLabels: {
          name: { fontSize: '14px', color: '#e2e8f0', offsetY: -10 },
          value: { fontSize: '18px', fontWeight: 700, color: '#e2e8f0', formatter: pctK },
        },
      },
    },
  }).render();

  // Net profit by pair
  new ApexCharts(document.getElementById('pairpnl-' + id), {
    ...chartTheme,
    chart: { ...chartTheme.chart, type: 'bar', height: 320 },
    series: [{ name: 'Net Profit', data: raw.byPair.map(p => p.netProfit) }],
    colors: COLORS.pairs.slice(0, raw.byPair.length),
    legend: { show: false },
    plotOptions: {
      bar: { horizontal: true, distributed: true, borderRadius: 4, barHeight: '60%' },
    },
    dataLabels: {
      enabled: true,
      formatter: fmtK,
      style: { colors: ['#e2e8f0'], fontSize: '11px', fontWeight: 500 },
      offsetX: 20,
    },
    xaxis: {
      categories: raw.byPair.map(p => p.pair.replace('_', '/')),
      labels: { style: { colors: '#e2e8f0', fontSize: '12px', fontWeight: 500 } },
    },
    yaxis: { labels: { formatter: fmtK } },
    tooltip: { y: { formatter: fmtK } },
    grid: { xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
  }).render();
}

function updateMetrics(id, monthly) {
  const el = document.getElementById('metrics-' + id);
  if (!el) return;

  const trades = monthly.reduce((s, m) => s + m.trades, 0);
  const wins = monthly.reduce((s, m) => s + m.wins, 0);
  const losses = monthly.reduce((s, m) => s + m.losses, 0);
  const netProfit = monthly.reduce((s, m) => s + m.netProfit, 0);
  const grossProfit = monthly.reduce((s, m) => s + (m.profitFactor !== null ? m.netProfit > 0 ? m.netProfit / m.profitFactor * m.profitFactor : 0 : 0), 0);
  const winRate = trades > 0 ? (wins / trades * 100) : 0;

  // Compute profit factor from monthly gross
  let totalGrossProfit = 0, totalGrossLoss = 0;
  monthly.forEach(m => {
    if (m.netProfit >= 0) { totalGrossProfit += m.netProfit; }
    else { totalGrossLoss += Math.abs(m.netProfit); }
  });
  const pf = totalGrossLoss > 0 ? (totalGrossProfit / totalGrossLoss) : totalGrossProfit > 0 ? Infinity : 0;

  const setText = (metric, val) => {
    const e = el.querySelector('[data-metric="' + metric + '"]');
    if (e) e.textContent = val;
  };

  setText('trades', trades);
  setText('winRate', winRate.toFixed(1) + '%');
  setText('netProfit', fmtK(netProfit));
  setText('profitFactor', pf === Infinity ? '∞' : pf > 0 ? pf.toFixed(2) : '0.00');
}

document.getElementById('tab-fx').classList.add('active');
window['charts_fx'] = true;
renderCharts('fx');
<\/script>
</body>
</html>`;

fs.writeFileSync('report.html', html);
console.log('Report written to report.html (' + (html.length / 1024).toFixed(0) + ' KB)');
