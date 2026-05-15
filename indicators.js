/**
 * 5-10-20 EMA Scalping Strategy
 * ---------------------------------------------------------------
 * Designed for EURUSD on 5-minute charts, IC Markets cTrader.
 *
 * Signal logic:
 *   1. Trend aligned   → EMA5 > EMA10 > EMA20 (bull) or inverse (bear)
 *   2. Pullback check  → prior candle touched EMA10 or EMA20
 *   3. Early trigger   → current close crosses back above/below EMA10
 *   4. Entry at close, SL at trigger candle low/high, TP at 1:1.5 R:R
 *
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

/**
 * Calculate a full ATR series using Wilder smoothing.
 * @param {{ high: number, low: number, close: number }[]} candles - Oldest first
 * @param {number} period
 * @returns {number[]} ATR values aligned to candles (NaN for warm-up)
 */
export function calcATR(candles, period = 14) {
  const result = new Array(candles.length).fill(NaN);
  if (!Array.isArray(candles) || candles.length < period + 1) return result;

  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  });

  const seed = trueRanges.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  result[period] = seed;
  for (let i = period + 1; i < candles.length; i++) {
    result[i] = ((result[i - 1] * (period - 1)) + trueRanges[i]) / period;
  }

  return result;
}

function normalizeCandle(c) {
  return c.mid
    ? { open: parseFloat(c.mid.o), high: parseFloat(c.mid.h), low: parseFloat(c.mid.l), close: parseFloat(c.mid.c), time: c.time }
    : { open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), time: c.time };
}

// ─── Trend Detection ─────────────────────────────────────────────────────────

/**
 * @typedef {'bull' | 'bear' | 'neutral'} Trend
 */

/**
 * @param {number} ema5
 * @param {number} ema10
 * @param {number} ema20
 * @returns {Trend}
 */
export function detectTrend(ema5, ema10, ema20) {
  if (ema5 > ema10 && ema10 > ema20) return 'bull';
  if (ema5 < ema10 && ema10 < ema20) return 'bear';
  return 'neutral';
}

/**
 * Higher-timeframe directional filter for M5 entries.
 * Default model: H1 close above rising EMA200 = bull, below falling EMA200 = bear.
 *
 * @param {Array} candles - Chronological HTF candles, oldest first
 * @param {{ emaPeriod?: number, requireSlope?: boolean }} opts
 * @returns {{ trend: Trend, ema: number|null, close: number|null, reason: string }}
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

// ─── Pullback Detection ──────────────────────────────────────────────────────

/**
 * True if the previous candle's wick touched EMA10 or EMA20.
 * @param {{ low: number, high: number }} prevCandle
 * @param {number} ema10
 * @param {number} ema20
 * @param {Trend}  trend
 * @returns {boolean}
 */
export function hasPullback(prevCandle, ema10, ema20, trend) {
  const { low, high } = prevCandle;
  if (trend === 'bull') return low <= ema10 || low <= ema20;
  if (trend === 'bear') return high >= ema10 || high >= ema20;
  return false;
}

// ─── Early Trigger ───────────────────────────────────────────────────────────

/**
 * Fire on the first candle to close back through EMA10 after a pullback.
 * @param {number} prevClose
 * @param {number} currClose
 * @param {number} ema10
 * @param {Trend}  trend
 * @returns {boolean}
 */
export function hasEarlyTrigger(prevClose, currClose, ema10, trend) {
  if (trend === 'bull') return prevClose <= ema10 && currClose > ema10;
  if (trend === 'bear') return prevClose >= ema10 && currClose < ema10;
  return false;
}

// ─── Risk / Trade Parameters ─────────────────────────────────────────────────

/**
 * @param {number} entryPrice
 * @param {{ high: number, low: number }} triggerCandle
 * @param {Trend}  trend
 * @param {{ pipBuffer?: number, rrRatio?: number, isJPY?: boolean }} opts
 * @returns {{ sl: number, tp: number, riskPips: number, rewardPips: number }}
 */
export function calcTradeParams(entryPrice, triggerCandle, trend, opts = {}) {
  const pipBuffer = opts.pipBuffer ?? 0.00005;
  const rrRatio   = opts.rrRatio   ?? 1.5;
  const pipSize   = opts.isJPY ? 0.01 : 0.0001;

  const sl = trend === 'bull'
    ? triggerCandle.low  - pipBuffer
    : triggerCandle.high + pipBuffer;

  const risk   = Math.abs(entryPrice - sl);
  const reward = risk * rrRatio;
  const tp     = trend === 'bull' ? entryPrice + reward : entryPrice - reward;

  return {
    sl:         +sl.toFixed(5),
    tp:         +tp.toFixed(5),
    riskPips:   +(risk   / pipSize).toFixed(1),
    rewardPips: +(reward / pipSize).toFixed(1),
  };
}

