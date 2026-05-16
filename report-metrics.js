const EPSILON = 1e-9;

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function tradeTimestamp(trade) {
  return trade.exitTime || trade.time || trade.setupTime || null;
}

function sortTrades(trades = []) {
  return [...trades].sort((a, b) => new Date(tradeTimestamp(a) || 0) - new Date(tradeTimestamp(b) || 0));
}

function monthKeyUTC(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function yearKeyUTC(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return String(date.getUTCFullYear());
}

function groupBy(trades, keyFn) {
  const grouped = new Map();
  for (const trade of trades) {
    const key = keyFn(trade);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(trade);
  }
  return grouped;
}

export function summarizeTrades(trades = []) {
  const profits = trades.map(t => toNumber(t.profit));
  const wins = profits.filter(v => v > EPSILON);
  const losses = profits.filter(v => v <= EPSILON);
  const grossProfit = wins.reduce((sum, v) => sum + v, 0);
  const grossLoss = Math.abs(losses.reduce((sum, v) => sum + v, 0));
  const netProfit = profits.reduce((sum, v) => sum + v, 0);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor: grossLoss > EPSILON ? grossProfit / grossLoss : (grossProfit > EPSILON ? Infinity : 0),
    avgTrade: trades.length ? netProfit / trades.length : 0,
    avgWin: wins.length ? grossProfit / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
  };
}

function buildPeriodStats(trades, keyFn) {
  return Array.from(groupBy(trades, t => keyFn(tradeTimestamp(t))).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, periodTrades]) => ({
      period,
      ...summarizeTrades(periodTrades),
    }));
}

export function calculateMaxDrawdownFromBalance(trades = []) {
  const sorted = sortTrades(trades);
  if (sorted.length === 0) {
    return { amount: 0, pct: 0, peak: 0, trough: 0, peakTime: null, troughTime: null };
  }

  let startingBalance = toNumber(sorted[0].balance) - toNumber(sorted[0].profit);
  if (!Number.isFinite(startingBalance)) startingBalance = 0;

  let peak = startingBalance;
  let peakTime = sorted[0].time || tradeTimestamp(sorted[0]);
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let trough = startingBalance;
  let drawdownPeak = peak;
  let drawdownPeakTime = peakTime;
  let troughTime = peakTime;

  for (const trade of sorted) {
    const equity = Number.isFinite(Number(trade.balance)) ? toNumber(trade.balance) : startingBalance + toNumber(trade.profit);
    const time = tradeTimestamp(trade);

    if (equity > peak) {
      peak = equity;
      peakTime = time;
    }

    const drawdown = peak - equity;
    const drawdownPct = peak > EPSILON ? (drawdown / peak) * 100 : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = drawdownPct;
      trough = equity;
      drawdownPeak = peak;
      drawdownPeakTime = peakTime;
      troughTime = time;
    }
  }

  return {
    amount: maxDrawdown,
    pct: maxDrawdownPct,
    peak: drawdownPeak,
    trough,
    peakTime: drawdownPeakTime,
    troughTime,
  };
}

export function calculateMaxDrawdownFromProfits(trades = []) {
  const sorted = sortTrades(trades);
  let cumulative = 0;
  let peak = 0;
  let peakTime = sorted[0] ? tradeTimestamp(sorted[0]) : null;
  let maxDrawdown = 0;
  let trough = 0;
  let drawdownPeak = 0;
  let drawdownPeakTime = peakTime;
  let troughTime = peakTime;

  for (const trade of sorted) {
    cumulative += toNumber(trade.profit);
    const time = tradeTimestamp(trade);

    if (cumulative > peak) {
      peak = cumulative;
      peakTime = time;
    }

    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      trough = cumulative;
      drawdownPeak = peak;
      drawdownPeakTime = peakTime;
      troughTime = time;
    }
  }

  return {
    amount: maxDrawdown,
    pct: drawdownPeak > EPSILON ? (maxDrawdown / drawdownPeak) * 100 : null,
    peak: drawdownPeak,
    trough,
    peakTime: drawdownPeakTime,
    troughTime,
  };
}

export function calculateLongestLosingStreak(trades = []) {
  const sorted = sortTrades(trades);
  let current = { count: 0, amount: 0, startTime: null, endTime: null };
  let worst = { ...current };

  for (const trade of sorted) {
    const profit = toNumber(trade.profit);
    const time = tradeTimestamp(trade);

    if (profit <= EPSILON) {
      if (current.count === 0) current.startTime = time;
      current.count += 1;
      current.amount += profit;
      current.endTime = time;

      if (
        current.count > worst.count ||
        (current.count === worst.count && Math.abs(current.amount) > Math.abs(worst.amount))
      ) {
        worst = { ...current };
      }
      continue;
    }

    current = { count: 0, amount: 0, startTime: null, endTime: null };
  }

  return worst;
}

