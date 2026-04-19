/**
 * Technical Indicators — pure JS, no external dependencies
 * Compatible with candle data from IC Markets
 */

import { config } from "./config.js";

export function calculateIndicators(candles) {
  const closes = candles.map((c) => parseFloat(c.mid.c));
  const highs  = candles.map((c) => parseFloat(c.mid.h));
  const lows   = candles.map((c) => parseFloat(c.mid.l));
  const opens  = candles.map((c) => parseFloat(c.mid.o));
  const volumes = candles.map((c) => Number(c.volume));
  
  const { emaFast, emaSlow } = config.strategy || { emaFast: 8, emaSlow: 21 };
  
  // Use HLC3 (Typical Price) for VWAP if per-bar VWAP is not available
  const barVwaps = candles.map((c) => (parseFloat(c.mid.h) + parseFloat(c.mid.l) + parseFloat(c.mid.c)) / 3);

  const emaF = ema(closes, emaFast);
  const emaS = ema(closes, emaSlow);
  
  // EMA 200 — Phase 2 Trend Filter
  const ema200Value = ema(closes, config.strategy?.ema200Period || 200);
  
  // Calculate EMA Slope (Change over last 1 candle for fast reaction, but check 3 for trend)
  const prevEmaF = ema(closes.slice(0, -1), emaFast);
  const emaSlope = prevEmaF !== null ? (emaF - prevEmaF) : 0;

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
  const minBody = body || 0.000001; 
  const isBullishRejection = lowerWick > minBody * 1.5 && lowerWick > upperWick * 1.5;
  const isBearishRejection = upperWick > minBody * 1.5 && upperWick > lowerWick * 1.5;

  // ─── Phase 3: Price Action Patterns ──────────────────────────────────────
  // Bullish Engulfing: previous candle bearish, current candle bullish and fully engulfs previous
  const prevCandle = candles.length >= 2 ? candles[candles.length - 2] : null;
  let isBullishEngulfing = false;
  let isBearishEngulfing = false;
  let isPinBar = isBullishRejection || isBearishRejection;

  if (prevCandle) {
    const po = parseFloat(prevCandle.mid.o);
    const pc = parseFloat(prevCandle.mid.c);
    const prevBearish = pc < po;
    const prevBullish = pc > po;
    const currBullish = c > o;
    const currBearish = c < o;

    isBullishEngulfing = prevBearish && currBullish && o <= pc && c >= po;
    isBearishEngulfing = prevBullish && currBearish && o >= pc && c <= po;
  }

  const hasPriceAction = isBullishEngulfing || isBearishEngulfing || isPinBar;
  const hasBullishPriceAction = isBullishEngulfing || isBullishRejection;
  const hasBearishPriceAction = isBearishEngulfing || isBearishRejection;

  // ─── Support/Resistance Zone Detection ──────────────────────────────────
  const srLookback = config.strategy?.srLookbackPeriods || 50;
  const srZone = detectSRZone(highs, lows, closes, srLookback);

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

  // Bollinger Bands — current and previous (for expansion detection)
  const currentBB = bbands(closes, 20, 2);
  const prevBB    = bbands(closes.slice(0, -1), 20, 2);

  // BB Width = (upper - lower) — absolute width of bands
  const bbWidth     = currentBB.mid ? (currentBB.upper - currentBB.lower) : 0;
  const prevBbWidth = prevBB.mid    ? (prevBB.upper - prevBB.lower) : 0;
  // Bands are expanding when current width > previous width (squeeze release)
  const bbWidthExpanding = bbWidth > prevBbWidth;

  // BB Squeeze detection — bands were compressed relative to ATR before this candle
  const atrVal = atr(highs, lows, closes, 14);
  const bbSqueezeRatio = (atrVal > 0 && prevBbWidth > 0) ? prevBbWidth / atrVal : 99;
  const bbSqueezeBreakout = bbSqueezeRatio < 4.0 && bbWidthExpanding;

  // Candle body ratio = body / ATR — measures conviction of the candle
  const candleBodyATR = atrVal > 0 ? body / atrVal : 0;

  // ─── ATR Average (Volatility Filter — Phase 2) ──────────────────────────
  // Compute rolling ATR values over the last N periods and average them
  const atrAvgPeriod = config.strategy?.atrAveragePeriod || 20;
  const atrAverage = computeAtrAverage(highs, lows, closes, 14, atrAvgPeriod);
  const isVolatilityOk = atrVal !== null && atrAverage !== null && atrVal >= atrAverage;

  return {
    currentPrice: closes[closes.length - 1],
    // Dynamic EMA System based on config
    [`ema${emaFast}`]:  emaF,
    [`ema${emaSlow}`]:  emaS,
    emaSlope,
    // EMA 200 — Phase 2 Trend Filter
    ema200: ema200Value,
    // Rejection indicators
    lowerWick,
    upperWick,
    body,
    isBullishRejection,
    isBearishRejection,
    // Price Action Patterns (Phase 3)
    isBullishEngulfing,
    isBearishEngulfing,
    isPinBar,
    hasPriceAction,
    hasBullishPriceAction,
    hasBearishPriceAction,
    // Support/Resistance zones
    srZone,
    nearSupport: srZone.nearSupport,
    nearResistance: srZone.nearResistance,
    // Short RSI for fast momentum
    rsi:          rsi(closes, 7),
    // Volatility-based stop/profit
    atr:          atrVal,
    // ATR Average & Volatility Filter (Phase 2)
    atrAverage,
    isVolatilityOk,
    // Rolling VWAP (20 periods)
    vwap:         vwap(barVwaps, volumes, 20),
    // Bollinger Bands (20 periods, 2 stdDev)
    bbands:       currentBB,
    // BB Width expansion — true when bands are widening (squeeze breakout)
    bbWidth,
    bbWidthExpanding,
    // BB Squeeze metrics
    bbSqueezeRatio,
    bbSqueezeBreakout,
    // Candle body as fraction of ATR
    candleBodyATR,
    // MACD (12, 26, 9) — with previous hist for crossover detection
    macd:         macdResult,
    prevMacdHist,
    // Trend strength — ADX(14)
    adx:          adxValue,
    // Volume ratio (current / 20-period avg)
    volumeRatio,
    // Momentum: (Last Close - Previous Close)
    momentum:     closes[closes.length - 1] - closes[closes.length - 2]
  };
}