/**
 * Sell-only Smash setup for EURUSD M5:
 * - H1 trend must be bear
 * - close[-1] > high[-2]
 * - close[-1] < close[-N]
 * - smash candle range must be valid vs ATR
 * - pending sell stop below smash candle low
 * - structure stop above smash high, rejected if too wide vs ATR/risk caps
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @returns {{ signal: 'sell_stop'|'none', direction: 'SELL'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, atrPips: number|null, reason: string }}
 */
export function generateSmashSellSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    atrPips: null,
    ...extras,
    reason,
  });

  const trendLookbackBars = opts.trendLookbackBars ?? 30;
  const atrPeriod = opts.atrPeriod ?? 20;
  const requiredCandles = Math.max(trendLookbackBars + 1, atrPeriod + 2, 3);
  if (!Array.isArray(candles) || candles.length < requiredCandles) {
    return NO_SIGNAL(`Not enough candles for Smash Sell setup (need ≥${requiredCandles})`);
  }

  const pipSize = opts.isJPY ? 0.01 : 0.0001;
  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  if (higherTimeframeTrend && higherTimeframeTrend !== 'bear') {
    return NO_SIGNAL(`H1 trend filter blocked sell setup — HTF trend ${higherTimeframeTrend}`, { higherTimeframeTrend });
  }

  const last = norm.length - 1;
  const prev = last - 1;
  const smash = norm[last];
  const previous = norm[prev];
  const trendAnchor = norm[last - trendLookbackBars];

  if (!(smash.close > previous.high)) {
    return NO_SIGNAL('No bearish Smash setup — close[-1] did not close above high[-2]');
  }

  if (!(smash.close < trendAnchor.close)) {
    return NO_SIGNAL(`Local trend filter blocked sell — close[-1] ${smash.close.toFixed(5)} is not below close[-${trendLookbackBars}] ${trendAnchor.close.toFixed(5)}`);
  }

  const atrSeries = calcATR(norm, atrPeriod);
  const atr = atrSeries[last];
  if (!Number.isFinite(atr) || atr <= 0) {
    return NO_SIGNAL(`ATR(${atrPeriod}) not ready`);
  }

  const smashRange = smash.high - smash.low;
  const smashAtrRatio = smashRange / atr;
  const minSmashAtr = opts.minSmashAtr ?? 0.8;
  const maxSmashAtr = opts.maxSmashAtr ?? 2.5;
  if (smashAtrRatio < minSmashAtr || smashAtrRatio > maxSmashAtr) {
    return NO_SIGNAL(
      `Smash range invalid (${smashAtrRatio.toFixed(2)}×ATR) — required ${minSmashAtr}–${maxSmashAtr}×ATR`,
      { atrPips: +(atr / pipSize).toFixed(1), smashAtrRatio: +smashAtrRatio.toFixed(2) },
    );
  }

  const entryBuffer = (opts.entryBufferPips ?? 1.0) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 1.0) * pipSize;
  const entry = smash.low - entryBuffer;
  const sl = smash.high + stopBuffer;
  const risk = sl - entry;
  const atrRiskCap = atr * (opts.atrStopMultiplier ?? 2.5);
  const rrRatio = opts.rrRatio ?? 1.5;
  const tp = entry - (risk * rrRatio);
  const riskPips = risk / pipSize;
  const rewardPips = (risk * rrRatio) / pipSize;
  const minRiskPips = opts.minRiskPips ?? 4;
  const maxRiskPips = opts.maxRiskPips ?? 15;

  if (risk <= 0) return NO_SIGNAL('Invalid Smash Sell risk — SL is not above entry');
  if (risk > atrRiskCap) {
    return NO_SIGNAL(
      `Structure risk too wide vs ATR (${riskPips.toFixed(1)}p > ${(atrRiskCap / pipSize).toFixed(1)}p ATR cap)`,
      { atrPips: +(atr / pipSize).toFixed(1), smashAtrRatio: +smashAtrRatio.toFixed(2) },
    );
  }
  if (riskPips < minRiskPips) return NO_SIGNAL(`Risk too small (${riskPips.toFixed(1)} pips) — below ${minRiskPips}p minimum`);
  if (riskPips > maxRiskPips) return NO_SIGNAL(`Risk too large (${riskPips.toFixed(1)} pips) — above ${maxRiskPips}p maximum`);

  return {
    signal: 'sell_stop',
    direction: 'SELL',
    trend: 'bear',
    entry: +entry.toFixed(5),
    sl: +sl.toFixed(5),
    tp: +tp.toFixed(5),
    riskPips: +riskPips.toFixed(1),
    rewardPips: +rewardPips.toFixed(1),
    atrPips: +(atr / pipSize).toFixed(1),
    smashAtrRatio: +smashAtrRatio.toFixed(2),
    setupTime: smash.time,
    reason: `SMASH SELL — H1 bear, close[-1] > high[-2], local trend down, range ${smashAtrRatio.toFixed(2)}×ATR. ` +
            `Sell stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${tp.toFixed(5)}; risk ${riskPips.toFixed(1)}p reward ${rewardPips.toFixed(1)}p`,
  };
}

