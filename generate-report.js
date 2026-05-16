/**
 * Report Generator — 5-10-20 EMA Scalping Strategy
 * Converts trade JSON data into a beautiful DARK HTML dashboard (KES Denominated).
 */
import fs from 'fs';
import { config } from './config.js';
import { computeRobustnessReport } from './report-metrics.js';

const FILE_PATH = 'trades_backtest.json';
const OUTPUT_PATH = 'report.html';
const KES_RATE = config.risk.usdKesRate || 129.0;

function buildProfileSummary(profile = {}) {
  const parts = [];
  if (profile.sessionWindowMode) parts.push(`mode=${profile.sessionWindowMode}`);
  if (profile.emaSeparationMinPips !== undefined) parts.push(`emaSep=${profile.emaSeparationMinPips}`);
  if (profile.cooldownCandlesAfterLoss !== undefined) parts.push(`cooldown=${profile.cooldownCandlesAfterLoss}`);
  if (profile.minRiskPips !== undefined && profile.maxRiskPips !== undefined) {
    parts.push(`risk=${profile.minRiskPips}-${profile.maxRiskPips} pips`);
  }
  return parts.join(' | ');
}

function formatKES(val) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(val);
}

function formatDatePretty(dateStr) {
  const date = new Date(dateStr);
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const year = date.getFullYear();
  
  const j = day % 10, k = day % 100;
  let suffix = "th";
  if (j === 1 && k !== 11) suffix = "st";
  if (j === 2 && k !== 12) suffix = "nd";
  if (j === 3 && k !== 13) suffix = "rd";

  return `${day}${suffix} ${month} ${year}`;
}

function tradeTime(trade) {
  return trade.exitTime || trade.time || trade.setupTime;
}

function formatUSD(val) {
  return `$${Number(val || 0).toFixed(2)}`;
}

function formatPct(val, digits = 1) {
  return `${Number(val || 0).toFixed(digits)}%`;
}

function formatProfitFactor(val) {
  return val === Infinity ? '∞' : Number(val || 0).toFixed(2);
}

function signedKES(val) {
  const amount = Number(val || 0);
  return `${amount >= 0 ? '+' : ''}${formatKES(amount)}`;
}

function signedUSD(val) {
  const amount = Number(val || 0);
  return `${amount >= 0 ? '+' : ''}${formatUSD(amount)}`;
}

