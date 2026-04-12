/**
 * Technical Indicators — pure JS, no external dependencies
 * Compatible with candle data from IC Markets
 */

import { config } from "./config.js";

export function calculateIndicators(candles) {
  const closes = candles.map((c) => parseFloat(c.mid.c));
  const highs  = candles.map((c) => parseFloat(c.mid.h));
  const lows   = candles.map((c) => parseFloat(c.mid.l));
  const volumes = candles.map((c) => Number(c.volume));
  
  const { emaFast, emaSlow } = config.strategy || { emaFast: 8, emaSlow: 21 };
  
  // Use HLC3 (Typical Price) for VWAP if per-bar VWAP is not available
  const barVwaps = candles.map((c) => (parseFloat(c.mid.h) + parseFloat(c.mid.l) + parseFloat(c.mid.c)) / 3);

  const emaF = ema(closes, emaFast);
  const emaS = ema(closes, emaSlow);
  
  // Calculate EMA Slope (Change over last 3 candles)
  const prevEmaF = ema(closes.slice(0, -1), emaFast);
  const emaSlope = emaF - prevEmaF;

  // Wick/Body Analysis for Rejection
  const lastCandle = candles[candles.length - 1];
  const o = parseFloat(lastCandle.mid.o);
  const h = parseFloat(lastCandle.mid.h);
  const l = parseFloat(lastCandle.mid.l);
  const c = parseFloat(lastCandle.mid.c);
  const body = Math.abs(c - o);
  const lowerWick = Math.min(o, c) - l;
  const upperWick = h - Math.max(o, c);

  // Rejection candle detection (pin bar / hammer)
  const minBody = body || 0.000001; // prevent divide-by-zero
  const isBullishRejection = lowerWick > minBody * 1.5 && lowerWick > upperWick * 1.5;
  const isBearishRejection = upperWick > minBody * 1.5 && upperWick > lowerWick * 1.5;

  // MACD with previous histogram for crossover detection
  const macdResult = macd(closes, 12, 26, 9);
  const macdPrev   = macd(closes.slice(0, -1), 12, 26, 9);
  const prevMacdHist = macdPrev.hist;

  // ADX — trend strength (filters out choppy/ranging markets)
  const adxValue = adx(highs, lows, closes, 14);

  // Volume ratio — current bar volume vs 20-period average
  const volAvg = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : volumes.reduce((a, b) => a + b, 0) / volumes.length;
  const volumeRatio = volAvg > 0 ? volumes[volumes.length - 1] / volAvg : 1;

  return {
    currentPrice: closes[closes.length - 1],
    // Dynamic EMA System based on config
    [`ema${emaFast}`]:  emaF,
    [`ema${emaSlow}`]:  emaS,
    emaSlope,
    // Rejection indicators
    lowerWick,
    upperWick,
    body,
    isBullishRejection,
    isBearishRejection,
    // Short RSI for fast momentum
    rsi:          rsi(closes, 7),
    // Volatility-based stop/profit
    atr:          atr(highs, lows, closes, 14),
    // Rolling VWAP (20 periods)
    vwap:         vwap(barVwaps, volumes, 20),
    // Bollinger Bands (20 periods, 2 stdDev)
    bbands:       bbands(closes, 20, 2),
    // MACD (12, 26, 9) — with previous hist for crossover detection
    macd:         macdResult,
    prevMacdHist,
    // Trend strength — ADX(14)
    adx:          adxValue,
    // Volume ratio (current / 20-period avg). >1.2 = above average activity
    volumeRatio,
    // Momentum: (Last Close - Previous Close)
    momentum:     closes[closes.length - 1] - closes[closes.length - 2]
  };
}

// ─── MACD ────────────────────────────────────────────────────────────────────

export function macd(values, fast, slow, signal) {
  if (values.length < slow + signal) return { macd: null, signal: null, hist: null };
  
  const fastEma = calculateEmaSeries(values, fast);
  const slowEma = calculateEmaSeries(values, slow);
  
  // Align fastEma with slowEma (slowEma starts later since slow > fast)
  const diff = slow - fast;
  const alignedFast = fastEma.slice(diff);
  
  const macdLine = alignedFast.map((f, i) => f - slowEma[i]);
  const signalLine = calculateEmaSeries(macdLine, signal);
  
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  
  return {
    macd: lastMacd,
    signal: lastSignal,
    hist: lastMacd - lastSignal
  };
}

function calculateEmaSeries(values, period) {
  const k = 2 / (period + 1);
  const result = [];
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(val);
  
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// ─── VWAP ────────────────────────────────────────────────────────────────────

export function vwap(prices, volumes, period) {
  if (prices.length < period) return null;
  const p = prices.slice(-period);
  const v = volumes.slice(-period);
  let sumPv = 0;
  let sumV = 0;
  for (let i = 0; i < p.length; i++) {
    sumPv += p[i] * v[i];
    sumV += v[i];
  }
  return sumV === 0 ? p[p.length - 1] : sumPv / sumV;
}

// ─── EMA ─────────────────────────────────────────────────────────────────────

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    val = values[i] * k + val * (1 - k);
  }
  return val;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const d    = values[i] - values[i - 1];
    const g    = d >= 0 ? d : 0;
    const l    = d <  0 ? Math.abs(d) : 0;
    avgGain    = (avgGain * (period - 1) + g) / period;
    avgLoss    = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    val = (val * (period - 1) + trs[i]) / period;
  }
  return val;
}

// ─── SMA & STDEV ─────────────────────────────────────────────────────────────

export function sma(values, period) {
  if (values.length < period) return null;
  const p = values.slice(-period);
  return p.reduce((a, b) => a + b, 0) / period;
}

export function stdev(values, period) {
  if (values.length < period) return null;
  const p = values.slice(-period);
  const avg = p.reduce((a, b) => a + b, 0) / period;
  const variance = p.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / period;
  return Math.sqrt(variance);
}

// ─── ADX (Average Directional Index) ─────────────────────────────────────────

export function adx(highs, lows, closes, period = 14) {
  if (highs.length < period * 2 + 1) return null;

  // Calculate +DM, -DM, and True Range
  const plusDM = [];
  const minusDM = [];
  const tr = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  // Wilder's smoothing for first period
  let smoothPlusDM = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period; i < plusDM.length; i++) {
    if (i > period) {
      smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDM[i];
      smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDM[i];
      smoothTR = smoothTR - (smoothTR / period) + tr[i];
    }

    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dx.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);
  }

  if (dx.length < period) return null;

  // Smooth DX to get ADX using Wilder's method
  let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
  }

  return adxVal;
}

// ─── BOLLINGER BANDS ─────────────────────────────────────────────────────────

export function bbands(closes, period = 20, multiplier = 2) {
  if (closes.length < period) return { upper: null, mid: null, lower: null };
  const mid = sma(closes, period);
  const sd = stdev(closes, period);
  if (mid === null || sd === null) return { upper: null, mid: null, lower: null };
  return {
    upper: mid + sd * multiplier,
    mid: mid,
    lower: mid - sd * multiplier,
  };
}
