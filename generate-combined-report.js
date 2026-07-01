import fs from 'fs';
import { config } from './config.js';
import { computeRobustnessReport } from './report-metrics.js';

const FX_FILE = 'trades_backtest_fx.json';
const GOLD_FILE = 'trades_backtest_gold.json';
const OUTPUT_PATH = 'report_combined.html';

const KES_RATE = config.risk.usdKesRate || 129.0;

function formatKES(val) {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(val);
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

function computeStats(trades) {
  if (!trades.length) return { trades: 0, wins: 0, losses: 0, winRate: 0, grossProfit: 0, grossLoss: 0, netProfit: 0, profitFactor: 0, avgWin: 0, avgLoss: 0 };
  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / trades.length * 100),
    grossProfit,
    grossLoss,
    netProfit: grossProfit - grossLoss,
    profitFactor: grossLoss > 0 ? (grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? (grossProfit / wins.length) : 0,
    avgLoss: losses.length > 0 ? (grossLoss / losses.length) : 0,
  };
}

function buildProfileSummary(profile = {}) {
  const parts = [];
  if (profile.strategyMode) parts.push(`strategy=${profile.strategyMode}`);
  if (profile.sessionWindowMode) parts.push(`mode=${profile.sessionWindowMode}`);
  if (profile.nyAsianContinuation?.minRiskPips !== undefined && profile.nyAsianContinuation?.maxRiskPips !== undefined) {
    parts.push(`risk=${profile.nyAsianContinuation.minRiskPips}-${profile.nyAsianContinuation.maxRiskPips} pips`);
  }
  return parts.join(' | ');
}

function card(label, value, sub, color) {
  return `
    <div class="card">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value" style="color: ${color || 'var(--text)'}">${value}</div>
      ${sub ? `<div class="sub-value" style="color: var(--muted)">${escapeHtml(sub)}</div>` : ''}
    </div>`;
}