/**
 * Buy-only Smash setup for EURUSD M5:
 * - H1 trend must be bull
 * - close[-1] < low[-2]
 * - close[-1] > close[-N]
 * - smash candle range must be valid vs ATR
 * - pending buy stop above smash candle high
 * - structure stop below smash low, rejected if too wide vs ATR/risk caps
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @returns {{ signal: 'buy_stop'|'none', direction: 'BUY'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, atrPips: number|null, reason: string }}
 */
export function generateSmashBuySignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    atrPips: null,
    ...extras,
    reason,
  });

  const trendLookbackBars = opts.trendLookbackBars ?? 30;
  const atrPeriod = opts.atrPeriod ?? 20;
  const requiredCandles = Math.max(trendLookbackBars + 1, atrPeriod + 2, 3);
  if (!Array.isArray(candles) || candles.length < requiredCandles) {
    return NO_SIGNAL(`Not enough candles for Smash Buy setup (need ≥${requiredCandles})`);
  }

  const pipSize = opts.isJPY ? 0.01 : 0.0001;
  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  if (higherTimeframeTrend && higherTimeframeTrend !== 'bull') {
    return NO_SIGNAL(`H1 trend filter blocked buy setup — HTF trend ${higherTimeframeTrend}`, { higherTimeframeTrend });
  }

  const last = norm.length - 1;
  const prev = last - 1;
  const smash = norm[last];
  const previous = norm[prev];
  const trendAnchor = norm[last - trendLookbackBars];

  if (!(smash.close < previous.low)) {
    return NO_SIGNAL('No bullish Smash setup — close[-1] did not close below low[-2]');
  }

  if (!(smash.close > trendAnchor.close)) {
    return NO_SIGNAL(`Local trend filter blocked buy — close[-1] ${smash.close.toFixed(5)} is not above close[-${trendLookbackBars}] ${trendAnchor.close.toFixed(5)}`);
  }

  const atrSeries = calcATR(norm, atrPeriod);
  const atr = atrSeries[last];
  if (!Number.isFinite(atr) || atr <= 0) {
    return NO_SIGNAL(`ATR(${atrPeriod}) not ready`);
  }

  const smashRange = smash.high - smash.low;
  const smashAtrRatio = smashRange / atr;
  const minSmashAtr = opts.minSmashAtr ?? 0.8;
  const maxSmashAtr = opts.maxSmashAtr ?? 2.5;
  if (smashAtrRatio < minSmashAtr || smashAtrRatio > maxSmashAtr) {
    return NO_SIGNAL(
      `Smash range invalid (${smashAtrRatio.toFixed(2)}×ATR) — required ${minSmashAtr}–${maxSmashAtr}×ATR`,
      { atrPips: +(atr / pipSize).toFixed(1), smashAtrRatio: +smashAtrRatio.toFixed(2) },
    );
  }

  const entryBuffer = (opts.entryBufferPips ?? 1.0) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 1.0) * pipSize;
  const entry = smash.high + entryBuffer;
  const sl = smash.low - stopBuffer;
  const risk = entry - sl;
  const atrRiskCap = atr * (opts.atrStopMultiplier ?? 2.5);
  const rrRatio = opts.rrRatio ?? 1.5;
  const tp = entry + (risk * rrRatio);
  const riskPips = risk / pipSize;
  const rewardPips = (risk * rrRatio) / pipSize;
  const minRiskPips = opts.minRiskPips ?? 4;
  const maxRiskPips = opts.maxRiskPips ?? 15;

  if (risk <= 0) return NO_SIGNAL('Invalid Smash Buy risk — SL is not below entry');
  if (risk > atrRiskCap) {
    return NO_SIGNAL(
      `Structure risk too wide vs ATR (${riskPips.toFixed(1)}p > ${(atrRiskCap / pipSize).toFixed(1)}p ATR cap)`,
      { atrPips: +(atr / pipSize).toFixed(1), smashAtrRatio: +smashAtrRatio.toFixed(2) },
    );
  }
  if (riskPips < minRiskPips) return NO_SIGNAL(`Risk too small (${riskPips.toFixed(1)} pips) — below ${minRiskPips}p minimum`);
  if (riskPips > maxRiskPips) return NO_SIGNAL(`Risk too large (${riskPips.toFixed(1)} pips) — above ${maxRiskPips}p maximum`);

  return {
    signal: 'buy_stop',
    direction: 'BUY',
    trend: 'bull',
    entry: +entry.toFixed(5),
    sl: +sl.toFixed(5),
    tp: +tp.toFixed(5),
    riskPips: +riskPips.toFixed(1),
    rewardPips: +rewardPips.toFixed(1),
    atrPips: +(atr / pipSize).toFixed(1),
    smashAtrRatio: +smashAtrRatio.toFixed(2),
    setupTime: smash.time,
    reason: `SMASH BUY — H1 bull, close[-1] < low[-2], local trend up, range ${smashAtrRatio.toFixed(2)}×ATR. ` +
            `Buy stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${tp.toFixed(5)}; risk ${riskPips.toFixed(1)}p reward ${rewardPips.toFixed(1)}p`,
  };
}

