#!/usr/bin/env node

import fs from "fs";

const PAIR = getArg("--pair", "EUR_USD");
const FILE = getArg("--file", `history_${PAIR}.json`);
const PIP = PAIR.includes("JPY") ? 0.01 : 0.0001;
const COST_PIPS = numberArg("--cost-pips", 0.7); // spread + slippage approximation
const MIN_OBS = numberArg("--min-obs", 40);
const FAKE_BREAK_MIN_BREAK_PIPS = numberArg("--fake-break-min-break-pips", 2.0);
const FAKE_BREAK_CONFIRM_BARS = numberArg("--fake-break-confirm-bars", 2);
const FAKE_BREAK_LOOKAHEAD_BARS = numberArg("--fake-break-lookahead-bars", 12);
const FAKE_BREAK_STOP_BUFFER_PIPS = numberArg("--fake-break-stop-buffer-pips", 0.5);
const LONDON_FAKE_BREAK_SWEEP = process.argv.includes("--london-fake-break-sweep");
const SWEEP_MIN_BREAK_PIPS = numberListArg("--sweep-min-break-pips", [2, 3, 4, 5]);
const SWEEP_CONFIRM_BARS = numberListArg("--sweep-confirm-bars", [0, 1, 2, 3]);
const SWEEP_RISK_BANDS = riskBandListArg("--sweep-risk-bands", [
  { label: "all", min: 0, max: Infinity },
  { label: "4-8", min: 4, max: 8 },
  { label: "5-10", min: 5, max: 10 },
  { label: "6-12", min: 6, max: 12 },
  { label: "8-15", min: 8, max: 15 },
]);
const SWEEP_WEEKDAY_FILTERS = listArg("--sweep-weekdays", ["all", "TueWedThu", "Mon", "Tue", "Wed", "Thu", "Fri"]);
const SWEEP_H1_FILTERS = listArg("--sweep-h1", ["all", "break_with_h1", "reversal_with_h1", "break_counter_h1", "reversal_counter_h1"]);
const SWEEP_DIRECTIONS = listArg("--sweep-directions", ["all", "up", "down"]);
const SWEEP_TARGETS = listArg("--sweep-targets", ["time_exit", "asian_midpoint", "rr_1_0", "rr_1_2", "asian_opposite"]);
const SWEEP_TOP = numberArg("--sweep-top", 20);
const SWEEP_JSON_PATH = getArg("--sweep-json", null);

const SESSION_WINDOWS = [
  { name: "asian", start: 0, end: 7 },
  { name: "london_open", start: 7, end: 10 },
  { name: "pre_ny", start: 10, end: 12.5 },
  { name: "ny_open_overlap", start: 12.5, end: 16 },
  { name: "late_ny", start: 16, end: 18 },
];

function getArg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function numberArg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function listArg(name, fallback) {
  const raw = getArg(name, null);
  if (!raw) return fallback;
  return raw.split(",").map(v => v.trim()).filter(Boolean);
}

function numberListArg(name, fallback) {
  const raw = getArg(name, null);
  if (!raw) return fallback;
  const values = raw.split(",").map(v => Number(v.trim())).filter(Number.isFinite);
  return values.length ? values : fallback;
}

function riskBandListArg(name, fallback) {
  const raw = getArg(name, null);
  if (!raw) return fallback;
  const bands = raw.split(",").map(part => {
    const label = part.trim();
    if (!label) return null;
    if (label === "all") return { label: "all", min: 0, max: Infinity };
    const [minRaw, maxRaw] = label.split("-");
    const min = Number(minRaw);
    const max = maxRaw === "inf" ? Infinity : Number(maxRaw);
    return Number.isFinite(min) && (Number.isFinite(max) || max === Infinity) && max >= min ? { label, min, max } : null;
  }).filter(Boolean);
  return bands.length ? bands : fallback;
}

function candle(c) {
  const m = c.mid ?? c.bid ?? c.ask;
  return {
    time: c.time,
    date: new Date(c.time),
    open: Number(m.o),
    high: Number(m.h),
    low: Number(m.l),
    close: Number(m.c),
    volume: Number(c.volume ?? 0),
  };
}