function buildMonthlyStability(trades = []) {
  const months = buildPeriodStats(trades, monthKeyUTC);
  const activeMonths = months.length;
  const greenMonths = months.filter(m => m.netProfit > EPSILON).length;
  const redMonths = months.filter(m => m.netProfit < -EPSILON).length;
  const flatMonths = activeMonths - greenMonths - redMonths;
  const bestMonth = months.reduce((best, m) => (!best || m.netProfit > best.netProfit ? m : best), null);
  const worstMonth = months.reduce((worst, m) => (!worst || m.netProfit < worst.netProfit ? m : worst), null);
  const netProfit = months.reduce((sum, m) => sum + m.netProfit, 0);

  return {
    activeMonths,
    greenMonths,
    redMonths,
    flatMonths,
    greenMonthRate: activeMonths ? (greenMonths / activeMonths) * 100 : 0,
    avgMonthProfit: activeMonths ? netProfit / activeMonths : 0,
    bestMonth,
    worstMonth,
  };
}

function buildProfitClustering(monthlyStats, yearlyStats, pairStats, totalNetProfit) {
  const positiveMonths = monthlyStats.filter(m => m.netProfit > EPSILON).sort((a, b) => b.netProfit - a.netProfit);
  const positiveMonthProfit = positiveMonths.reduce((sum, m) => sum + m.netProfit, 0);
  const topMonth = positiveMonths[0] || null;
  const topThreeMonths = positiveMonths.slice(0, 3);
  const topThreeProfit = topThreeMonths.reduce((sum, m) => sum + m.netProfit, 0);

  const positivePairs = pairStats.filter(p => p.netProfit > EPSILON).sort((a, b) => b.netProfit - a.netProfit);
  const positivePairProfit = positivePairs.reduce((sum, p) => sum + p.netProfit, 0);
  const topPair = positivePairs[0] || null;

  const positiveYears = yearlyStats.filter(y => y.netProfit > EPSILON).sort((a, b) => b.netProfit - a.netProfit);
  const positiveYearProfit = positiveYears.reduce((sum, y) => sum + y.netProfit, 0);
  const topYear = positiveYears[0] || null;

  const topMonthPositiveShare = positiveMonthProfit > EPSILON && topMonth ? (topMonth.netProfit / positiveMonthProfit) * 100 : 0;
  const topThreeMonthPositiveShare = positiveMonthProfit > EPSILON ? (topThreeProfit / positiveMonthProfit) * 100 : 0;
  const topPairPositiveShare = positivePairProfit > EPSILON && topPair ? (topPair.netProfit / positivePairProfit) * 100 : 0;
  const topYearPositiveShare = positiveYearProfit > EPSILON && topYear ? (topYear.netProfit / positiveYearProfit) * 100 : 0;

  const alerts = [];
  if (monthlyStats.length < 6) alerts.push({ level: "warn", text: "Small monthly sample: use caution before live automation." });
  if (topMonthPositiveShare >= 50) alerts.push({ level: "warn", text: "Best month contributes at least half of positive monthly profit." });
  if (monthlyStats.length >= 4 && topThreeMonthPositiveShare >= 80) alerts.push({ level: "warn", text: "Top 3 months contribute at least 80% of positive monthly profit." });
  if (pairStats.length > 1 && topPairPositiveShare >= 65) alerts.push({ level: "warn", text: "One pair dominates positive pair profit." });
  if (totalNetProfit <= EPSILON) alerts.push({ level: "danger", text: "Portfolio net profit is not positive for the tested period." });
  if (alerts.length === 0) alerts.push({ level: "ok", text: "No major profit concentration flags from the current sample." });

  return {
    positiveMonthProfit,
    topMonth,
    topThreeMonths,
    topMonthPositiveShare,
    topThreeMonthPositiveShare,
    topPair,
    topPairPositiveShare,
    topYear,
    topYearPositiveShare,
    alerts,
  };
}

//noinspection JSUnusedGlobalSymbols
export function computeRobustnessReport(rawTrades = []) {
  const trades = sortTrades(rawTrades).filter(t => tradeTimestamp(t));
  const summary = summarizeTrades(trades);
  const monthly = buildPeriodStats(trades, monthKeyUTC);
  const yearly = buildPeriodStats(trades, yearKeyUTC);
  const maxDrawdown = calculateMaxDrawdownFromBalance(trades);
  const longestLosingStreak = calculateLongestLosingStreak(trades);

  const byPair = Array.from(groupBy(trades, t => t.pair || "UNKNOWN").entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pair, pairTrades]) => {
      const pairSummary = summarizeTrades(pairTrades);
      const monthlyStability = buildMonthlyStability(pairTrades);
      return {
        pair,
        ...pairSummary,
        maxDrawdown: calculateMaxDrawdownFromProfits(pairTrades),
        longestLosingStreak: calculateLongestLosingStreak(pairTrades),
        monthlyStability,
      };
    });

  return {
    summary,
    monthly,
    yearly,
    maxDrawdown,
    longestLosingStreak,
    byPair,
    clustering: buildProfitClustering(monthly, yearly, byPair, summary.netProfit),
  };
}