// ─── Support/Resistance Zone Detection ──────────────────────────────────────

function detectSRZone(highs, lows, closes, lookback = 50) {
  const recentHighs = highs.slice(-lookback);
  const recentLows  = lows.slice(-lookback);
  const currentPrice = closes[closes.length - 1];
  const atrVal = atr(highs, lows, closes, 14) || 0.001;

  // Find swing highs and swing lows (local extremes)
  const resistanceLevels = [];
  const supportLevels = [];

  for (let i = 2; i < recentHighs.length - 2; i++) {
    // Swing high: higher than 2 bars on each side
    if (recentHighs[i] > recentHighs[i-1] && recentHighs[i] > recentHighs[i-2] &&
        recentHighs[i] > recentHighs[i+1] && recentHighs[i] > recentHighs[i+2]) {
      resistanceLevels.push(recentHighs[i]);
    }
    // Swing low: lower than 2 bars on each side
    if (recentLows[i] < recentLows[i-1] && recentLows[i] < recentLows[i-2] &&
        recentLows[i] < recentLows[i+1] && recentLows[i] < recentLows[i+2]) {
      supportLevels.push(recentLows[i]);
    }
  }

  // Check if current price is near (within 1.5× ATR) any S/R level
  const proximityThreshold = 1.5 * atrVal;
  const nearSupport    = supportLevels.some(s => Math.abs(currentPrice - s) < proximityThreshold && currentPrice >= s);
  const nearResistance = resistanceLevels.some(r => Math.abs(currentPrice - r) < proximityThreshold && currentPrice <= r);

  return {
    supportLevels,
    resistanceLevels,
    nearSupport,
    nearResistance,
    closestSupport:    supportLevels.length > 0 ? supportLevels.reduce((a, b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a) : null,
    closestResistance: resistanceLevels.length > 0 ? resistanceLevels.reduce((a, b) => Math.abs(b - currentPrice) < Math.abs(a - currentPrice) ? b : a) : null,
  };
}

// ─── ATR Average (for volatility filter) ──────────────────────────────────────

function computeAtrAverage(highs, lows, closes, atrPeriod, avgPeriod) {
  // We need enough data to compute ATR for each of the last avgPeriod bars
  if (highs.length < atrPeriod + avgPeriod + 1) return null;

  const atrValues = [];
  for (let i = 0; i < avgPeriod; i++) {
    const endIdx = highs.length - i;
    const startIdx = Math.max(0, endIdx - (atrPeriod + 20)); // enough data for ATR
    if (endIdx - startIdx < atrPeriod + 1) continue;
    const val = atr(highs.slice(startIdx, endIdx), lows.slice(startIdx, endIdx), closes.slice(startIdx, endIdx), atrPeriod);
    if (val !== null) atrValues.push(val);
  }

  if (atrValues.length === 0) return null;
  return atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
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