function hourOf(d) {
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function dayKey(d) {
  return d.toISOString().slice(0, 10);
}

function weekday(d) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function pct(xs, p) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

function fmt(n, d = 2) {
  return Number(n).toFixed(d);
}

function fmtPF(value) {
  return value === Infinity ? "∞" : fmt(value, 2);
}

function pips(priceDelta) {
  return priceDelta / PIP;
}

function ema(values, period) {
  const out = Array(values.length).fill(null);
  if (values.length < period) return out;
  out[period - 1] = mean(values.slice(0, period));
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function groupCandles(candles, keyFn) {
  const groups = new Map();
  for (const c of candles) {
    const k = keyFn(c);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  return groups;
}

function buildHourly(candles) {
  const groups = groupCandles(candles, c => {
    const d = new Date(c.time);
    d.setUTCMinutes(0, 0, 0);
    return d.toISOString();
  });
  return Array.from(groups.entries()).map(([time, cs]) => ({
    time,
    endTime: new Date(new Date(time).getTime() + 60 * 60_000).toISOString(),
    date: new Date(time),
    open: cs[0].open,
    high: Math.max(...cs.map(c => c.high)),
    low: Math.min(...cs.map(c => c.low)),
    close: cs.at(-1).close,
    volume: cs.reduce((a, c) => a + c.volume, 0),
    h1Trend: cs[0].h1Trend ?? "neutral",
  })).sort((a, b) => a.date - b.date);
}

function attachH1Trend(candles) {
  const hourly = buildHourly(candles);
  const closes = hourly.map(h => h.close);
  const ema200 = ema(closes, 200);
  const byEndTime = [];
  for (let i = 1; i < hourly.length; i++) {
    const trend = ema200[i] && ema200[i - 1]
      ? hourly[i].close > ema200[i] && ema200[i] > ema200[i - 1]
        ? "bull"
        : hourly[i].close < ema200[i] && ema200[i] < ema200[i - 1]
          ? "bear"
          : "neutral"
      : "neutral";
    byEndTime.push({ end: new Date(hourly[i].endTime).getTime(), trend });
  }

  let j = 0;
  for (const c of candles) {
    const t = c.date.getTime();
    while (j + 1 < byEndTime.length && byEndTime[j + 1].end <= t) j++;
    c.h1Trend = byEndTime[j]?.end <= t ? byEndTime[j].trend : "neutral";
  }
}

function sessionMovement(candles) {
  const rows = [];
  for (const session of SESSION_WINDOWS) {
    const ranges = [];
    const bodies = [];
    const days = groupCandles(candles.filter(c => {
      const h = hourOf(c.date);
      return h >= session.start && h < session.end;
    }), c => dayKey(c.date));
    for (const cs of days.values()) {
      if (cs.length < 3) continue;
      ranges.push(pips(Math.max(...cs.map(c => c.high)) - Math.min(...cs.map(c => c.low))));
      bodies.push(Math.abs(pips(cs.at(-1).close - cs[0].open)));
    }
    rows.push({
      session: session.name,
      days: ranges.length,
      avgRange: mean(ranges),
      medRange: median(ranges),
      p75Range: pct(ranges, 0.75),
      avgBody: mean(bodies),
      pctRange8: ranges.filter(v => v >= 8).length / Math.max(1, ranges.length) * 100,
      pctRange12: ranges.filter(v => v >= 12).length / Math.max(1, ranges.length) * 100,
    });
  }
  return rows;
}

function hourlyContinuation(candles) {
  const hourly = buildHourly(candles);
  const rows = [];
  for (let i = 1; i < hourly.length; i++) {
    const prevMove = pips(hourly[i - 1].close - hourly[i - 1].open);
    if (Math.abs(prevMove) < 2) continue;
    const dir = prevMove > 0 ? 1 : -1;
    const gross = dir * pips(hourly[i].close - hourly[i].open);
    const net = gross - COST_PIPS;
    const h = hourly[i].date.getUTCHours();
    const key = `${String(h).padStart(2, "0")}:00`;
    const trend = hourly[i].h1Trend ?? "neutral";
    rows.push({ key, weekday: weekday(hourly[i].date), h, trend, align: trend === "neutral" ? "neutral" : (dir > 0 && trend === "bull") || (dir < 0 && trend === "bear") ? "aligned" : "counter", net });
  }
  return summarizeBy(rows, r => r.key, r => r.net).sort((a, b) => Number(a.key.slice(0, 2)) - Number(b.key.slice(0, 2)));
}

function h1TrendImpact(candles) {
  const hourly = buildHourly(candles);
  const rows = [];
  for (let i = 1; i < hourly.length; i++) {
    const prevMove = pips(hourly[i - 1].close - hourly[i - 1].open);
    if (Math.abs(prevMove) < 2) continue;
    const dir = prevMove > 0 ? 1 : -1;
    const gross = dir * pips(hourly[i].close - hourly[i].open);
    const trend = hourly[i].h1Trend ?? "neutral";
    const bucket = trend === "neutral" ? "neutral" : (dir > 0 && trend === "bull") || (dir < 0 && trend === "bear") ? "with_h1" : "against_h1";
    rows.push({ bucket, net: gross - COST_PIPS });
  }
  return summarizeBy(rows, r => r.bucket, r => r.net);
}

function asianBreaks(candles) {
  const byDay = groupCandles(candles, c => dayKey(c.date));
  const events = [];
  for (const cs of byDay.values()) {
    const asian = cs.filter(c => hourOf(c.date) >= 0 && hourOf(c.date) < 7);
    if (asian.length < 12) continue;
    const high = Math.max(...asian.map(c => c.high));
    const low = Math.min(...asian.map(c => c.low));
    for (const window of [
      { name: "london", start: 7, end: 10 },
      { name: "ny", start: 12.5, end: 16 },
    ]) {
      const ix = cs.findIndex(c => {
        const h = hourOf(c.date);
        return h >= window.start && h < window.end && (c.high > high || c.low < low);
      });
      if (ix < 0) continue;
      const c = cs[ix];
      const up = c.high > high;
      const down = c.low < low;
      if (up === down) continue;
      const dir = up ? 1 : -1;
      const look = cs.slice(ix + 1, ix + 13);
      if (look.length < 6) continue;
      const entry = up ? high : low;
      const mfe = up ? Math.max(...look.map(x => x.high)) - entry : entry - Math.min(...look.map(x => x.low));
      const mae = up ? entry - Math.min(...look.map(x => x.low)) : Math.max(...look.map(x => x.high)) - entry;
      const close60 = look.at(-1).close;
      events.push({
        window: window.name,
        direction: up ? "up" : "down",
        weekday: weekday(c.date),
        hour: c.date.getUTCHours(),
        h1Trend: c.h1Trend,
        h1Alignment: c.h1Trend === "neutral" ? "neutral" : (up && c.h1Trend === "bull") || (!up && c.h1Trend === "bear") ? "aligned" : "counter",
        net60: dir * pips(close60 - entry) - COST_PIPS,
        mfe: pips(mfe),
        mae: pips(mae),
        closeBackInside: up ? close60 < high : close60 > low,
      });
    }
  }
  return {
    byWindow: summarizeBy(events, r => r.window, r => r.net60),
    byDirection: summarizeBy(events, r => `${r.window}_${r.direction}`, r => r.net60),
    byH1: summarizeBy(events, r => r.h1Trend, r => r.net60),
    byH1Alignment: summarizeBy(events, r => r.h1Alignment, r => r.net60),
    reversalRate: groupRate(events, r => r.window, r => r.closeBackInside),
  };
}

function londonFakeBreakReversals(candles, opts = {}) {
  const byDay = groupCandles(candles, c => dayKey(c.date));
  const events = [];
  const minBreakPips = opts.minBreakPips ?? FAKE_BREAK_MIN_BREAK_PIPS;
  const confirmBars = opts.confirmBars ?? FAKE_BREAK_CONFIRM_BARS;
  const lookaheadBars = opts.lookaheadBars ?? FAKE_BREAK_LOOKAHEAD_BARS;
  const stopBufferPips = opts.stopBufferPips ?? FAKE_BREAK_STOP_BUFFER_PIPS;
  const minBreak = minBreakPips * PIP;
  const stopBuffer = stopBufferPips * PIP;

  for (const cs of byDay.values()) {
    const asian = cs.filter(c => hourOf(c.date) >= 0 && hourOf(c.date) < 7);
    if (asian.length < 12) continue;

    const asianHigh = Math.max(...asian.map(c => c.high));
    const asianLow = Math.min(...asian.map(c => c.low));
    const asianMid = (asianHigh + asianLow) / 2;
    const londonIndexes = cs
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => hourOf(c.date) >= 7 && hourOf(c.date) < 10);

    let found = null;
    for (const item of londonIndexes) {
      const brokeHigh = item.c.high >= asianHigh + minBreak;
      const brokeLow = item.c.low <= asianLow - minBreak;
      if (brokeHigh === brokeLow) continue;
      found = { ...item, breakDirection: brokeHigh ? "up" : "down" };
      break;
    }
    if (!found) continue;

    const breakCandle = found.c;
    const breakIx = found.i;
    const brokeUp = found.breakDirection === "up";
    const rangeLevel = brokeUp ? asianHigh : asianLow;
    const breakPips = brokeUp ? pips(breakCandle.high - asianHigh) : pips(asianLow - breakCandle.low);
    const sameCandleCloseBackInside = brokeUp ? breakCandle.close < asianHigh : breakCandle.close > asianLow;

    let confirmation = null;
    for (let j = breakIx; j <= Math.min(cs.length - 1, breakIx + confirmBars); j++) {
      const c = cs[j];
      if (dayKey(c.date) !== dayKey(breakCandle.date) || hourOf(c.date) >= 10) break;
      const closedBackInside = brokeUp ? c.close < asianHigh : c.close > asianLow;
      if (closedBackInside) {
        confirmation = { candle: c, index: j, barsAfterBreak: j - breakIx };
        break;
      }
    }

    const event = {
      day: dayKey(breakCandle.date),
      weekday: weekday(breakCandle.date),
      breakHour: breakCandle.date.getUTCHours() + breakCandle.date.getUTCMinutes() / 60,
      breakDirection: found.breakDirection,
      reversalDirection: brokeUp ? "SELL" : "BUY",
      h1Trend: breakCandle.h1Trend,
      breakAlignedWithH1: (brokeUp && breakCandle.h1Trend === "bull") || (!brokeUp && breakCandle.h1Trend === "bear"),
      reversalAlignedWithH1: (brokeUp && breakCandle.h1Trend === "bear") || (!brokeUp && breakCandle.h1Trend === "bull"),
      asianHigh,
      asianLow,
      asianMid,
      rangeLevel,
      breakPips,
      sameCandleCloseBackInside,
      confirmedWithinBars: Boolean(confirmation),
      confirmationBarsUsed: confirmation?.barsAfterBreak ?? null,
    };

    if (confirmation) {
      const extremeWindow = cs.slice(breakIx, confirmation.index + 1);
      const entry = confirmation.candle.close;
      const stop = brokeUp
        ? Math.max(...extremeWindow.map(c => c.high)) + stopBuffer
        : Math.min(...extremeWindow.map(c => c.low)) - stopBuffer;
      const riskPips = brokeUp ? pips(stop - entry) : pips(entry - stop);
      const lookahead = cs.slice(confirmation.index + 1, confirmation.index + 1 + lookaheadBars);
      const last = lookahead.at(-1);

      event.entry = entry;
      event.stop = stop;
      event.riskPips = riskPips;
      event.hasLookahead = lookahead.length > 0;

      if (lookahead.length > 0 && riskPips > 0) {
        const minLow = Math.min(...lookahead.map(c => c.low));
        const maxHigh = Math.max(...lookahead.map(c => c.high));
        event.mfePips = brokeUp ? pips(entry - minLow) : pips(maxHigh - entry);
        event.maePips = brokeUp ? pips(maxHigh - entry) : pips(entry - minLow);
        event.netLookaheadPips = (brokeUp ? pips(entry - last.close) : pips(last.close - entry)) - COST_PIPS;
        const targetResults = buildFakeBreakTargetResults({ brokeUp, entry, stop, asianHigh, asianLow, asianMid, riskPips, lookahead, fallbackClose: last.close });
        event.targetResults = targetResults;
        event.midpointOutcome = targetResults.asian_midpoint.outcome;
        event.midpointNetPips = targetResults.asian_midpoint.netPips;
        event.midpointTargetPips = targetResults.asian_midpoint.targetPips;
      }
    }

    events.push(event);
  }

  const confirmed = events.filter(e => e.confirmedWithinBars && e.hasLookahead && Number.isFinite(e.riskPips) && e.riskPips > 0);
  return {
    events,
    confirmed,
    candidateSummary: [
      summarizeFakeBreakCandidates(events, "all"),
      ...["up", "down"].map(d => summarizeFakeBreakCandidates(events.filter(e => e.breakDirection === d), `break_${d}`)),
    ],
    confirmedSummary: [
      summarizeConfirmedFakeBreaks(confirmed, "all_confirmed"),
      ...["up", "down"].map(d => summarizeConfirmedFakeBreaks(confirmed.filter(e => e.breakDirection === d), `break_${d}`)),
      ...["bull", "bear", "neutral"].map(t => summarizeConfirmedFakeBreaks(confirmed.filter(e => e.h1Trend === t), `h1_${t}`)),
      summarizeConfirmedFakeBreaks(confirmed.filter(e => e.breakAlignedWithH1), "break_with_h1"),
      summarizeConfirmedFakeBreaks(confirmed.filter(e => e.reversalAlignedWithH1), "reversal_with_h1"),
    ],
    weekdaySummary: ["Mon", "Tue", "Wed", "Thu", "Fri"].map(day => summarizeConfirmedFakeBreaks(confirmed.filter(e => e.weekday === day), day)),
  };
}

function buildFakeBreakTargetResults({ brokeUp, entry, stop, asianHigh, asianLow, asianMid, riskPips, lookahead, fallbackClose }) {
  const oppositeTarget = brokeUp ? asianLow : asianHigh;
  const rrTarget = (rr) => brokeUp ? entry - (riskPips * rr * PIP) : entry + (riskPips * rr * PIP);
  return {
    time_exit: simulateFakeBreakTimeExit({ brokeUp, entry, fallbackClose }),
    asian_midpoint: simulateFakeBreakTargetOutcome({ brokeUp, entry, stop, target: asianMid, lookahead, fallbackClose }),
    asian_opposite: simulateFakeBreakTargetOutcome({ brokeUp, entry, stop, target: oppositeTarget, lookahead, fallbackClose }),
    rr_1_0: simulateFakeBreakTargetOutcome({ brokeUp, entry, stop, target: rrTarget(1.0), lookahead, fallbackClose }),
    rr_1_2: simulateFakeBreakTargetOutcome({ brokeUp, entry, stop, target: rrTarget(1.2), lookahead, fallbackClose }),
  };
}

function simulateFakeBreakTimeExit({ brokeUp, entry, fallbackClose }) {
  return {
    outcome: "TIME",
    netPips: (brokeUp ? pips(entry - fallbackClose) : pips(fallbackClose - entry)) - COST_PIPS,
    targetPips: null,
  };
}

function simulateFakeBreakTargetOutcome({ brokeUp, entry, stop, target, lookahead, fallbackClose }) {
  const targetPips = Math.abs(pips(entry - target));
  const riskPips = Math.abs(pips(entry - stop));
  for (const c of lookahead) {
    const hitStop = brokeUp ? c.high >= stop : c.low <= stop;
    const hitTarget = brokeUp ? c.low <= target : c.high >= target;
    if (hitStop) return { outcome: "SL", netPips: -riskPips - COST_PIPS, targetPips };
    if (hitTarget) return { outcome: "TP", netPips: targetPips - COST_PIPS, targetPips };
  }
  return {
    outcome: "TIME",
    netPips: (brokeUp ? pips(entry - fallbackClose) : pips(fallbackClose - entry)) - COST_PIPS,
    targetPips,
  };
}

function summarizeFakeBreakCandidates(events, key) {
  return {
    key,
    n: events.length,
    avgBreakPips: mean(events.map(e => e.breakPips)),
    sameCloseBackInside: events.filter(e => e.sameCandleCloseBackInside).length / Math.max(1, events.length) * 100,
    confirmedWithinBars: events.filter(e => e.confirmedWithinBars).length / Math.max(1, events.length) * 100,
  };
}

function summarizeConfirmedFakeBreaks(events, key) {
  return {
    key,
    n: events.length,
    avgRiskPips: mean(events.map(e => e.riskPips)),
    avgNetPips: mean(events.map(e => e.netLookaheadPips)),
    winRate: events.filter(e => e.netLookaheadPips > 0).length / Math.max(1, events.length) * 100,
    avgMfePips: mean(events.map(e => e.mfePips)),
    avgMaePips: mean(events.map(e => e.maePips)),
    midpointTpRate: events.filter(e => e.midpointOutcome === "TP").length / Math.max(1, events.length) * 100,
    midpointSlRate: events.filter(e => e.midpointOutcome === "SL").length / Math.max(1, events.length) * 100,
    avgMidpointNetPips: mean(events.map(e => e.midpointNetPips)),
  };
}

function londonFakeBreakSweep(candles) {
  const rows = [];
  for (const minBreakPips of SWEEP_MIN_BREAK_PIPS) {
    for (const confirmBars of SWEEP_CONFIRM_BARS) {
      const analysis = londonFakeBreakReversals(candles, { minBreakPips, confirmBars });
      for (const riskBand of SWEEP_RISK_BANDS) {
        for (const weekdayFilter of SWEEP_WEEKDAY_FILTERS) {
          for (const h1Filter of SWEEP_H1_FILTERS) {
            for (const direction of SWEEP_DIRECTIONS) {
              const filtered = analysis.confirmed.filter(event => {
                if (!eventPassesRiskBand(event, riskBand)) return false;
                if (!eventPassesWeekdayFilter(event, weekdayFilter)) return false;
                if (!eventPassesH1Filter(event, h1Filter)) return false;
                if (!eventPassesDirection(event, direction)) return false;
                return true;
              });

              for (const target of SWEEP_TARGETS) {
                const summary = summarizeFakeBreakSweepRows(filtered, target);
                if (summary.n < MIN_OBS) continue;
                rows.push({
                  minBreakPips,
                  confirmBars,
                  riskBand: riskBand.label,
                  weekdayFilter,
                  h1Filter,
                  direction,
                  target,
                  ...summary,
                });
              }
            }
          }
        }
      }
    }
  }

  return rows.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    const avgDiff = b.avgNetPips - a.avgNetPips;
    if (Math.abs(avgDiff) > 1e-9) return avgDiff;
    return b.n - a.n;
  });
}