function profitColor(val) {
  return Number(val || 0) >= 0 ? 'var(--success)' : 'var(--danger)';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderPeriodRows(periods, kesRate) {
  return periods.map(period => `
    <tr>
      <td style="font-weight: 600;">${escapeHtml(period.period)}</td>
      <td>${period.trades}</td>
      <td>${formatPct(period.winRate)}</td>
      <td style="color: ${profitColor(period.netProfit)}; font-weight: 700;">${signedKES(period.netProfit * kesRate)}</td>
      <td style="color: var(--muted);">${signedUSD(period.netProfit)}</td>
      <td>${formatProfitFactor(period.profitFactor)}</td>
    </tr>`).join('');
}

function renderPairRows(pairs, kesRate) {
  return pairs.map(pair => `
    <tr>
      <td style="font-weight: 700;">${escapeHtml(pair.pair)}</td>
      <td>${pair.trades}</td>
      <td>${formatPct(pair.winRate)}</td>
      <td>${formatProfitFactor(pair.profitFactor)}</td>
      <td style="color: ${profitColor(pair.netProfit)}; font-weight: 700;">${signedKES(pair.netProfit * kesRate)}</td>
      <td style="color: var(--danger); font-weight: 700;">-${formatKES(pair.maxDrawdown.amount * kesRate)}</td>
      <td>${pair.longestLosingStreak.count}</td>
      <td>${formatPct(pair.monthlyStability.greenMonthRate)}</td>
      <td style="color: ${profitColor(pair.monthlyStability.worstMonth?.netProfit ?? 0)};">${signedKES((pair.monthlyStability.worstMonth?.netProfit ?? 0) * kesRate)}</td>
    </tr>`).join('');
}

function renderClusterAlerts(alerts) {
  return alerts.map(alert => {
    const klass = alert.level === 'ok' ? 'bg-success' : alert.level === 'danger' ? 'bg-danger' : 'bg-warning';
    return `<div class="diagnostic-line"><span class="badge ${klass}">${escapeHtml(alert.level)}</span><span>${escapeHtml(alert.text)}</span></div>`;
  }).join('');
}

function generate() {
  if (!fs.existsSync(FILE_PATH)) {
    console.log("❌ No trade data found. Run a backtest first.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  const trades = [...(data.trades || [])].sort((a, b) => new Date(tradeTime(a) || 0) - new Date(tradeTime(b) || 0));
  const profile = data.profile || {};
  const profileSummary = buildProfileSummary(profile);
  const generatedAtUTC = data.generatedAtUTC || new Date().toISOString();

  if (trades.length === 0) {
    console.log("⚠️ No trades to report.");
    return;
  }

  const robustness = computeRobustnessReport(trades);
  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);
  const grossProfitKES = wins.reduce((s, t) => s + (t.profit * KES_RATE), 0);
  const grossLossKES = Math.abs(losses.reduce((s, t) => s + (t.profit * KES_RATE), 0));
  const netProfitKES = grossProfitKES - grossLossKES;
  const profitFactor = grossLossKES > 0 ? (grossProfitKES / grossLossKES).toFixed(2) : grossProfitKES.toFixed(2);
  
  const totalTrades = trades.length;
  const winRate = data.summary?.winRate || ((wins.length / totalTrades) * 100).toFixed(1);
  const avgWinKES = wins.length > 0 ? (grossProfitKES / wins.length) : 0;
  const avgLossKES = losses.length > 0 ? (grossLossKES / losses.length) : 0;

  const finalBalanceKES = trades[trades.length - 1].balance * KES_RATE;
  const startBalanceKES = (trades[0].balance - trades[0].profit) * KES_RATE;
  const roi = ((finalBalanceKES / startBalanceKES - 1) * 100).toFixed(2);

  const maxDDKES = robustness.maxDrawdown.amount * KES_RATE;
  const maxDD = robustness.maxDrawdown.pct;

  const bestTradeKES = Math.max(...trades.map(t => t.profit * KES_RATE));
  const worstTradeKES = Math.min(...trades.map(t => t.profit * KES_RATE));
  const bestMonth = robustness.clustering.topMonth;
  const bestPair = robustness.clustering.topPair;
  const bestYear = robustness.clustering.topYear;
  const monthlyRows = renderPeriodRows(robustness.monthly, KES_RATE);
  const yearlyRows = renderPeriodRows(robustness.yearly, KES_RATE);
  const pairRows = renderPairRows(robustness.byPair, KES_RATE);
  const clusterAlerts = renderClusterAlerts(robustness.clustering.alerts);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strategy Dashboard (KES) — Dark</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { 
    --bg: #0f172a; 
    --card: #1e293b; 
    --border: #334155;
    --text: #f8fafc; 
    --muted: #94a3b8; 
    --primary: #3b82f6; 
    --success: #22c55e; 
    --danger: #ef4444; 
    --table-hover: #1e293b;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 2rem; line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; }
  header { margin-bottom: 2.5rem; display: flex; justify-content: space-between; align-items: flex-end; }
  h1 { font-size: 26px; font-weight: 700; color: #fff; letter-spacing: -0.025em; }
  .subtitle { font-size: 14px; color: var(--muted); }
  
  .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
  .label { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
  .value { font-size: 24px; font-weight: 700; color: #fff; }
  .sub-value { font-size: 12px; margin-top: 0.4rem; font-weight: 500; }
  
  .section-title { font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 1.25rem; display: flex; align-items: center; gap: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .chart-container { height: 320px; width: 100%; position: relative; margin-bottom: 2.5rem; }
  
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 13px; color: var(--text); }
  th { text-align: left; padding: 14px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); background: #1e293b; }
  td { padding: 14px 12px; border-bottom: 1px solid var(--border); }
  tr:hover { background: #334155; }
  
  .badge { padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .bg-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.2); }
  .bg-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); }
  .bg-warning { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.2); }
  .bg-blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
  .bg-muted { background: rgba(148, 163, 184, 0.1); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.2); }
  .table-wrap { overflow-x: auto; }
  .metric-list { display: grid; gap: 0.85rem; }
  .metric-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border); }
  .metric-row:last-child { border-bottom: 0; padding-bottom: 0; }
  .metric-row span:first-child { color: var(--muted); font-size: 12px; }
  .metric-row strong { font-size: 14px; text-align: right; }
  .diagnostic-line { display: flex; align-items: flex-start; gap: 0.75rem; margin-bottom: 0.75rem; color: var(--muted); font-size: 13px; }
  .section-spacer { margin-top: 1.5rem; }
  
  .flex-row { display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; margin-top: 1.5rem; }
  @media (max-width: 850px) { .flex-row { grid-template-columns: 1fr; } .grid-stats { grid-template-columns: 1fr 1fr; } header { display: block; } }
</style>
</head>
<body>

<div class="container">
  <header>
    <div>
      <h1>Trading Performance Terminal</h1>
      <p class="subtitle">System Analytics: ${formatDatePretty(trades[0].time)} to ${formatDatePretty(trades[trades.length-1].time)}</p>
      <p class="subtitle">${profileSummary || 'profile=unknown'} &nbsp;|&nbsp; generated ${generatedAtUTC}</p>
    </div>
    <div class="subtitle" style="text-align: right;">Currency: KES &nbsp; | &nbsp; Rate: ${KES_RATE}</div>
  </header>

  <div class="grid-stats">
    <div class="card">
      <div class="label">Total Net P&L</div>
      <div class="value" style="color: ${netProfitKES >= 0 ? 'var(--success)' : 'var(--danger)'}">${netProfitKES >= 0 ? '+' : ''}${formatKES(netProfitKES)}</div>
      <div class="sub-value" style="color: var(--muted)">Growth: ${roi}% ROI</div>
    </div>
    <div class="card">
      <div class="label">Accuracy</div>
      <div class="value" style="color: var(--primary)">${winRate}%</div>
      <div class="sub-value" style="color: var(--muted)">${wins.length} Win / ${losses.length} Loss</div>
    </div>
    <div class="card">
      <div class="label">Efficiency (PF)</div>
      <div class="value">${profitFactor}</div>
      <div class="sub-value" style="color: var(--muted)">Max DD: ${formatKES(maxDDKES)} / ${maxDD.toFixed(2)}%</div>
    </div>
    <div class="card">
      <div class="label">Portfolio Value</div>
      <div class="value">${formatKES(finalBalanceKES)}</div>
      <div class="sub-value" style="color: var(--muted)">Init: ${formatKES(startBalanceKES)}</div>
    </div>
  </div>

  <div class="grid-stats">
    <div class="card">
      <div class="label">Risk Statistics</div>
      <div class="value" style="font-size: 18px;"><span style="color: var(--success)">+${formatKES(avgWinKES)}</span> <span style="color:var(--muted);font-size:12px">vs</span> <span style="color: var(--danger)">-${formatKES(avgLossKES)}</span></div>
      <div class="sub-value" style="color: var(--muted)">Avg. Outcome per Session</div>
    </div>
    <div class="card">
      <div class="label">Peak Deviations</div>
      <div class="value" style="font-size: 18px;"><span style="color: var(--success)">${formatKES(bestTradeKES)}</span> <span style="color:var(--muted);font-size:12px">/</span> <span style="color: var(--danger)">${formatKES(worstTradeKES)}</span></div>
      <div class="sub-value" style="color: var(--muted)">Best vs Worst Trade Execution</div>
    </div>
    <div class="card">
      <div class="label">Longest Losing Streak</div>
      <div class="value" style="font-size: 18px; color: ${robustness.longestLosingStreak.count >= 4 ? 'var(--danger)' : 'var(--text)'}">${robustness.longestLosingStreak.count} trades</div>
      <div class="sub-value" style="color: var(--muted)">${formatKES(Math.abs(robustness.longestLosingStreak.amount * KES_RATE))} during worst streak</div>
    </div>
    <div class="card">
      <div class="label">Profit Clustering</div>
      <div class="value" style="font-size: 18px; color: ${robustness.clustering.topMonthPositiveShare >= 50 ? 'var(--danger)' : 'var(--success)'}">${formatPct(robustness.clustering.topMonthPositiveShare)}</div>
      <div class="sub-value" style="color: var(--muted)">Best month share of positive monthly profit</div>
    </div>
  </div>

  <div class="card" style="margin-bottom: 1.5rem;">
    <div class="section-title">EQUITY GROWTH (KES)</div>
    <div class="chart-container">
      <canvas id="equityChart"></canvas>
    </div>
  </div>

  <div class="flex-row">
    <div class="card">
      <div class="section-title">TRANSACTION LOG</div>
      <table>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Dir</th>
            <th>Result</th>
            <th>Net Profit</th>
            <th>Account</th>
          </tr>
        </thead>
        <tbody id="tradeTable"></tbody>
      </table>
    </div>
    <div class="card">
      <div class="section-title">PERIODIC PERFORMANCE</div>
      <div style="height: 250px;">
        <canvas id="monthlyChart"></canvas>
      </div>
    </div>
  </div>

  <div class="grid-stats section-spacer">
    <div class="card">
      <div class="section-title">ROBUSTNESS SNAPSHOT</div>
      <div class="metric-list">
        <div class="metric-row"><span>Portfolio max drawdown</span><strong style="color: var(--danger)">-${formatKES(maxDDKES)} (${maxDD.toFixed(2)}%)</strong></div>
        <div class="metric-row"><span>Worst losing streak</span><strong>${robustness.longestLosingStreak.count} trades / -${formatKES(Math.abs(robustness.longestLosingStreak.amount * KES_RATE))}</strong></div>
        <div class="metric-row"><span>Best month</span><strong>${bestMonth ? `${escapeHtml(bestMonth.period)} · ${signedKES(bestMonth.netProfit * KES_RATE)}` : 'n/a'}</strong></div>
        <div class="metric-row"><span>Best year</span><strong>${bestYear ? `${escapeHtml(bestYear.period)} · ${signedKES(bestYear.netProfit * KES_RATE)}` : 'n/a'}</strong></div>
        <div class="metric-row"><span>Top pair contribution</span><strong>${bestPair ? `${escapeHtml(bestPair.pair)} · ${formatPct(robustness.clustering.topPairPositiveShare)}` : 'n/a'}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">PROFIT CLUSTERING CHECKS</div>
      ${clusterAlerts}
      <div class="metric-list" style="margin-top: 1rem;">
        <div class="metric-row"><span>Best month share</span><strong>${formatPct(robustness.clustering.topMonthPositiveShare)}</strong></div>
        <div class="metric-row"><span>Top 3 months share</span><strong>${formatPct(robustness.clustering.topThreeMonthPositiveShare)}</strong></div>
        <div class="metric-row"><span>Best year share</span><strong>${formatPct(robustness.clustering.topYearPositiveShare)}</strong></div>
      </div>
    </div>
  </div>

  <div class="flex-row">
    <div class="card">
      <div class="section-title">YEARLY P&L</div>
      <div style="height: 250px;">
        <canvas id="yearlyChart"></canvas>
      </div>
    </div>
    <div class="card">
      <div class="section-title">PER-PAIR DRAWDOWN</div>
      <div style="height: 250px;">
        <canvas id="pairDrawdownChart"></canvas>
      </div>
    </div>
  </div>

  <div class="card section-spacer">
    <div class="section-title">PER-PAIR ROBUSTNESS</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th>Trades</th>
            <th>Win %</th>
            <th>PF</th>
            <th>Net P&L</th>
            <th>Max DD</th>
            <th>Lose Streak</th>
            <th>Green Months</th>
            <th>Worst Month</th>
          </tr>
        </thead>
        <tbody>${pairRows}</tbody>
      </table>
    </div>
  </div>

  <div class="flex-row">
    <div class="card">
      <div class="section-title">MONTHLY P&L STABILITY</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Month</th><th>Trades</th><th>Win %</th><th>Net KES</th><th>Net USD</th><th>PF</th></tr></thead>
          <tbody>${monthlyRows}</tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="section-title">YEARLY P&L TABLE</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Year</th><th>Trades</th><th>Win %</th><th>Net KES</th><th>Net USD</th><th>PF</th></tr></thead>
          <tbody>${yearlyRows}</tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
const trades = ${JSON.stringify(trades)};
const KES_RATE = ${KES_RATE};
const robustness = ${JSON.stringify(robustness)};

Chart.defaults.color = '#94a3b8';
Chart.defaults.borderColor = 'rgba(255, 255, 255, 0.1)';

function formatKESJS(val) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(val);
}

