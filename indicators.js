/**
 * Strategy indicators and signal generators for IC Markets cTrader candles.
 * Candle format expected: { mid: { o, h, l, c }, time, ... }
 */

import { getPipSize } from "./instrument-utils.js";

// ─── EMA Calculation ─────────────────────────────────────────────────────────

/**
 * Calculate a full EMA series for a given period.
 * @param {number[]} closes - Oldest first
 * @param {number}   period
 * @returns {number[]} EMA values aligned to closes (NaN for warm-up)
 */
export function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(NaN);
  result[period - 1] = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}


function normalizeCandle(c) {
  return c.mid
    ? { open: parseFloat(c.mid.o), high: parseFloat(c.mid.h), low: parseFloat(c.mid.l), close: parseFloat(c.mid.c), time: c.time }
    : { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), time: c.time };
}

/**
 * Higher-timeframe directional filter for M5 entries.
 * Default model: H1 close above rising EMA200 = bull, below falling EMA200 = bear.
 *
 * @param {Array} candles - Chronological HTF candles, oldest first
 * @param {{ emaPeriod?: number, requireSlope?: boolean }} opts
 * @returns {{ trend: 'bull'|'bear'|'neutral', ema: number|null, close: number|null, reason: string }}
 */
export function detectHigherTimeframeTrend(candles, opts = {}) {
  const emaPeriod = opts.emaPeriod ?? 200;
  const requireSlope = opts.requireSlope ?? true;

  if (!Array.isArray(candles) || candles.length < emaPeriod + 2) {
    return {
      trend: 'neutral',
      ema: null,
      close: null,
      reason: `Not enough higher-timeframe candles for EMA${emaPeriod}`,
    };
  }

  const closes = candles.map(c => c.mid ? parseFloat(c.mid.c) : Number(c.close));
  if (closes.some(v => !Number.isFinite(v) || v <= 0)) {
    return { trend: 'neutral', ema: null, close: null, reason: 'Invalid higher-timeframe close data' };
  }

  const emaSeries = calcEMA(closes, emaPeriod);
  const last = closes.length - 1;
  const ema = emaSeries[last];
  const prevEma = emaSeries[last - 1];
  const close = closes[last];

  if (!Number.isFinite(ema) || !Number.isFinite(prevEma)) {
    return { trend: 'neutral', ema: null, close, reason: `EMA${emaPeriod} not ready` };
  }

  const rising = ema > prevEma;
  const falling = ema < prevEma;

  if (close > ema && (!requireSlope || rising)) {
    return { trend: 'bull', ema: +ema.toFixed(5), close: +close.toFixed(5), reason: `HTF close above ${requireSlope ? 'rising ' : ''}EMA${emaPeriod}` };
  }

  if (close < ema && (!requireSlope || falling)) {
    return { trend: 'bear', ema: +ema.toFixed(5), close: +close.toFixed(5), reason: `HTF close below ${requireSlope ? 'falling ' : ''}EMA${emaPeriod}` };
  }

  return { trend: 'neutral', ema: +ema.toFixed(5), close: +close.toFixed(5), reason: `HTF close/EMA${emaPeriod} slope not aligned` };
}

/**
 * NY Asian Range Continuation setup for EURUSD M5.
 *
 * Model:
 * - Build Asian range from 00:00–07:00 UTC.
 * - Ignore London continuation entries.
 * - During NY overlap, wait for the first clean NY break of Asian high/low.
 * - Prefer/require H1 alignment, then place a stop entry beyond the Asian level.
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @param {{ high: number, low: number, start?: number, end?: number, name?: string }} opts.asianRange
 * @returns {{ signal: 'buy_stop'|'sell_stop'|'none', direction: 'BUY'|'SELL'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, reason: string }}
 */