/**
 * H1-biased Session Liquidity Sweep + Reclaim setup for EURUSD M5.
 * Levels are supplied by the caller to avoid lookahead, e.g. Asian high/low
 * and previous-day high/low known at the current backtest/live timestamp.
 *
 * Long:
 * - H1 trend bull
 * - candle sweeps below a known low and closes back above it
 * - lower wick confirms rejection
 *
 * Short:
 * - H1 trend bear
 * - candle sweeps above a known high and closes back below it
 * - upper wick confirms rejection
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @param {{ name: string, side: 'high'|'low', price: number, priority?: number }[]} opts.levels
 * @returns {{ signal: 'buy_stop'|'sell_stop'|'none', direction: 'BUY'|'SELL'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, reason: string }}
 */
export function generateSessionSweepSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    atrPips: null,
    ...extras,
    reason,
  });

  const levels = Array.isArray(opts.levels) ? opts.levels : [];
  if (levels.length === 0) return NO_SIGNAL('No liquidity levels available for session sweep');

  const atrPeriod = opts.atrPeriod ?? 20;
  if (!Array.isArray(candles) || candles.length < atrPeriod + 2) {
    return NO_SIGNAL(`Not enough candles for Session Sweep setup (need ≥${atrPeriod + 2})`);
  }

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  if (!['bull', 'bear'].includes(higherTimeframeTrend)) {
    return NO_SIGNAL(`H1 trend filter blocked sweep setup — HTF trend ${higherTimeframeTrend ?? 'none'}`);
  }

  const allowedDirections = Array.isArray(opts.allowedDirections)
    ? opts.allowedDirections.map(d => String(d).toUpperCase())
    : [];

  const pipSize = opts.isJPY ? 0.01 : 0.0001;
  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const last = norm.length - 1;
  const candle = norm[last];
  const range = candle.high - candle.low;
  if (range <= 0) return NO_SIGNAL('Invalid sweep candle range');

  const atrSeries = calcATR(norm, atrPeriod);
  const atr = atrSeries[last];
  if (!Number.isFinite(atr) || atr <= 0) return NO_SIGNAL(`ATR(${atrPeriod}) not ready`);

  const atrPips = atr / pipSize;
  const minAtrPips = opts.minAtrPips ?? 0;
  const maxAtrPips = opts.maxAtrPips ?? Infinity;
  if (atrPips < minAtrPips || atrPips > maxAtrPips) {
    return NO_SIGNAL(`ATR regime invalid (${atrPips.toFixed(1)}p) — required ${minAtrPips}–${maxAtrPips}p`);
  }

  const candleAtrRatio = range / atr;
  const minCandleAtr = opts.minCandleAtr ?? 0.8;
  const maxCandleAtr = opts.maxCandleAtr ?? 2.5;
  if (candleAtrRatio < minCandleAtr || candleAtrRatio > maxCandleAtr) {
    return NO_SIGNAL(
      `Sweep candle range invalid (${candleAtrRatio.toFixed(2)}×ATR) — required ${minCandleAtr}–${maxCandleAtr}×ATR`,
      { atrPips: +atrPips.toFixed(1), candleAtrRatio: +candleAtrRatio.toFixed(2) },
    );
  }

  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  const upperWickRatio = (candle.high - bodyHigh) / range;
  const lowerWickRatio = (bodyLow - candle.low) / range;
  const minWickRatio = opts.minWickRatio ?? 0.4;
  const minSweep = (opts.minSweepPips ?? 0.5) * pipSize;
  const entryBuffer = (opts.entryBufferPips ?? 0.5) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 0.5) * pipSize;
  const rrRatio = opts.rrRatio ?? 1.5;
  const minRiskPips = opts.minRiskPips ?? 4;
  const maxRiskPips = opts.maxRiskPips ?? 15;

  const candidates = [];

  for (const level of levels) {
    const levelPrice = Number(level.price);
    if (!Number.isFinite(levelPrice) || levelPrice <= 0) continue;

    if (higherTimeframeTrend === 'bull' && level.side === 'low' && (allowedDirections.length === 0 || allowedDirections.includes('BUY'))) {
      const swept = candle.low <= levelPrice - minSweep;
      const reclaimed = candle.close > levelPrice;
      if (!swept || !reclaimed || lowerWickRatio < minWickRatio) continue;

      const entry = candle.high + entryBuffer;
      const sl = candle.low - stopBuffer;
      const risk = entry - sl;
      const riskPips = risk / pipSize;
      if (risk <= 0 || riskPips < minRiskPips || riskPips > maxRiskPips) continue;

      const reward = risk * rrRatio;
      const sweepPips = (levelPrice - candle.low) / pipSize;
      candidates.push({
        score: (level.priority ?? 1) * 10 + sweepPips + lowerWickRatio,
        signal: 'buy_stop',
        direction: 'BUY',
        trend: 'bull',
        entry: +entry.toFixed(5),
        sl: +sl.toFixed(5),
        tp: +(entry + reward).toFixed(5),
        riskPips: +riskPips.toFixed(1),
        rewardPips: +(reward / pipSize).toFixed(1),
        atrPips: +atrPips.toFixed(1),
        candleAtrRatio: +candleAtrRatio.toFixed(2),
        wickRatio: +lowerWickRatio.toFixed(2),
        levelName: level.name,
        levelPrice: +levelPrice.toFixed(5),
        setupTime: candle.time,
        strategy: 'session_sweep',
        pendingExpiryBars: opts.pendingExpiryBars,
        timeExitBars: opts.timeExitBars,
        reason: `SESSION SWEEP BUY — H1 bull, swept/reclaimed ${level.name} ${levelPrice.toFixed(5)}, lower wick ${(lowerWickRatio * 100).toFixed(0)}%, range ${candleAtrRatio.toFixed(2)}×ATR. ` +
                `Buy stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${(entry + reward).toFixed(5)}`,
      });
    }

    if (higherTimeframeTrend === 'bear' && level.side === 'high' && (allowedDirections.length === 0 || allowedDirections.includes('SELL'))) {
      const swept = candle.high >= levelPrice + minSweep;
      const reclaimed = candle.close < levelPrice;
      if (!swept || !reclaimed || upperWickRatio < minWickRatio) continue;

      const entry = candle.low - entryBuffer;
      const sl = candle.high + stopBuffer;
      const risk = sl - entry;
      const riskPips = risk / pipSize;
      if (risk <= 0 || riskPips < minRiskPips || riskPips > maxRiskPips) continue;

      const reward = risk * rrRatio;
      const sweepPips = (candle.high - levelPrice) / pipSize;
      candidates.push({
        score: (level.priority ?? 1) * 10 + sweepPips + upperWickRatio,
        signal: 'sell_stop',
        direction: 'SELL',
        trend: 'bear',
        entry: +entry.toFixed(5),
        sl: +sl.toFixed(5),
        tp: +(entry - reward).toFixed(5),
        riskPips: +riskPips.toFixed(1),
        rewardPips: +(reward / pipSize).toFixed(1),
        atrPips: +atrPips.toFixed(1),
        candleAtrRatio: +candleAtrRatio.toFixed(2),
        wickRatio: +upperWickRatio.toFixed(2),
        levelName: level.name,
        levelPrice: +levelPrice.toFixed(5),
        setupTime: candle.time,
        strategy: 'session_sweep',
        pendingExpiryBars: opts.pendingExpiryBars,
        timeExitBars: opts.timeExitBars,
        reason: `SESSION SWEEP SELL — H1 bear, swept/reclaimed ${level.name} ${levelPrice.toFixed(5)}, upper wick ${(upperWickRatio * 100).toFixed(0)}%, range ${candleAtrRatio.toFixed(2)}×ATR. ` +
                `Sell stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${(entry - reward).toFixed(5)}`,
      });
    }
  }

  if (candidates.length === 0) {
    return NO_SIGNAL('No valid liquidity sweep/reclaim at configured session levels', {
      atrPips: +atrPips.toFixed(1),
      candleAtrRatio: +candleAtrRatio.toFixed(2),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const { score, ...best } = candidates[0];
  return best;
}

/**
 * NY Opening Range Breakout / Continuation for EURUSD M5.
 * Opening range is supplied by the caller to avoid lookahead.
 *
 * Long:
 * - H1 trend bull
 * - M5 candle closes above NY opening range high with body/close strength
 * - pending buy stop above breakout candle high
 *
 * Short:
 * - H1 trend bear
 * - M5 candle closes below NY opening range low with body/close weakness
 * - pending sell stop below breakout candle low
 *
 * @param {Array} candles - Closed M5 candles, oldest first
 * @param {object} opts
 * @param {{ high: number, low: number, start: number, end: number, name?: string }} opts.openingRange
 * @returns {{ signal: 'buy_stop'|'sell_stop'|'none', direction: 'BUY'|'SELL'|null, entry: number|null, sl: number|null, tp: number|null, riskPips: number|null, rewardPips: number|null, reason: string }}
 */
export function generateNYOpeningRangeBreakoutSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none',
    direction: null,
    entry: null,
    sl: null,
    tp: null,
    riskPips: null,
    rewardPips: null,
    atrPips: null,
    ...extras,
    reason,
  });

  const openingRange = opts.openingRange;
  if (!openingRange || !Number.isFinite(openingRange.high) || !Number.isFinite(openingRange.low)) {
    return NO_SIGNAL('NY ORB opening range unavailable');
  }

  const atrPeriod = opts.atrPeriod ?? 20;
  if (!Array.isArray(candles) || candles.length < atrPeriod + 2) {
    return NO_SIGNAL(`Not enough candles for NY ORB setup (need ≥${atrPeriod + 2})`);
  }

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string' ? opts.higherTimeframeTrend : null;
  if (!['bull', 'bear'].includes(higherTimeframeTrend)) {
    return NO_SIGNAL(`H1 trend filter blocked NY ORB — HTF trend ${higherTimeframeTrend ?? 'none'}`);
  }

  const allowedDirections = Array.isArray(opts.allowedDirections)
    ? opts.allowedDirections.map(d => String(d).toUpperCase())
    : [];

  const pipSize = opts.isJPY ? 0.01 : 0.0001;
  const norm = candles.map(normalizeCandle);
  if (norm.some(c => !Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || !Number.isFinite(c.close) || c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  const last = norm.length - 1;
  const candle = norm[last];
  const candleTime = new Date(candle.time);
  const candleHour = candleTime.getUTCHours() + (candleTime.getUTCMinutes() / 60);
  if (candleHour < (opts.openingRangeEndUTC ?? openingRange.end ?? 13.0)) {
    return NO_SIGNAL('NY ORB waiting for opening range to complete');
  }
  if (Number.isFinite(opts.noNewTradeAfterUTC) && candleHour >= opts.noNewTradeAfterUTC) {
    return NO_SIGNAL('NY ORB blocked — after configured no-new-trade time');
  }

  const range = candle.high - candle.low;
  if (range <= 0) return NO_SIGNAL('Invalid NY ORB breakout candle range');

  const atrSeries = calcATR(norm, atrPeriod);
  const atr = atrSeries[last];
  if (!Number.isFinite(atr) || atr <= 0) return NO_SIGNAL(`ATR(${atrPeriod}) not ready`);

  const atrPips = atr / pipSize;
  const minAtrPips = opts.minAtrPips ?? 0;
  const maxAtrPips = opts.maxAtrPips ?? Infinity;
  if (atrPips < minAtrPips || atrPips > maxAtrPips) {
    return NO_SIGNAL(`ATR regime invalid (${atrPips.toFixed(1)}p) — required ${minAtrPips}–${maxAtrPips}p`);
  }

  const openingRangePips = (openingRange.high - openingRange.low) / pipSize;
  const minOpeningRangePips = opts.minOpeningRangePips ?? 0;
  const maxOpeningRangePips = opts.maxOpeningRangePips ?? Infinity;
  if (openingRangePips < minOpeningRangePips || openingRangePips > maxOpeningRangePips) {
    return NO_SIGNAL(`Opening range width invalid (${openingRangePips.toFixed(1)}p) — required ${minOpeningRangePips}–${maxOpeningRangePips}p`);
  }

  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  const closeLocation = (candle.close - candle.low) / range;
  const minBodyRatio = opts.minBodyRatio ?? 0.55;
  const minCloseLocation = opts.minCloseLocation ?? 0.65;
  const breakoutBuffer = (opts.minBreakoutClosePips ?? 0.5) * pipSize;
  const entryBuffer = (opts.entryBufferPips ?? 0.5) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 0.5) * pipSize;
  const rrRatio = opts.rrRatio ?? 1.2;
  const minRiskPips = opts.minRiskPips ?? 4;
  const maxRiskPips = opts.maxRiskPips ?? 15;

  if (bodyRatio < minBodyRatio) {
    return NO_SIGNAL(`Breakout candle body too small (${bodyRatio.toFixed(2)}) — required ≥${minBodyRatio}`);
  }

  if (higherTimeframeTrend === 'bull' && (allowedDirections.length === 0 || allowedDirections.includes('BUY'))) {
    const closedAboveRange = candle.close >= openingRange.high + breakoutBuffer;
    const strongClose = closeLocation >= minCloseLocation;
    if (closedAboveRange && strongClose) {
      const entry = candle.high + entryBuffer;
      const sl = candle.low - stopBuffer;
      const risk = entry - sl;
      const riskPips = risk / pipSize;
      if (risk > 0 && riskPips >= minRiskPips && riskPips <= maxRiskPips) {
        const reward = risk * rrRatio;
        return {
          signal: 'buy_stop',
          direction: 'BUY',
          trend: 'bull',
          entry: +entry.toFixed(5),
          sl: +sl.toFixed(5),
          tp: +(entry + reward).toFixed(5),
          riskPips: +riskPips.toFixed(1),
          rewardPips: +(reward / pipSize).toFixed(1),
          atrPips: +atrPips.toFixed(1),
          openingRangePips: +openingRangePips.toFixed(1),
          bodyRatio: +bodyRatio.toFixed(2),
          closeLocation: +closeLocation.toFixed(2),
          setupTime: candle.time,
          strategy: 'ny_orb',
          sessionKeySuffix: 'ny_orb',
          pendingExpiryBars: opts.pendingExpiryBars,
          timeExitBars: opts.timeExitBars,
          levelName: 'ny_opening_range_high',
          levelPrice: +openingRange.high.toFixed(5),
          reason: `NY ORB BUY — H1 bull, close above opening range high ${openingRange.high.toFixed(5)}, body ${(bodyRatio * 100).toFixed(0)}%, close location ${(closeLocation * 100).toFixed(0)}%. ` +
                  `Buy stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${(entry + reward).toFixed(5)}`,
        };
      }
    }
  }

  if (higherTimeframeTrend === 'bear' && (allowedDirections.length === 0 || allowedDirections.includes('SELL'))) {
    const closedBelowRange = candle.close <= openingRange.low - breakoutBuffer;
    const weakClose = closeLocation <= (1 - minCloseLocation);
    if (closedBelowRange && weakClose) {
      const entry = candle.low - entryBuffer;
      const sl = candle.high + stopBuffer;
      const risk = sl - entry;
      const riskPips = risk / pipSize;
      if (risk > 0 && riskPips >= minRiskPips && riskPips <= maxRiskPips) {
        const reward = risk * rrRatio;
        return {
          signal: 'sell_stop',
          direction: 'SELL',
          trend: 'bear',
          entry: +entry.toFixed(5),
          sl: +sl.toFixed(5),
          tp: +(entry - reward).toFixed(5),
          riskPips: +riskPips.toFixed(1),
          rewardPips: +(reward / pipSize).toFixed(1),
          atrPips: +atrPips.toFixed(1),
          openingRangePips: +openingRangePips.toFixed(1),
          bodyRatio: +bodyRatio.toFixed(2),
          closeLocation: +closeLocation.toFixed(2),
          setupTime: candle.time,
          strategy: 'ny_orb',
          sessionKeySuffix: 'ny_orb',
          pendingExpiryBars: opts.pendingExpiryBars,
          timeExitBars: opts.timeExitBars,
          levelName: 'ny_opening_range_low',
          levelPrice: +openingRange.low.toFixed(5),
          reason: `NY ORB SELL — H1 bear, close below opening range low ${openingRange.low.toFixed(5)}, body ${(bodyRatio * 100).toFixed(0)}%, close location ${(closeLocation * 100).toFixed(0)}%. ` +
                  `Sell stop ${entry.toFixed(5)}, SL ${sl.toFixed(5)}, TP ${(entry - reward).toFixed(5)}`,
        };
      }
    }
  }

  return NO_SIGNAL('No valid NY opening range breakout confirmation', {
    atrPips: +atrPips.toFixed(1),
    openingRangePips: +openingRangePips.toFixed(1),
    bodyRatio: +bodyRatio.toFixed(2),
    closeLocation: +closeLocation.toFixed(2),
  });
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

  const minBreak = (opts.minBreakPips ?? 1.0) * pipSize;
  const entryBuffer = (opts.entryBufferPips ?? 0.5) * pipSize;
  const stopBuffer = (opts.stopBufferPips ?? 0.5) * pipSize;
  const rrRatio = opts.rrRatio ?? 1.2;
  const minRiskPips = opts.minRiskPips ?? 5;
  const maxRiskPips = opts.maxRiskPips ?? 10;
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

// ─── Main Signal Generator ───────────────────────────────────────────────────

/**
 * Generate a trading signal from the latest candle data.
 *
 * Accepts candles in cTrader project format: { mid: { o, h, l, c }, time }
 * OR plain { open, high, low, close, time } objects.
 *
 * @param {Array} candles - Chronological (oldest first), min 22 recommended
 * @param {object} opts   - Passed to calcTradeParams (pipBuffer, rrRatio, isJPY, minRiskPips, maxRiskPips, emaSeparationMinPips, higherTimeframeTrend)
 * @returns {{
 *   signal: 'buy'|'sell'|'none', trend: Trend,
 *   entry: number|null, sl: number|null, tp: number|null,
 *   riskPips: number|null, rewardPips: number|null,
 *   ema5: number, ema10: number, ema20: number, reason: string
 * }}
 */
export function generateSignal(candles, opts = {}) {
  const NO_SIGNAL = (reason, extras = {}) => ({
    signal: 'none', trend: 'neutral',
    entry: null, sl: null, tp: null,
    riskPips: null, rewardPips: null,
    ema5: NaN, ema10: NaN, ema20: NaN,
    ...extras, reason,
  });

  if (!candles || candles.length < 22) {
    return NO_SIGNAL('Not enough candles for EMA20 warm-up (need ≥22)');
  }

  const norm    = candles.map(normalizeCandle);
  const closes  = norm.map(c => c.close);

  if (norm.some(c => !Number.isFinite(c.close) || !Number.isFinite(c.high) || !Number.isFinite(c.low) || c.close <= 0 || c.high <= 0 || c.low <= 0)) {
    return NO_SIGNAL('Invalid candle data — NaN or zero prices detected');
  }

  // 1. EMAs
  const ema5Series  = calcEMA(closes, 5);
  const ema10Series = calcEMA(closes, 10);
  const ema20Series = calcEMA(closes, 20);

  const last = candles.length - 1;
  const prev = last - 1;

  const ema5  = ema5Series[last];
  const ema10 = ema10Series[last];
  const ema20 = ema20Series[last];

  // 2. Trend alignment
  const trend     = detectTrend(ema5, ema10, ema20);
  const baseExtras = { ema5: +ema5.toFixed(5), ema10: +ema10.toFixed(5), ema20: +ema20.toFixed(5), trend };

  if (trend === 'neutral') {
    return NO_SIGNAL('Trend not aligned — EMAs in neutral / choppy state', baseExtras);
  }

  const higherTimeframeTrend = typeof opts.higherTimeframeTrend === 'string'
    ? opts.higherTimeframeTrend
    : null;
  if (higherTimeframeTrend && higherTimeframeTrend !== trend) {
    return NO_SIGNAL(
      `Higher-timeframe filter blocked trade — M5 trend ${trend}, HTF trend ${higherTimeframeTrend}`,
      { ...baseExtras, higherTimeframeTrend },
    );
  }

  // Optional chop filter: require enough spacing between fast and slow EMAs
  const pipSize = opts.isJPY ? 0.01 : 0.0001;
  const emaSeparationPips = Math.abs(ema5 - ema20) / pipSize;
  const emaSeparationMinPips = opts.emaSeparationMinPips ?? 0;
  if (emaSeparationPips < emaSeparationMinPips) {
    return NO_SIGNAL(
      `EMA separation too small (${emaSeparationPips.toFixed(1)} pips) — below minimum ${emaSeparationMinPips} pip threshold`,
      baseExtras,
    );
  }

  // 3. Pullback on previous candle
  const prevEma10 = ema10Series[prev];
  const prevEma20 = ema20Series[prev];
  if (!hasPullback(norm[prev], prevEma10, prevEma20, trend)) {
    return NO_SIGNAL('No pullback to EMA10/20 on previous candle', baseExtras);
  }

  // 4. Early trigger: close crosses back through EMA10
  if (!hasEarlyTrigger(closes[prev], closes[last], ema10, trend)) {
    return NO_SIGNAL('Pullback present but early trigger not yet fired', baseExtras);
  }

  // 5. Trade parameters
  const entry = closes[last];
  const { sl, tp, riskPips, rewardPips } = calcTradeParams(entry, norm[last], trend, opts);
  const minRiskPips = opts.minRiskPips ?? 2;
  const maxRiskPips = opts.maxRiskPips ?? Infinity;

  if (riskPips < minRiskPips) {
    return NO_SIGNAL(`Risk too small (${riskPips} pips) — below minimum ${minRiskPips} pip threshold`, baseExtras);
  }

  if (riskPips > maxRiskPips) {
    return NO_SIGNAL(`Risk too large (${riskPips} pips) — above maximum ${maxRiskPips} pip threshold`, baseExtras);
  }

  return {
    signal:     trend === 'bull' ? 'buy' : 'sell',
    trend,
    entry:      +entry.toFixed(5),
    sl,
    tp,
    riskPips,
    rewardPips,
    ...baseExtras,
    reason: `${trend.toUpperCase()} — trend aligned, pullback confirmed, early trigger fired. ` +
            `Risk: ${riskPips} pips | Reward: ${rewardPips} pips (1:${opts.rrRatio ?? 1.5})`,
  };
}