function formatDateJS(dateStr) {
  const date = new Date(dateStr);
  const day = date.getDate();
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const year = date.getFullYear();
  const j = day % 10, k = day % 100;
  let suffix = "th";
  if (j === 1 && k !== 11) suffix = "st";
  if (j === 2 && k !== 12) suffix = "nd";
  if (j === 3 && k !== 13) suffix = "rd";
  return day + suffix + " " + month + " " + year;
}

// 1. Equity Chart
new Chart(document.getElementById('equityChart'), {
  type: 'line',
  data: {
    labels: trades.map((t, i) => i + 1),
    datasets: [{
      label: 'Balance',
      data: trades.map(t => t.balance * KES_RATE),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 5
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false } },
      y: { ticks: { callback: v => 'KSh ' + v.toLocaleString() } }
    }
  }
});

// 2. Monthly P&L
const months = Object.fromEntries(robustness.monthly.map(m => [m.period, m.netProfit * KES_RATE]));

new Chart(document.getElementById('monthlyChart'), {
  type: 'bar',
  data: {
    labels: Object.keys(months),
    datasets: [{
      data: Object.values(months),
      backgroundColor: Object.values(months).map(v => v >= 0 ? '#22c55e' : '#ef4444'),
      borderRadius: 6
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } }
  }
});