export function generateNYAsianContinuationSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    ...extras,
    reason,
  });

  const asianRange = opts.asianRange;
  if (!asianRange || !Number.isFinite(asianRange.high) || !Number.isFinite(asianRange.low) || asianRange.high <= asianRange.low) {
    return NO_SIGNAL('Asian range unavailable or invalid');
  }

  if (!Array.isArray(candles) || candles.length < 20) {
    return NO_SIGNAL('Not enough candles for NY Asian continuation setup');
  }

  const pipSize = opts.pair ? getPipSize(opts.pair) : (opts.isJPY ? 0.01 : 0.0001);
  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const last = norm.length - 1;
  const candle = norm[last];
  const candleTime = new Date(candle.time);
  const hour = candleTime.getUTCHours() + (candleTime.getUTCMinutes() / 60);
  const tradeStartUTC = opts.tradeStartUTC ?? 12.5;
  const tradeEndUTC = opts.tradeEndUTC ?? 15.5;
  const preferAfterUTC = opts.preferAfterUTC ?? 13.0;

  if (hour < tradeStartUTC || hour >= tradeEndUTC) return NO_SIGNAL('Outside NY Asian continuation trade window');
  if (Number.isFinite(preferAfterUTC) && hour < preferAfterUTC) return NO_SIGNAL(`Waiting until preferred NY continuation time ${preferAfterUTC.toFixed(2)} UTC`);

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  const requireH1Alignment = opts.requireH1Alignment ?? true;
  if (requireH1Alignment && !['bull', 'bear'].includes(higherTimeframeTrend)) {
    return NO_SIGNAL(`H1 trend filter blocked NY Asian continuation — HTF trend ${higherTimeframeTrend ?? 'none'}`);
  }

  const minBreak = (opts.minBreakPips ?? 3.0) * pipSize;
  const entryBuffer = (opts.entryBufferPips ?? 0.5) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 0.5) * pipSize;
  const rrRatio = opts.rrRatio ?? 1.2;
  const minRiskPips = opts.minRiskPips ?? 5;
  const maxRiskPips = opts.maxRiskPips ?? 12;
  const day = candleTime.toISOString().slice(0, 10);

  const priorNyCandles = norm.slice(0, last).filter(c => {
    const d = new Date(c.time);
    const h = d.getUTCHours() + (d.getUTCMinutes() / 60);
    return d.toISOString().slice(0, 10) === day && h >= tradeStartUTC && h < tradeEndUTC;
  });
  if (opts.blockOnPriorBreak !== false && priorNyCandles.some(c => c.high >= asianRange.high + minBreak || c.low <= asianRange.low - minBreak)) {
    const brokeCandle = priorNyCandles.find(c => c.high >= asianRange.high + minBreak || c.low <= asianRange.low - minBreak);
    const side = brokeCandle.high >= asianRange.high + minBreak ? 'HIGH' : 'LOW';
    const price = side === 'HIGH' ? brokeCandle.high : brokeCandle.low;
    const target = side === 'HIGH' ? asianRange.high + minBreak : asianRange.low - minBreak;
    return NO_SIGNAL(`NY Asian range already broke ${side} at ${price.toFixed(5)} (target ${target.toFixed(5)}) — session dead`);
  }

  const brokeHigh = candle.high >= asianRange.high + minBreak && candle.close > asianRange.high;
  const brokeLow = candle.low <= asianRange.low - minBreak && candle.close < asianRange.low;
  if (brokeHigh === brokeLow) {
    return NO_SIGNAL('No clean one-sided NY break of Asian high/low');
  }

  const direction = brokeHigh ? 'BUY' : 'SELL';
  const requiredTrend = direction === 'BUY' ? 'bull' : 'bear';
  if (requireH1Alignment && higherTimeframeTrend !== requiredTrend) {
    return NO_SIGNAL(`H1 alignment blocked ${direction} — HTF trend ${higherTimeframeTrend}`);
  }

  const entry = direction === 'BUY'
    ? asianRange.high + entryBuffer
    : asianRange.low - entryBuffer;
  const sl = direction === 'BUY'
    ? Math.min(candle.low, asianRange.high) - stopBuffer
    : Math.max(candle.high, asianRange.low) + stopBuffer;
  const risk = direction === 'BUY' ? entry - sl : sl - entry;
  const riskPips = risk / pipSize;
  if (risk <= 0) return NO_SIGNAL(`Invalid ${direction} risk — stop is on the wrong side of entry`);
  if (riskPips < minRiskPips) return NO_SIGNAL(`Risk too small (${riskPips.toFixed(1)}p) — below ${minRiskPips}p minimum`);
  if (riskPips > maxRiskPips) return NO_SIGNAL(`Risk too large (${riskPips.toFixed(1)}p) — above ${maxRiskPips}p maximum`);

  const reward = risk * rrRatio;
  const tp = direction === 'BUY' ? entry + reward : entry - reward;
  const signal = direction === 'BUY' ? 'buy_stop' : 'sell_stop';
  const levelName = direction === 'BUY' ? 'asian_high' : 'asian_low';
  const levelPrice = direction === 'BUY' ? asianRange.high : asianRange.low;

  return {
    signal,
    direction,
    trend: requiredTrend,
    entry: +entry.toFixed(5),
    sl: +sl.toFixed(5),
    tp: +tp.toFixed(5),
    riskPips: +riskPips.toFixed(1),
    rewardPips: +(reward / pipSize).toFixed(1),
    convictionMultiplier: riskPips <= 6 ? 1.25 : riskPips >= 10 ? 0.75 : 1.0,
    setupTime: candle.time,
    strategy: 'ny_asian_continuation',
    sessionKeySuffix: 'ny_asian_continuation',
    pendingExpiryBars: opts.pendingExpiryBars,
    timeExitBars: opts.timeExitBars,
    forceExitUTC: opts.forceExitUTC ?? 16.0,
    levelName,
    levelPrice: +levelPrice.toFixed(5),
    asianHigh: +asianRange.high.toFixed(5),
    asianLow: +asianRange.low.toFixed(5),
    h1Trend: higherTimeframeTrend,
    reason: `NY ASIAN CONTINUATION ${direction} — first NY break of ${levelName} ${levelPrice.toFixed(5)}, ` +
            `H1 ${higherTimeframeTrend}, stop entry ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${tp.toFixed(5)}; ` +
            `risk ${riskPips.toFixed(1)}p reward ${(reward / pipSize).toFixed(1)}p`,
  };
}