function summarizeFakeBreakSweepRows(events, target) {
  const targetRows = events
    .map(event => ({ event, result: event.targetResults?.[target] }))
    .filter(row => row.result && Number.isFinite(row.result.netPips));
  const values = targetRows.map(row => row.result.netPips);
  const wins = values.filter(v => v > 0);
  const losses = values.filter(v => v <= 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const n = values.length;
  const avgNetPips = mean(values);

  return {
    n,
    avgNetPips,
    medianNetPips: median(values),
    winRate: wins.length / Math.max(1, n) * 100,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    avgRiskPips: mean(targetRows.map(row => row.event.riskPips)),
    avgMfePips: mean(targetRows.map(row => row.event.mfePips)),
    avgMaePips: mean(targetRows.map(row => row.event.maePips)),
    tpRate: targetRows.filter(row => row.result.outcome === "TP").length / Math.max(1, n) * 100,
    slRate: targetRows.filter(row => row.result.outcome === "SL").length / Math.max(1, n) * 100,
    timeRate: targetRows.filter(row => row.result.outcome === "TIME").length / Math.max(1, n) * 100,
    p25: pct(values, 0.25),
    p75: pct(values, 0.75),
    score: avgNetPips * Math.sqrt(n),
  };
}

function eventPassesRiskBand(event, riskBand) {
  const risk = Number(event.riskPips);
  return Number.isFinite(risk) && risk >= riskBand.min && risk <= riskBand.max;
}

function eventPassesWeekdayFilter(event, filter) {
  if (filter === "all") return true;
  if (filter === "TueWedThu") return ["Tue", "Wed", "Thu"].includes(event.weekday);
  return event.weekday === filter;
}

function eventPassesH1Filter(event, filter) {
  if (filter === "all") return true;
  if (filter === "break_with_h1") return event.breakAlignedWithH1;
  if (filter === "reversal_with_h1") return event.reversalAlignedWithH1;
  if (filter === "break_counter_h1") return !event.breakAlignedWithH1 && event.h1Trend !== "neutral";
  if (filter === "reversal_counter_h1") return !event.reversalAlignedWithH1 && event.h1Trend !== "neutral";
  if (["bull", "bear", "neutral"].includes(filter)) return event.h1Trend === filter;
  return false;
}

function eventPassesDirection(event, direction) {
  return direction === "all" || event.breakDirection === direction;
}

function thirteenBreakouts(candles) {
  const byDay = groupCandles(candles, c => dayKey(c.date));
  const events = [];
  for (const cs of byDay.values()) {
    const range = cs.filter(c => hourOf(c.date) >= 12.5 && hourOf(c.date) < 13);
    if (range.length < 4) continue;
    const high = Math.max(...range.map(c => c.high));
    const low = Math.min(...range.map(c => c.low));
    const ix = cs.findIndex(c => hourOf(c.date) >= 13 && hourOf(c.date) < 16 && (c.high > high || c.low < low));
    if (ix < 0) continue;
    const c = cs[ix];
    const up = c.high > high;
    const down = c.low < low;
    if (up === down) continue;
    const dir = up ? 1 : -1;
    const entry = up ? high : low;
    const look60 = cs.slice(ix + 1, ix + 13);
    const look180 = cs.slice(ix + 1, ix + 37);
    if (look60.length < 6) continue;
    const max60 = Math.max(...look60.map(x => x.high));
    const min60 = Math.min(...look60.map(x => x.low));
    const max180 = look180.length ? Math.max(...look180.map(x => x.high)) : max60;
    const min180 = look180.length ? Math.min(...look180.map(x => x.low)) : min60;
    const mfe60 = up ? max60 - entry : entry - min60;
    const mae60 = up ? entry - min60 : max60 - entry;
    const mfe180 = up ? max180 - entry : entry - min180;
    const mae180 = up ? entry - min180 : max180 - entry;
    events.push({
      direction: up ? "up" : "down",
      weekday: weekday(c.date),
      hour: c.date.getUTCHours(),
      h1Trend: c.h1Trend,
      aligned: (up && c.h1Trend === "bull") || (!up && c.h1Trend === "bear"),
      net60: dir * pips(look60.at(-1).close - entry) - COST_PIPS,
      mfe60: pips(mfe60),
      mae60: pips(mae60),
      mfe180: pips(mfe180),
      mae180: pips(mae180),
    });
  }
  return {
    all: summarizeMfeMae(events, "all"),
    byDirection: ["up", "down"].map(d => summarizeMfeMae(events.filter(e => e.direction === d), d)),
    byH1Alignment: [true, false].map(v => summarizeMfeMae(events.filter(e => e.aligned === v), v ? "h1_aligned" : "not_h1_aligned")),
  };
}

function weekdayHourRegimes(candles) {
  const hourly = buildHourly(candles);
  const rows = [];
  for (let i = 1; i < hourly.length; i++) {
    const prevMove = pips(hourly[i - 1].close - hourly[i - 1].open);
    if (Math.abs(prevMove) < 2) continue;
    const dir = prevMove > 0 ? 1 : -1;
    const net = dir * pips(hourly[i].close - hourly[i].open) - COST_PIPS;
    rows.push({ key: `${weekday(hourly[i].date)} ${String(hourly[i].date.getUTCHours()).padStart(2, "0")}:00`, net });
  }
  return summarizeBy(rows, r => r.key, r => r.net)
    .filter(r => r.n >= MIN_OBS)
    .sort((a, b) => b.avg - a.avg);
}

function summarizeBy(rows, keyFn, valueFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(valueFn(r));
  }
  return Array.from(groups.entries()).map(([key, vals]) => ({
    key,
    n: vals.length,
    avg: mean(vals),
    med: median(vals),
    winRate: vals.filter(v => v > 0).length / Math.max(1, vals.length) * 100,
    p25: pct(vals, 0.25),
    p75: pct(vals, 0.75),
  }));
}