// 3. Yearly P&L
new Chart(document.getElementById('yearlyChart'), {
  type: 'bar',
  data: {
    labels: robustness.yearly.map(y => y.period),
    datasets: [{
      data: robustness.yearly.map(y => y.netProfit * KES_RATE),
      backgroundColor: robustness.yearly.map(y => y.netProfit >= 0 ? '#22c55e' : '#ef4444'),
      borderRadius: 6
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { ticks: { callback: v => 'KSh ' + v.toLocaleString() } } }
  }
});

// 4. Per-pair drawdown
new Chart(document.getElementById('pairDrawdownChart'), {
  type: 'bar',
  data: {
    labels: robustness.byPair.map(p => p.pair),
    datasets: [{
      data: robustness.byPair.map(p => -(p.maxDrawdown.amount * KES_RATE)),
      backgroundColor: '#ef4444',
      borderRadius: 6
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { ticks: { callback: v => 'KSh ' + v.toLocaleString() } } }
  }
});

// 5. Trade Table
const table = document.getElementById('tradeTable');
trades.slice().reverse().forEach(t => {
  const row = table.insertRow();
  const dateStr = formatDateJS(t.exitTime);
  const typeClass = t.direction === 'BUY' ? 'bg-blue' : 'bg-danger';
  const profitKES = t.profit * KES_RATE;
  const profitColor = profitKES >= 0 ? '#4ade80' : '#f87171';
  
  row.innerHTML = \`
    <td style="white-space: nowrap; color: var(--muted); font-size: 12px;">\${dateStr}</td>
    <td><span class="badge \${typeClass}">\${t.direction}</span></td>
    <td><span class="badge bg-muted">\${t.reason} \${t.isBreakeven ? 'BE' : ''}</span></td>
    <td style="color: \${profitColor}; font-weight: 600;">\${profitKES >= 0 ? '+' : ''}\${formatKESJS(profitKES)}</td>
    <td style="font-weight: 500;">\${formatKESJS(t.balance * KES_RATE)}</td>
  \`;
});
</script>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_PATH, html);
  console.log(`\n✨ Dark Mode KES Dashboard generated: ${OUTPUT_PATH}`);
}

generate();
