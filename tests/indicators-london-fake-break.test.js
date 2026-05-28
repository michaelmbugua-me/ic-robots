import assert from "node:assert/strict";
import { generateLondonAsianFakeBreakReversalSignal } from "../indicators.js";

function candle(time, open, high, low, close) {
  return {
    time,
    mid: {
      o: String(open),
      h: String(high),
      l: String(low),
      c: String(close),
    },
  };
}

function iso(day, hhmm) {
  return `${day}T${hhmm}:00.000Z`;
}

function baseCandles(day = "2026-05-20", price = 1.0980) {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    const hour = 5 + Math.floor(i / 12);
    const minute = (i % 12) * 5;
    const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    candles.push(candle(iso(day, hhmm), price, price + 0.0002, price - 0.0002, price));
  }
  return candles;
}

const asianRange = { name: "asian_range", high: 1.1000, low: 1.0950 };

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-20", "07:35"), 1.1000, 1.10020, 1.0995, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "sell");
  assert.equal(signal.direction, "SELL");
  assert.equal(signal.strategy, "london_asian_fake_break_reversal");
  assert.equal(signal.breakDirection, "up");
  assert.equal(signal.confirmationBarsUsed, 1);
  assert.equal(signal.entry, 1.0997);
  assert.equal(signal.sl, 1.1005);
  assert.equal(signal.tp, 1.095);
  assert.equal(signal.riskPips, 8.0);
  assert.equal(signal.rewardPips, 47.0);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0955, 1.0958, 1.09455, 1.09480),
    candle(iso("2026-05-20", "07:35"), 1.0948, 1.0955, 1.0948, 1.09530),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "buy");
  assert.equal(signal.direction, "BUY");
  assert.equal(signal.breakDirection, "down");
  assert.equal(signal.entry, 1.0953);
  assert.equal(signal.sl, 1.0945);
  assert.equal(signal.tp, 1.1);
  assert.equal(signal.riskPips, 8.0);
  assert.equal(signal.rewardPips, 47.0);
}

{
  const candles = [
    ...baseCandles("2026-05-18"), // Monday
    candle(iso("2026-05-18", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-18", "07:35"), 1.1000, 1.10020, 1.0995, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /blocked on Mon/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10030, 1.0992, 1.10010),
    candle(iso("2026-05-20", "07:35"), 1.1000, 1.10010, 1.0995, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /No one-sided London break/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-20", "07:35"), 1.1001, 1.10030, 1.0998, 1.10010),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /Waiting for London break/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-20", "07:35"), 1.1000, 1.10020, 1.09790, 1.09800),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /Risk too large/);
}

{
  const jpyRange = { name: "asian_range", high: 150.00, low: 149.50 };
  const candles = [
    ...baseCandles("2026-05-20", 149.80),
    candle(iso("2026-05-20", "07:30"), 149.95, 150.045, 149.92, 150.020),
    candle(iso("2026-05-20", "07:35"), 150.010, 150.020, 149.950, 149.970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, { asianRange: jpyRange, isJPY: true });
  assert.equal(signal.signal, "sell");
  assert.equal(signal.riskPips, 8.0);
  assert.equal(signal.rewardPips, 47.0);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10025, 1.0992, 1.10010),
    candle(iso("2026-05-20", "07:35"), 1.1001, 1.10030, 1.0997, 1.10005),
    candle(iso("2026-05-20", "07:40"), 1.1000, 1.10020, 1.0994, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, {
    asianRange,
    minBreakPips: 2,
    confirmBars: 3,
    targetMode: "time_exit",
    h1Filter: "reversal_with_h1",
    higherTimeframeTrend: "bear",
  });
  assert.equal(signal.signal, "sell");
  assert.equal(signal.targetMode, "time_exit");
  assert.equal(signal.tp, null);
  assert.equal(signal.rewardPips, null);
  assert.equal(signal.reversalAlignedWithH1, true);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10025, 1.0992, 1.10010),
    candle(iso("2026-05-20", "07:35"), 1.1001, 1.10030, 1.0997, 1.10005),
    candle(iso("2026-05-20", "07:40"), 1.1000, 1.10020, 1.0994, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, {
    asianRange,
    minBreakPips: 2,
    confirmBars: 3,
    targetMode: "time_exit",
    h1Filter: "reversal_with_h1",
    higherTimeframeTrend: "bull",
  });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /H1 filter reversal_with_h1 blocked/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-20", "07:35"), 1.1000, 1.10020, 1.0995, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, {
    asianRange,
    higherTimeframeTrend: "bull",
    noFadeH1AlignedBreak: true,
  });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /no-fade filter blocked/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.10020),
    candle(iso("2026-05-20", "07:35"), 1.1000, 1.10020, 1.0995, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, {
    asianRange,
    minAsianRangePips: 60,
  });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /Asian range too narrow/);
}

{
  const candles = [
    ...baseCandles(),
    candle(iso("2026-05-20", "07:30"), 1.0995, 1.10045, 1.0992, 1.09970),
  ];

  const signal = generateLondonAsianFakeBreakReversalSignal(candles, {
    asianRange,
    minConfirmationBarsAfterBreak: 1,
  });
  assert.equal(signal.signal, "none");
  assert.match(signal.reason, /Waiting for London break/);
}

console.log("London fake-break indicator tests passed");