function groupRate(rows, keyFn, pred) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(Boolean(pred(r)));
  }
  return Array.from(groups.entries()).map(([key, vals]) => ({
    key,
    n: vals.length,
    rate: vals.filter(Boolean).length / Math.max(1, vals.length) * 100,
  }));
}

function summarizeMfeMae(events, key) {
  return {
    key,
    n: events.length,
    avgNet60: mean(events.map(e => e.net60)),
    win60: events.filter(e => e.net60 > 0).length / Math.max(1, events.length) * 100,
    avgMfe60: mean(events.map(e => e.mfe60)),
    avgMae60: mean(events.map(e => e.mae60)),
    avgMfe180: mean(events.map(e => e.mfe180)),
    avgMae180: mean(events.map(e => e.mae180)),
  };
}

function printSummaryTable(title, rows, columns) {
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  console.table(rows.map(r => Object.fromEntries(columns.map(([name, fn]) => [name, fn(r)]))));
}

function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const candles = raw.map(candle).filter(c => [c.open, c.high, c.low, c.close].every(Number.isFinite));
  attachH1Trend(candles);

  console.log(`Market regime analysis — ${PAIR}`);
  console.log(`File: ${FILE}`);
  console.log(`Candles: ${candles.length.toLocaleString()} | ${candles[0].time} → ${candles.at(-1).time}`);
  console.log(`Assumed round-trip cost: ${COST_PIPS} pips`);
  console.log(`London fake-break params: minBreak=${FAKE_BREAK_MIN_BREAK_PIPS}p | confirmBars=${FAKE_BREAK_CONFIRM_BARS} | lookaheadBars=${FAKE_BREAK_LOOKAHEAD_BARS} | stopBuffer=${FAKE_BREAK_STOP_BUFFER_PIPS}p`);

  printSummaryTable("Session movement", sessionMovement(candles), [
    ["session", r => r.session], ["days", r => r.days], ["avgRange", r => fmt(r.avgRange, 1)], ["medRange", r => fmt(r.medRange, 1)],
    ["p75Range", r => fmt(r.p75Range, 1)], ["avgBody", r => fmt(r.avgBody, 1)], ["range>=8p", r => `${fmt(r.pctRange8, 0)}%`], ["range>=12p", r => `${fmt(r.pctRange12, 0)}%`],
  ]);

  printSummaryTable("Hourly continuation after previous H1 move ≥2 pips", hourlyContinuation(candles), [
    ["hour", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)], ["p25", r => fmt(r.p25, 1)], ["p75", r => fmt(r.p75, 1)],
  ]);

  printSummaryTable("Does H1 EMA200 trend matter?", h1TrendImpact(candles), [
    ["bucket", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)], ["median", r => fmt(r.med, 2)],
  ]);

  const asian = asianBreaks(candles);
  printSummaryTable("Asian range first breaks — net after 60 minutes", asian.byWindow, [
    ["window", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)], ["p25", r => fmt(r.p25, 1)], ["p75", r => fmt(r.p75, 1)],
  ]);
  printSummaryTable("Asian range breaks by direction", asian.byDirection, [
    ["bucket", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)],
  ]);
  printSummaryTable("Asian range breaks by H1 trend", asian.byH1, [
    ["h1Trend", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)],
  ]);
  printSummaryTable("Asian range breaks by H1 alignment", asian.byH1Alignment, [
    ["alignment", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)],
  ]);
  printSummaryTable("Asian break close-back-inside reversal rate", asian.reversalRate, [
    ["window", r => r.key], ["n", r => r.n], ["closeBackInside", r => `${fmt(r.rate, 1)}%`],
  ]);

  const londonFakeBreak = londonFakeBreakReversals(candles);
  printSummaryTable("London Asian fake-break candidates", londonFakeBreak.candidateSummary, [
    ["bucket", r => r.key], ["n", r => r.n], ["avgBreakPips", r => fmt(r.avgBreakPips, 1)],
    ["sameCloseInside", r => `${fmt(r.sameCloseBackInside, 1)}%`], ["confirmed", r => `${fmt(r.confirmedWithinBars, 1)}%`],
  ]);
  printSummaryTable("London fake-break confirmed reversals", londonFakeBreak.confirmedSummary, [
    ["bucket", r => r.key], ["n", r => r.n], ["avgRisk", r => fmt(r.avgRiskPips, 1)], ["avgNet", r => fmt(r.avgNetPips, 2)],
    ["win%", r => fmt(r.winRate, 1)], ["MFE", r => fmt(r.avgMfePips, 1)], ["MAE", r => fmt(r.avgMaePips, 1)],
    ["midTP%", r => fmt(r.midpointTpRate, 1)], ["midSL%", r => fmt(r.midpointSlRate, 1)], ["midNet", r => fmt(r.avgMidpointNetPips, 2)],
  ]);
  printSummaryTable("London fake-break reversals by weekday", londonFakeBreak.weekdaySummary, [
    ["weekday", r => r.key], ["n", r => r.n], ["avgNet", r => fmt(r.avgNetPips, 2)], ["win%", r => fmt(r.winRate, 1)],
    ["midTP%", r => fmt(r.midpointTpRate, 1)], ["midSL%", r => fmt(r.midpointSlRate, 1)], ["midNet", r => fmt(r.avgMidpointNetPips, 2)],
  ]);

  if (LONDON_FAKE_BREAK_SWEEP) {
    const sweepRows = londonFakeBreakSweep(candles);
    if (SWEEP_JSON_PATH) {
      fs.writeFileSync(SWEEP_JSON_PATH, JSON.stringify({
        pair: PAIR,
        file: FILE,
        generatedAtUTC: new Date().toISOString(),
        params: {
          costPips: COST_PIPS,
          minObs: MIN_OBS,
          minBreakPips: SWEEP_MIN_BREAK_PIPS,
          confirmBars: SWEEP_CONFIRM_BARS,
          riskBands: SWEEP_RISK_BANDS,
          weekdayFilters: SWEEP_WEEKDAY_FILTERS,
          h1Filters: SWEEP_H1_FILTERS,
          directions: SWEEP_DIRECTIONS,
          targets: SWEEP_TARGETS,
          lookaheadBars: FAKE_BREAK_LOOKAHEAD_BARS,
          stopBufferPips: FAKE_BREAK_STOP_BUFFER_PIPS,
        },
        rows: sweepRows,
      }, null, 2));
    }
    printSummaryTable(`London fake-break filter sweep — top ${SWEEP_TOP}`, sweepRows.slice(0, SWEEP_TOP), [
      ["minBreak", r => r.minBreakPips], ["confirm", r => r.confirmBars], ["risk", r => r.riskBand], ["days", r => r.weekdayFilter],
      ["h1", r => r.h1Filter], ["dir", r => r.direction], ["target", r => r.target], ["n", r => r.n],
      ["avgNet", r => fmt(r.avgNetPips, 2)], ["med", r => fmt(r.medianNetPips, 2)], ["win%", r => fmt(r.winRate, 1)],
      ["PF", r => fmtPF(r.profitFactor)], ["riskAvg", r => fmt(r.avgRiskPips, 1)], ["TP%", r => fmt(r.tpRate, 1)],
      ["SL%", r => fmt(r.slRate, 1)], ["score", r => fmt(r.score, 1)],
    ]);
  }

  const br13 = thirteenBreakouts(candles);
  printSummaryTable("13:00 NY opening-range breakouts — MFE/MAE", [br13.all, ...br13.byDirection, ...br13.byH1Alignment], [
    ["bucket", r => r.key], ["n", r => r.n], ["avgNet60", r => fmt(r.avgNet60, 2)], ["win60%", r => fmt(r.win60, 1)],
    ["MFE60", r => fmt(r.avgMfe60, 1)], ["MAE60", r => fmt(r.avgMae60, 1)], ["MFE180", r => fmt(r.avgMfe180, 1)], ["MAE180", r => fmt(r.avgMae180, 1)],
  ]);

  const regimes = weekdayHourRegimes(candles);
  printSummaryTable("Best weekday/hour continuation regimes", regimes.slice(0, 12), [
    ["regime", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)], ["p25", r => fmt(r.p25, 1)], ["p75", r => fmt(r.p75, 1)],
  ]);
  printSummaryTable("Worst weekday/hour continuation regimes", regimes.slice(-12).reverse(), [
    ["regime", r => r.key], ["n", r => r.n], ["avgNetPips", r => fmt(r.avg, 2)], ["win%", r => fmt(r.winRate, 1)], ["p25", r => fmt(r.p25, 1)], ["p75", r => fmt(r.p75, 1)],
  ]);
}

main();




