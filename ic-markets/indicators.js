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
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = seed;
  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
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

// ─── Main Signal Generator ───────────────────────────────────────────────────

/**
 * Generate a trading signal from the latest candle data.
 *
 * Accepts candles in cTrader project format: { mid: { o, h, l, c }, time }
 * OR plain { open, high, low, close, time } objects.
 *
 * @param {Array} candles - Chronological (oldest first), min 22 recommended
 * @param {object} opts   - Passed to calcTradeParams (pipBuffer, rrRatio, isJPY, minRiskPips, maxRiskPips, emaSeparationMinPips)
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

  // Support both { mid: { c, h, l } } and plain { close, high, low }
  const normalize = c => c.mid
    ? { close: parseFloat(c.mid.c), high: parseFloat(c.mid.h), low: parseFloat(c.mid.l) }
    : { close: c.close, high: c.high, low: c.low };

  const norm    = candles.map(normalize);
  const closes  = norm.map(c => c.close);

  if (closes.some(v => isNaN(v) || v === 0)) {
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
