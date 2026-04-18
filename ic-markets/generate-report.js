/**
 * Report Generator
 * Converts trade JSON data into a beautiful HTML dashboard.
 */
import fs from 'fs';

const FILE_PATH = 'trades_backtest.json';
const OUTPUT_PATH = 'report.html';

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

  // Calculate high-level metrics
  const netProfit = trades.reduce((s, t) => s + t.profit, 0);
  const winRate = data.winRate;
  const totalTrades = trades.length;
  const finalBalance = trades[trades.length - 1].balance;
  const startBalance = trades[0].balance - trades[0].profit;
  const roi = ((finalBalance / startBalance - 1) * 100).toFixed(1);

  const tpTrades = trades.filter(t => t.reason === 'TP');
  const slFull = trades.filter(t => t.reason === 'SL' && !t.isBreakeven);
  const avgWin = tpTrades.length > 0 ? (tpTrades.reduce((s,t) => s + t.profit, 0) / tpTrades.length).toFixed(2) : "0.00";
  const avgLoss = slFull.length > 0 ? (slFull.reduce((s,t) => s + t.profit, 0) / slFull.length).toFixed(2) : "0.00";

  // Build the HTML template
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Trading Strategy Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f5f5f3; color: #1a1a1a; padding: 2rem; min-height: 100vh; }
  h1 { font-size: 20px; font-weight: 500; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 1.5rem; }
  .grid-6 { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 1.5rem; }
  .metric { background: #fff; border: 0.5px solid #e0e0de; border-radius: 10px; padding: 1rem; }
  .metric-label { font-size: 12px; color: #888; margin-bottom: 4px; }
  .metric-value { font-size: 22px; font-weight: 500; }
  .metric-sub { font-size: 11px; color: #888; margin-top: 4px; }
  .green { color: #3B6D11; }
  .red { color: #A32D2D; }
  .section-title { font-size: 11px; font-weight: 500; color: #888; letter-spacing: 0.06em; text-transform: uppercase; margin: 1.5rem 0 0.75rem; }
  .chart-wrap { background: #fff; border: 0.5px solid #e0e0de; border-radius: 10px; padding: 1.25rem; margin-bottom: 1rem; }
  .outcome-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .donut-wrap { position: relative; width: 150px; height: 150px; flex-shrink: 0; }
  .donut-center { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); text-align: center; pointer-events: none; }
  .donut-center .val { font-size: 20px; font-weight: 500; }
  .donut-center .lbl { font-size: 11px; color: #888; }
  .legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 13px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  .legend-count { margin-left: auto; font-weight: 500; }
  .legend-sub { color: #888; }
  .trade-row { display: flex; align-items: center; gap: 8px; padding: 7px 0; border-bottom: 0.5px solid #f0f0ee; font-size: 13px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 4px; font-weight: 500; }
  .badge-buy { background: #E6F1FB; color: #0C447C; }
  .badge-sell { background: #FAEEDA; color: #633806; }
  .badge-tp { background: #EAF3DE; color: #27500A; }
  .badge-sl { background: #FCEBEB; color: #791F1F; }
  .badge-be { background: #f0f0ee; color: #666; }
  .outcome-flex { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; }
  @media (max-width: 600px) { body { padding: 1rem; } .grid-6 { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>

<h1>Strategy Analysis Dashboard</h1>
<p class="subtitle">${totalTrades} trades &nbsp;·&nbsp; ${trades[0].time.split('T')[0]} to ${trades[trades.length-1].time.split('T')[0]}</p>

<div class="grid-6">
  <div class="metric">
    <div class="metric-label">Net profit</div>
    <div class="metric-value ${netProfit >= 0 ? 'green' : 'red'}">${netProfit >= 0 ? '+' : ''}$${netProfit.toFixed(2)}</div>
    <div class="metric-sub">${roi}% ROI</div>
  </div>
  <div class="metric">
    <div class="metric-label">Win rate</div>
    <div class="metric-value">${winRate}%</div>
    <div class="metric-sub">${tpTrades.length} full TPs / ${slFull.length} full SLs</div>
  </div>
  <div class="metric">
    <div class="metric-label">Total trades</div>
    <div class="metric-value">${totalTrades}</div>
    <div class="metric-sub">Executed signals</div>
  </div>
  <div class="metric">
    <div class="metric-label">Final balance</div>
    <div class="metric-value">$${finalBalance.toFixed(2)}</div>
    <div class="metric-sub">Started at $${startBalance.toFixed(0)}</div>
  </div>
  <div class="metric">
    <div class="metric-label">Avg TP win</div>
    <div class="metric-value green">+$${avgWin}</div>
    <div class="metric-sub">Full TP hits</div>
  </div>
  <div class="metric">
    <div class="metric-label">Avg full loss</div>
    <div class="metric-value red">$${avgLoss}</div>
    <div class="metric-sub">Full SL hits</div>
  </div>
</div>

<p class="section-title">Equity curve</p>
<div class="chart-wrap">
  <div style="position:relative;width:100%;height:250px;">
    <canvas id="equityChart"></canvas>
  </div>
</div>

<div class="outcome-row">
  <div>
    <p class="section-title">Monthly P&amp;L</p>
    <div class="chart-wrap">
      <div style="position:relative;width:100%;height:200px;">
        <canvas id="monthlyChart"></canvas>
      </div>
    </div>
  </div>
  <div>
    <p class="section-title">Outcome breakdown</p>
    <div class="chart-wrap">
      <div class="outcome-flex">
        <div class="donut-wrap">
          <canvas id="donutChart" style="width:150px;height:150px;"></canvas>
          <div class="donut-center">
            <div class="val">${totalTrades}</div>
            <div class="lbl">trades</div>
          </div>
        </div>
        <div style="flex:1;min-width:180px;" id="outcome-legend"></div>
      </div>
    </div>
  </div>
</div>

<p class="section-title">Recent trades</p>
<div class="chart-wrap" id="recent-trades"></div>

<script>
const trades = ${JSON.stringify(trades)};

const tpTrades = trades.filter(t => t.reason === 'TP');
const slFull = trades.filter(t => t.reason === 'SL' && !t.isBreakeven);
const slBE = trades.filter(t => t.reason === 'SL' && t.isBreakeven);

// Equity Chart
new Chart(document.getElementById('equityChart'), {
  type: 'line',
  data: {
    labels: trades.map((t, i) => i + 1),
    datasets: [{
      label: 'Balance ($)',
      data: trades.map(t => parseFloat(t.balance.toFixed(2))),
      borderColor: '#185FA5',
      backgroundColor: 'rgba(24,95,165,0.07)',
      borderWidth: 2,
      pointRadius: 0,
      fill: true,
      tension: 0.2
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { maxTicksLimit: 20, color: '#999', font: { size: 10 } }, grid: { display: false } },
      y: { ticks: { color: '#999', font: { size: 11 }, callback: v => '$' + v }, grid: { color: 'rgba(0,0,0,0.05)' } }
    }
  }
});

// Monthly P&L
const monthMap = {};
trades.forEach(t => {
  const d = new Date(t.exitTime);
  const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
  monthMap[key] = (monthMap[key] || 0) + t.profit;
});
const mKeys = Object.keys(monthMap).sort();
const mVals = mKeys.map(k => parseFloat(monthMap[k].toFixed(2)));
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

new Chart(document.getElementById('monthlyChart'), {
  type: 'bar',
  data: {
    labels: mKeys.map(k => { const [y,m] = k.split('-'); return months[+m-1] + ' \\'' + y.slice(2); }),
    datasets: [{
      label: 'P&L ($)',
      data: mVals,
      backgroundColor: mVals.map(v => v >= 0 ? '#3B6D11' : '#A32D2D'),
      borderRadius: 4
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#999', font: { size: 10 } }, grid: { display: false } },
      y: { ticks: { color: '#999', font: { size: 11 }, callback: v => '$' + v.toFixed(0) }, grid: { color: 'rgba(0,0,0,0.05)' } }
    }
  }
});

// Donut Chart
new Chart(document.getElementById('donutChart'), {
  type: 'doughnut',
  data: {
    labels: ['TP hit', 'Breakeven SL', 'Full loss'],
    datasets: [{
      data: [tpTrades.length, slBE.length, slFull.length],
      backgroundColor: ['#3B6D11', '#185FA5', '#A32D2D'],
      borderWidth: 0,
      hoverOffset: 4
    }]
  },
  options: {
    responsive: false, cutout: '68%',
    plugins: { legend: { display: false } }
  }
});

const legendEl = document.getElementById('outcome-legend');
[
  { color: '#3B6D11', label: 'TP hit (full win)', count: tpTrades.length },
  { color: '#185FA5', label: 'Breakeven SL', count: slBE.length },
  { color: '#A32D2D', label: 'Full SL (loss)', count: slFull.length }
].forEach(i => {
  legendEl.innerHTML += \`<div class="legend-item"><span class="legend-dot" style="background:\${i.color}"></span><span class="legend-sub">\${i.label}</span><span class="legend-count">\${i.count}</span></div>\`;
});

const rt = document.getElementById('recent-trades');
trades.slice(-15).reverse().forEach(t => {
  const d = new Date(t.time);
  const dateStr = d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: '2-digit' });
  const profitColor = t.profit >= 0 ? '#3B6D11' : '#A32D2D';
  const profitStr = (t.profit >= 0 ? '+' : '') + '$' + t.profit.toFixed(2);
  rt.innerHTML += \`<div class="trade-row">
    <span style="color:#999;min-width:85px;font-size:12px;">\${dateStr}</span>
    <span class="badge badge-\${t.direction.toLowerCase()}">\${t.direction}</span>
    <span style="flex:1;color:#999;font-size:12px;">\${t.id}</span>
    <span class="badge badge-\${t.reason.toLowerCase()}">\${t.reason}</span>
    \${t.isBreakeven && t.reason === 'SL' ? '<span class="badge badge-be">BE</span>' : '<span style="width:28px;display:inline-block;"></span>'}
    <span style="font-weight:500;color:\${profitColor};min-width:70px;text-align:right;">\${profitStr}</span>
  </div>\`;
});
</script>
</body>
</html>`;

  fs.writeFileSync(OUTPUT_PATH, html);
  console.log(`\n✨ Dashboard report generated successfully: ${OUTPUT_PATH}`);
  console.log(`🔗 Open this file in your browser to view the analysis.`);
}

generate();