/**
 * London Asian-range fake-break reversal setup.
 *
 * Candidate B research profile:
 * - London session only, default 07:00–10:00 UTC
 * - Tuesday/Wednesday/Thursday only
 * - First one-sided London break of the Asian range
 * - Break must close back inside within 2 M5 bars
 * - Risk must be 5–10 pips
 * - Target is the opposite side of the Asian range
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @param {{ high: number, low: number, start?: number, end?: number, name?: string }} opts.asianRange
 * @returns {{ signal: 'buy'|'sell'|'none', direction: 'BUY'|'SELL'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, reason: string }}
 */
export function generateLondonAsianFakeBreakReversalSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    ...extras,
    reason,
  });

  const asianRange = opts.asianRange;
  if (!asianRange || !Number.isFinite(asianRange.high) || !Number.isFinite(asianRange.low) || asianRange.high <= asianRange.low) {
    return NO_SIGNAL('Asian range unavailable or invalid');
  }

  if (!Array.isArray(candles) || candles.length < 20) {
    return NO_SIGNAL('Not enough candles for London Asian fake-break setup');
  }

  const pipSize = opts.pair ? getPipSize(opts.pair) : (opts.isJPY ? 0.01 : 0.0001);
  const asianRangePips = (asianRange.high - asianRange.low) / pipSize;
  const minAsianRangePips = Number(opts.minAsianRangePips ?? 0);
  const maxAsianRangePips = Number(opts.maxAsianRangePips ?? 0);
  if (Number.isFinite(minAsianRangePips) && minAsianRangePips > 0 && asianRangePips < minAsianRangePips) {
    return NO_SIGNAL(`Asian range too narrow (${asianRangePips.toFixed(1)}p) — below ${minAsianRangePips}p minimum`);
  }
  if (Number.isFinite(maxAsianRangePips) && maxAsianRangePips > 0 && asianRangePips > maxAsianRangePips) {
    return NO_SIGNAL(`Asian range too wide (${asianRangePips.toFixed(1)}p) — above ${maxAsianRangePips}p maximum`);
  }

  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const last = norm.at(-1);
  const latestTime = new Date(last.time);
  const latestHour = latestTime.getUTCHours() + latestTime.getUTCMinutes() / 60;
  const tradeStartUTC = opts.tradeStartUTC ?? 7.0;
  const tradeEndUTC = opts.tradeEndUTC ?? 10.0;
  if (latestHour < tradeStartUTC || latestHour >= tradeEndUTC) {
    return NO_SIGNAL('Outside London fake-break trade window');
  }

  const allowedWeekdays = opts.allowedWeekdays ?? ['Tue', 'Wed', 'Thu'];
  const weekday = weekdayUTC(latestTime);
  if (Array.isArray(allowedWeekdays) && allowedWeekdays.length > 0 && !allowedWeekdays.includes(weekday)) {
    return NO_SIGNAL(`London fake-break blocked on ${weekday}`);
  }

  const minBreak = (opts.minBreakPips ?? 4.0) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 0.5) * pipSize;
  const confirmBars = opts.confirmBars ?? 2;
  const minConfirmationBarsAfterBreak = Math.max(0, Number(opts.minConfirmationBarsAfterBreak ?? 0));
  const minRiskPips = opts.minRiskPips ?? 5;
  const maxRiskPips = opts.maxRiskPips ?? 10;
  const targetMode = opts.targetMode ?? 'asian_opposite';
  const h1Filter = opts.h1Filter ?? 'all';
  const day = latestTime.toISOString().slice(0, 10);

  const london = norm
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => {
      const d = new Date(c.time);
      const h = d.getUTCHours() + d.getUTCMinutes() / 60;
      return d.toISOString().slice(0, 10) === day && h >= tradeStartUTC && h < tradeEndUTC;
    });

  let breakEvent = null;
  for (let localIndex = 0; localIndex < london.length; localIndex++) {
    const { c, index } = london[localIndex];
    const brokeHigh = c.high >= asianRange.high + minBreak;
    const brokeLow = c.low <= asianRange.low - minBreak;
    if (brokeHigh === brokeLow) continue;
    breakEvent = {
      candle: c,
      index,
      localIndex,
      breakDirection: brokeHigh ? 'up' : 'down',
      brokeUp: brokeHigh,
      breakPips: brokeHigh ? (c.high - asianRange.high) / pipSize : (asianRange.low - c.low) / pipSize,
    };
    break;
  }

  if (!breakEvent) return NO_SIGNAL('No one-sided London break of Asian range yet');

  let confirmation = null;
  const maxConfirmLocalIndex = Math.min(london.length - 1, breakEvent.localIndex + confirmBars);
  for (let localIndex = breakEvent.localIndex; localIndex <= maxConfirmLocalIndex; localIndex++) {
    const { c, index } = london[localIndex];
    const closedBackInside = breakEvent.brokeUp ? c.close < asianRange.high : c.close > asianRange.low;
    const barsAfterBreak = localIndex - breakEvent.localIndex;
    if (closedBackInside && barsAfterBreak >= minConfirmationBarsAfterBreak) {
      confirmation = { candle: c, index, localIndex, barsAfterBreak: localIndex - breakEvent.localIndex };
      break;
    }
  }

  if (!confirmation) {
    const latestLondonIndex = london.findIndex(({ c }) => c.time === last.time);
    if (latestLondonIndex > breakEvent.localIndex + confirmBars) {
      return NO_SIGNAL('London fake-break confirmation expired');
    }
    return NO_SIGNAL('Waiting for London break to close back inside Asian range');
  }

  if (confirmation.candle.time !== last.time) {
    return NO_SIGNAL('London fake-break already confirmed on an earlier candle');
  }

  const h1Trend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  const breakAlignedWithH1 = (breakEvent.brokeUp && h1Trend === 'bull') || (!breakEvent.brokeUp && h1Trend === 'bear');
  const reversalAlignedWithH1 = (breakEvent.brokeUp && h1Trend === 'bear') || (!breakEvent.brokeUp && h1Trend === 'bull');
  if (opts.noFadeH1AlignedBreak && breakAlignedWithH1) {
    return NO_SIGNAL(`London fake-break no-fade filter blocked ${breakEvent.breakDirection} break aligned with H1 ${h1Trend}`);
  }
  if (!passesLondonFakeBreakH1Filter(h1Filter, h1Trend, breakAlignedWithH1, reversalAlignedWithH1)) {
    return NO_SIGNAL(`London fake-break H1 filter ${h1Filter} blocked setup — HTF trend ${h1Trend ?? 'none'}`);
  }

  const extremeWindow = norm.slice(breakEvent.index, confirmation.index + 1);
  const direction = breakEvent.brokeUp ? 'SELL' : 'BUY';
  const signal = direction === 'SELL' ? 'sell' : 'buy';
  const entry = confirmation.candle.close;
  const sl = direction === 'SELL'
    ? Math.max(...extremeWindow.map(c => c.high)) + stopBuffer
    : Math.min(...extremeWindow.map(c => c.low)) - stopBuffer;
  const risk = direction === 'SELL' ? sl - entry : entry - sl;
  const riskPips = risk / pipSize;

  let tp = null;
  let reward = null;
  if (targetMode === 'time_exit' && opts.tpRrMultiplier && opts.tpRrMultiplier > 0) {
    reward = risk * opts.tpRrMultiplier;
    tp = direction === 'SELL' ? entry - reward : entry + reward;
  } else if (targetMode !== 'time_exit') {
    tp = direction === 'SELL' ? asianRange.low : asianRange.high;
    reward = direction === 'SELL' ? entry - tp : tp - entry;
  }
  const rewardPips = Number.isFinite(reward) ? reward / pipSize : null;

  if (risk <= 0) return NO_SIGNAL(`Invalid ${direction} risk — stop is on the wrong side of entry`);
  if (targetMode !== 'time_exit' && reward !== null && reward <= 0) return NO_SIGNAL(`Invalid ${direction} target — opposite Asian range side is not beyond entry`);
  if (riskPips < minRiskPips) return NO_SIGNAL(`Risk too small (${riskPips.toFixed(1)}p) — below ${minRiskPips}p minimum`);
  if (riskPips > maxRiskPips) return NO_SIGNAL(`Risk too large (${riskPips.toFixed(1)}p) — above ${maxRiskPips}p maximum`);

  const levelName = breakEvent.brokeUp ? 'asian_high' : 'asian_low';
  const convictionMultiplier = riskPips <= 6 ? 1.25 : riskPips >= 8 ? 0.75 : 1.0;
  return {
    signal,
    direction,
    trend: direction === 'SELL' ? 'bear' : 'bull',
    entry: +entry.toFixed(5),
    sl: +sl.toFixed(5),
    tp: Number.isFinite(tp) ? +tp.toFixed(5) : null,
    riskPips: +riskPips.toFixed(1),
    rewardPips: Number.isFinite(rewardPips) ? +rewardPips.toFixed(1) : null,
    convictionMultiplier,
    setupTime: confirmation.candle.time,
    strategy: 'london_asian_fake_break_reversal',
    targetMode,
    h1Filter,
    h1Trend,
    breakAlignedWithH1,
    reversalAlignedWithH1,
    asianRangePips: +asianRangePips.toFixed(1),
    noFadeH1AlignedBreak: !!opts.noFadeH1AlignedBreak,
    minConfirmationBarsAfterBreak,
    timeExitBars: opts.timeExitBars,
    breakDirection: breakEvent.breakDirection,
    breakPips: +breakEvent.breakPips.toFixed(1),
    confirmationBarsUsed: confirmation.barsAfterBreak,
    levelName,
    asianHigh: +asianRange.high.toFixed(5),
    asianLow: +asianRange.low.toFixed(5),
    weekday,
    tpRrMultiplier: opts.tpRrMultiplier ?? null,
    reason: `LONDON ASIAN FAKE-BREAK ${direction} — ${breakEvent.breakDirection} break of ${levelName}, ` +
            `closed back inside after ${confirmation.barsAfterBreak} bar(s), entry ${entry.toFixed(5)}, ` +
            `SL ${sl.toFixed(5)}, TP ${Number.isFinite(tp) ? tp.toFixed(5) : 'time-exit'}; ` +
            `risk ${riskPips.toFixed(1)}p reward ${Number.isFinite(rewardPips) ? rewardPips.toFixed(1) : `time-exit${opts.tpRrMultiplier ? ` (${opts.tpRrMultiplier}R TP)` : ''}`}p`,
  };
}

function passesLondonFakeBreakH1Filter(filter, h1Trend, breakAlignedWithH1, reversalAlignedWithH1) {
  if (!filter || filter === 'all') return true;
  if (filter === 'break_with_h1') return breakAlignedWithH1;
  if (filter === 'reversal_with_h1') return reversalAlignedWithH1;
  if (filter === 'break_counter_h1') return !breakAlignedWithH1 && h1Trend && h1Trend !== 'neutral';
  if (filter === 'reversal_counter_h1') return !reversalAlignedWithH1 && h1Trend && h1Trend !== 'neutral';
  if (['bull', 'bear', 'neutral'].includes(filter)) return h1Trend === filter;
  return false;
}

function weekdayUTC(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
}

