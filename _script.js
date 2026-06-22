const fs = require('fs');
const files = {
  'baseline':'trades_backtest_london_final.json',
  'No <15p':'trades_backtest_london_min15_max0.json',
  'No >60p':'trades_backtest_london_min0_max60.json',
  'No >50p':'trades_backtest_london_min0_max50.json',
  '15-60p':'trades_backtest_london_15-60.json',
  '20-50p':'trades_backtest_london_20-50.json',
  'No <20p':'trades_backtest_london_min20_max0.json',
};
console.log('Filter       |  T  |  WR  |  Net    |  PF  | EUR Net | JPY Net');
console.log('------------|-----|------|---------|------|---------|--------');
Object.entries(files).forEach(([k,f]) => {
  const t = JSON.parse(fs.readFileSync(f,'utf8')).trades;
  const tot = t.length;
  const wins = t.filter(x=>x.profit>0).length;
  const wr = (wins/tot*100).toFixed(1);
  const g = t.reduce((s,x)=>s+Math.max(0,x.profit),0);
  const l = Math.abs(t.reduce((s,x)=>s+Math.min(0,x.profit),0));
  const net = t.reduce((s,x)=>s+x.profit,0);
  const pf = (g/l).toFixed(2);
  const eur = t.filter(x=>x.pair==='EUR_USD').reduce((s,x)=>s+x.profit,0);
  const jpy = t.filter(x=>x.pair==='USD_JPY').reduce((s,x)=>s+x.profit,0);
  console.log(k.padEnd(12)+'| '+String(tot).padStart(3)+' | '+wr.padStart(4)+'% | $'+net.toFixed(2).padStart(6)+' | '+pf.padStart(4)+' | $'+eur.toFixed(2).padStart(6)+' | $'+jpy.toFixed(2).padStart(6));
});