function generate() {
  if (!fs.existsSync(FX_FILE) || !fs.existsSync(GOLD_FILE)) {
    console.log("❌ Run 'npm run backtest:all' first to generate both data files.");
    return;
  }

  const fxData = JSON.parse(fs.readFileSync(FX_FILE, "utf8"));
  const goldData = JSON.parse(fs.readFileSync(GOLD_FILE, "utf8"));
  const fxTrades = fxData.trades || [];
  const goldTrades = goldData.trades || [];

  const combinedTrades = [...fxTrades, ...goldTrades]
    .sort((a, b) => new Date(a.exitTime || a.time || 0) - new Date(b.exitTime || b.time || 0))
    .map((t, i, arr) => {
      const prevBal = i > 0 ? arr[i - 1].balance : (t.balance - t.profit);
      return { ...t, balance: prevBal + t.profit };
    });

  const fxStats = computeStats(fxTrades);
  const goldStats = computeStats(goldTrades);
  const combinedStats = computeStats(combinedTrades);
  const robustness = computeRobustnessReport(combinedTrades);

  const fxProfile = buildProfileSummary(fxData.profile);
  const goldProfile = buildProfileSummary(goldData.profile);
  const startBal = combinedTrades[0]?.balance ? (combinedTrades[0].balance - combinedTrades[0].profit) : 0;
  const endBal = combinedTrades[combinedTrades.length - 1]?.balance || 0;
  const roi = startBal > 0 ? ((endBal / startBal) - 1) * 100 : 0;
  const startDate = combinedTrades[0]?.exitTime || combinedTrades[0]?.time;
  const endDate = combinedTrades[combinedTrades.length - 1]?.exitTime || combinedTrades[combinedTrades.length - 1]?.time;

  const byPair = {};
  combinedTrades.forEach(t => {
    if (!byPair[t.pair]) byPair[t.pair] = [];
    byPair[t.pair].push(t);
  });
  const pairRows = Object.entries(byPair).sort().map(([pair, trades]) => {
    const s = computeStats(trades);
    return `<tr>
      <td style="font-weight: 700;">${escapeHtml(pair)} ${pair.includes('XAU') ? '<span class="pill pill-gold">Gold</span>' : '<span class="pill pill-fx">FX</span>'}</td>
      <td>${s.trades}</td>
      <td>${formatPct(s.winRate)}</td>
      <td>${formatProfitFactor(s.profitFactor)}</td>
      <td style="color: ${profitColor(s.netProfit)}; font-weight: 700;">${signedUSD(s.netProfit)}</td>
    </tr>`;
  }).join('');

  const monthRows = robustness.monthly.map(m => `
    <tr>
      <td style="font-weight: 600;">${escapeHtml(m.period)}</td>
      <td>${m.trades}</td>
      <td style="color: ${profitColor(m.netProfit)}; font-weight: 700;">${signedUSD(m.netProfit)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Combined Strategy Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --bg: #0f172a; --card: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; --primary: #3b82f6; --success: #22c55e; --danger: #ef4444; --gold: #f59e0b; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; background: var(--bg); color: var(--text); padding: 2rem; line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; }
  header { margin-bottom: 2.5rem; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 1rem; }
  h1 { font-size: 26px; font-weight: 700; color: #fff; letter-spacing: -0.025em; }
  .subtitle { font-size: 14px; color: var(--muted); }
  .grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.25rem; margin-bottom: 1.5rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
  .label { font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.75rem; }
  .value { font-size: 24px; font-weight: 700; color: #fff; }
  .sub-value { font-size: 12px; margin-top: 0.4rem; font-weight: 500; }
  .section-title { font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 1.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .chart-scroll { height: 360px; width: 100%; overflow-x: auto; overflow-y: hidden; margin-bottom: 2.5rem; border: 1px solid var(--border); border-radius: 12px; background: var(--card); }
  .chart-scroll::-webkit-scrollbar { height: 10px; }
  .chart-scroll::-webkit-scrollbar-track { background: var(--bg); border-radius: 0 0 12px 12px; }
  .chart-scroll::-webkit-scrollbar-thumb { background: var(--border); border-radius: 5px; }
  .chart-scroll canvas { height: 320px; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 13px; color: var(--text); }
  th { text-align: left; padding: 14px 12px; color: var(--muted); font-weight: 600; border-bottom: 1px solid var(--border); background: #1e293b; }
  td { padding: 14px 12px; border-bottom: 1px solid var(--border); }
  tr:hover { background: #334155; }
  .badge { padding: 4px 10px; border-radius: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
  .bg-success { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.2); }
  .bg-danger { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); }
  .bg-gold { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.2); }
  .bg-blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
  .bg-muted { background: rgba(148, 163, 184, 0.1); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.2); }
  .table-wrap { overflow-x: auto; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem; }
  @media (max-width: 850px) { .split { grid-template-columns: 1fr; } .grid-stats { grid-template-columns: 1fr 1fr; } }
  .gold-text { color: var(--gold); }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; margin-left: 6px; vertical-align: middle; }
  .pill-fx { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
  .pill-gold { background: rgba(245, 158, 11, 0.15); color: #fbbf24; }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>Combined Strategy Dashboard</h1>
      <p class="subtitle">${startDate ? formatDatePretty(startDate) : 'N/A'} to ${endDate ? formatDatePretty(endDate) : 'N/A'}</p>
      <p class="subtitle">FX: ${escapeHtml(fxProfile)} &nbsp;|&nbsp; Gold: ${escapeHtml(goldProfile)}</p>
    </div>
    <div class="subtitle" style="text-align: right;">KES ${KES_RATE}</div>
  </header>

  <div class="grid-stats">
    ${card('Combined Net P&L', signedKES(combinedStats.netProfit * KES_RATE), `${formatPct(roi)} ROI`, profitColor(combinedStats.netProfit))}
    ${card('Combined Trades', String(combinedStats.trades), `${combinedStats.wins} Win / ${combinedStats.losses} Loss`, 'var(--primary)')}
    ${card('Win Rate', formatPct(combinedStats.winRate), `PF: ${formatProfitFactor(combinedStats.profitFactor)}`, 'var(--primary)')}
    ${card('Avg Trade', signedKES((combinedStats.netProfit / Math.max(1, combinedStats.trades)) * KES_RATE), `${signedUSD(combinedStats.avgWin)} win / ${signedUSD(-combinedStats.avgLoss)} loss`, profitColor(combinedStats.netProfit))}
  </div>

  <div class="split">
    <div class="card">
      <div class="section-title"><span style="color: var(--primary)">●</span> FX — EUR, GBP, USD_JPY</div>
      <div class="grid-stats" style="grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0;">
        ${card('Net P&L', signedKES(fxStats.netProfit * KES_RATE), '', profitColor(fxStats.netProfit))}
        ${card('Trades', String(fxStats.trades), formatPct(fxStats.winRate) + ' WR', 'var(--primary)')}
        ${card('PF', formatProfitFactor(fxStats.profitFactor), `Avg W: ${signedUSD(fxStats.avgWin)}`, '')}
        ${card('Avg L', signedUSD(-fxStats.avgLoss), '', 'var(--danger)')}
      </div>
    </div>
    <div class="card">
      <div class="section-title"><span class="gold-text">●</span> Gold — XAU/USD (RR=3.0)</div>
      <div class="grid-stats" style="grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 0;">
        ${card('Net P&L', signedKES(goldStats.netProfit * KES_RATE), '', profitColor(goldStats.netProfit))}
        ${card('Trades', String(goldStats.trades), formatPct(goldStats.winRate) + ' WR', 'var(--gold)')}
        ${card('PF', formatProfitFactor(goldStats.profitFactor), `Avg W: ${signedUSD(goldStats.avgWin)}`, '')}
        ${card('Avg L', signedUSD(-goldStats.avgLoss), '', 'var(--danger)')}
      </div>
    </div>
  </div>

  <div style="margin-bottom: 1.5rem;">
    <div class="section-title" style="padding: 0 0.25rem;">COMBINED EQUITY GROWTH (KES) — <span style="color: var(--muted); font-weight: 400;">scroll horizontally</span></div>
    <div class="chart-scroll">
      <canvas id="equityChart"></canvas>
    </div>
  </div>

  <div class="card section-spacer" style="margin-bottom: 1.5rem;">
    <div class="section-title">PER-PAIR PERFORMANCE</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Pair</th><th>Trades</th><th>Win %</th><th>PF</th><th>Net USD</th></tr></thead>
        <tbody>${pairRows}</tbody>
      </table>
    </div>
  </div>

  <div class="split">
    <div class="card">
      <div class="section-title">MONTHLY P&L</div>
      <div style="height: 250px;">
        <canvas id="monthlyChart"></canvas>
      </div>
    </div>
    <div class="card">
      <div class="section-title">MONTHLY TABLE</div>
      <div class="table-wrap" style="max-height: 280px; overflow-y: auto;">
        <table>
          <thead><tr><th>Month</th><th>Trades</th><th>Net USD</th></tr></thead>
          <tbody>${monthRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="card section-spacer">
    <div class="section-title">TRANSACTION LOG</div>
    <div class="table-wrap" style="max-height: 500px; overflow-y: auto;">
      <table>
        <thead><tr><th>Date</th><th>Pair</th><th>Dir</th><th>Result</th><th>Net</th></tr></thead>
        <tbody id="tradeTable"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
const trades = ${JSON.stringify(combinedTrades)};
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

function formatDateShort(dateStr) {
  const date = new Date(dateStr);
  const month = date.toLocaleString('en-GB', { month: 'short' });
  const year = date.getFullYear();
  return month + ' ' + year;
}

const labelInterval = Math.max(1, Math.floor(trades.length / 50));
const dateLabels = trades.map((t, i) => {
  if (i % labelInterval === 0) return formatDateShort(t.exitTime);
  return '';
});

const canvas = document.getElementById('equityChart');
const pxPerTrade = Math.max(3, Math.min(8, 1200 / trades.length));
canvas.style.width = (trades.length * pxPerTrade) + 'px';
canvas.width = trades.length * pxPerTrade * 2;
canvas.height = 640;

new Chart(canvas, {
  type: 'line',
  data: {
    labels: dateLabels,
    datasets: [{
      label: 'Balance',
      data: trades.map(t => t.balance * KES_RATE),
      borderColor: '#3b82f6',
      backgroundColor: 'rgba(59, 130, 246, 0.1)',
      borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, pointHoverRadius: 5
    }]
  },
  options: {
    responsive: false, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { mode: 'index', intersect: false } },
    scales: {
      x: {
        grid: { display: false },
        ticks: { maxRotation: 45, autoSkip: false, font: { size: 10 } }
      },
      y: { ticks: { callback: v => 'KSh ' + Number(v).toLocaleString() } }
    }
  }
});

const months = Object.fromEntries(robustness.monthly.map(m => [m.period, m.netProfit]));
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

const table = document.getElementById('tradeTable');
trades.slice().reverse().forEach(t => {
  const row = table.insertRow();
  const dateStr = formatDateJS(t.exitTime);
  const typeClass = t.direction === 'BUY' ? 'bg-blue' : 'bg-danger';
  const isGold = t.pair && t.pair.includes('XAU');
  const pairClass = isGold ? 'bg-gold' : 'bg-muted';
  const pc = t.profit >= 0 ? '#4ade80' : '#f87171';
  row.innerHTML = \`
    <td style="white-space: nowrap; color: var(--muted); font-size: 12px;">\${dateStr}</td>
    <td><span class="badge \${pairClass}">\${t.pair || 'N/A'}</span></td>
    <td><span class="badge \${typeClass}">\${t.direction}</span></td>
    <td><span class="badge bg-muted">\${t.reason} \${t.isBreakeven ? 'BE' : ''}</span></td>
    <td style="color: \${pc}; font-weight: 600;">\${t.profit >= 0 ? '+' : ''}\${t.profit.toFixed(2)}</td>
  \`;
});
</script>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_PATH, html);
  console.log(`\n✨ Combined dashboard generated: ${OUTPUT_PATH}`);
}

generate();
