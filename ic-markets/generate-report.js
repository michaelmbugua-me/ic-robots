/**
 * Report Generator
 * Converts trade JSON data into a beautiful DARK HTML dashboard (KES Denominated).
 */
import fs from 'fs';
import { config } from './config.js';

const FILE_PATH = 'trades_backtest.json';
const OUTPUT_PATH = 'report.html';
const KES_RATE = config.risk.usdKesRate || 129.0;

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
  if (j == 1 && k != 11) suffix = "st";
  if (j == 2 && k != 12) suffix = "nd";
  if (j == 3 && k != 13) suffix = "rd";
  
  return `${day}${suffix} ${month} ${year}`;
}

function generate() {
  if (!fs.existsSync(FILE_PATH)) {
    console.log("❌ No trade data found. Run a backtest first.");
    return;
  }

  const data = JSON.parse(fs.readFileSync(FILE_PATH, "utf8"));
  const trades = data.trades || [];
  
  if (trades.length === 0) {
    console.log("⚠️ No trades to report.");
    return;
  }

  const wins = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);
  const grossProfitKES = wins.reduce((s, t) => s + (t.profit * KES_RATE), 0);
  const grossLossKES = Math.abs(losses.reduce((s, t) => s + (t.profit * KES_RATE), 0));
  const netProfitKES = grossProfitKES - grossLossKES;
  const profitFactor = grossLossKES > 0 ? (grossProfitKES / grossLossKES).toFixed(2) : grossProfitKES.toFixed(2);
  
  const totalTrades = trades.length;
  const winRate = data.winRate || ((wins.length / totalTrades) * 100).toFixed(1);
  const avgWinKES = wins.length > 0 ? (grossProfitKES / wins.length) : 0;
  const avgLossKES = losses.length > 0 ? (grossLossKES / losses.length) : 0;

  const finalBalanceKES = trades[trades.length - 1].balance * KES_RATE;
  const startBalanceKES = (trades[0].balance - trades[0].profit) * KES_RATE;
  const roi = ((finalBalanceKES / startBalanceKES - 1) * 100).toFixed(2);

  let peakKES = startBalanceKES, maxDD = 0;
  trades.forEach(t => {
    const balKES = t.balance * KES_RATE;
    if (balKES > peakKES) peakKES = balKES;
    const dd = ((peakKES - balKES) / peakKES) * 100;
    if (dd > maxDD) maxDD = dd;
  });

  const bestTradeKES = Math.max(...trades.map(t => t.profit * KES_RATE));
  const worstTradeKES = Math.min(...trades.map(t => t.profit * KES_RATE));

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
  .bg-blue { background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.2); }
  .bg-muted { background: rgba(148, 163, 184, 0.1); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.2); }
  
  .flex-row { display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; margin-top: 1.5rem; }
  @media (max-width: 850px) { .flex-row { grid-template-columns: 1fr; } .grid-stats { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>

<div class="container">
  <header>
    <div>
      <h1>Trading Performance Terminal</h1>
      <p class="subtitle">System Analytics: ${formatDatePretty(trades[0].time)} to ${formatDatePretty(trades[trades.length-1].time)}</p>
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
      <div class="sub-value" style="color: var(--muted)">Max DD: ${maxDD.toFixed(2)}%</div>
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
</div>

<script>
const trades = ${JSON.stringify(trades)};
const KES_RATE = ${KES_RATE};

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
  if (j == 1 && k != 11) suffix = "st";
  if (j == 2 && k != 12) suffix = "nd";
  if (j == 3 && k != 13) suffix = "rd";
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
const months = {};
trades.forEach(t => {
  const d = new Date(t.exitTime);
  const key = d.toLocaleString('default', { month: 'short' }) + ' ' + d.getFullYear().toString().slice(2);
  months[key] = (months[key] || 0) + (t.profit * KES_RATE);
});

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

// 3. Trade Table
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
