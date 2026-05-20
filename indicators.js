/**
 * Strategy indicators and signal generators for IC Markets cTrader candles.
 * Candle format expected: { mid: { o, h, l, c }, time, ... }
 */

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

  const pipSize = opts.isJPY ? 0.01 : 0.0001;
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
  if (priorNyCandles.some(c => c.high >= asianRange.high + minBreak || c.low <= asianRange.low - minBreak)) {
    return NO_SIGNAL('NY Asian range already broke earlier this session');
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
    ? candle.low - stopBuffer
    : candle.high + stopBuffer;
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

