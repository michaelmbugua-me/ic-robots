/**
 * Technical Indicators
 * Pure JS implementations — no external dependencies
 */

/**
 * Calculate all indicators from an array of OANDA candles
 * @param {Array} candles - array of OANDA candle objects
 * @returns {object} indicators
 */
export function calculateIndicators(candles) {
  const closes = candles.map((c) => parseFloat(c.mid.c));
  const highs = candles.map((c) => parseFloat(c.mid.h));
  const lows = candles.map((c) => parseFloat(c.mid.l));

  return {
    currentPrice: closes[closes.length - 1],
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi: rsi(closes, 14),
    atr: atr(highs, lows, closes, 14),
  };
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

/**
 * Exponential Moving Average
 */
export function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);
  let emaVal = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    emaVal = values[i] * k + emaVal * (1 - k);
  }

  return emaVal;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

/**
 * Relative Strength Index
 */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // First average
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smooth subsequent values
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

/**
 * Average True Range
 */
export function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;

  const trueRanges = [];

  for (let i = 1; i < highs.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(hl, hc, lc));
  }

  // Initial ATR = simple average of first `period` TRs
  let atrVal =
    trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // Wilder smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
  }

  return atrVal;
}
