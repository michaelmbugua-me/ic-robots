/**
 * Terminal Output Formatter
 */

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  gray:    "\x1b[90m",
  white:   "\x1b[97m",
  bgGreen: "\x1b[42m",
  bgRed:   "\x1b[41m",
  bgYellow:"\x1b[43m",
};

const c = (col, txt) => `${C[col]}${txt}${C.reset}`;

export function formatSignalAlert(pair, signal, indicators, timestamp, latency = "0.0") {
  const { action, confidence, entry, stopLoss, takeProfit, reasoning, sentiment, sentimentScore } = signal;

  const bgColor = action === "BUY" ? "bgGreen" : action === "SELL" ? "bgRed" : "bgYellow";
  const rr = (entry && stopLoss && takeProfit)
    ? (Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)).toFixed(2)
    : null;

  const bar = confidenceBar(confidence);

  let out = `\n${"─".repeat(58)}\n`;
  out += `  ${c("gray", timestamp)}  ${c("bold", c(bgColor, ` ${action} `))}  Confidence: ${bar} ${confidence}%  ${c("gray", `(${latency}s latency)`)}\n`;
  out += `${"─".repeat(58)}\n`;

  if (action !== "WAIT") {
    const isJPY = pair.includes("JPY");
    const pipSize = isJPY ? 0.01 : 0.0001;
    const slPips  = entry && stopLoss   ? (Math.abs(entry - stopLoss)   / pipSize).toFixed(1) : "—";
    const tpPips  = entry && takeProfit ? (Math.abs(takeProfit - entry)  / pipSize).toFixed(1) : "—";

    out += `  ${c("cyan",  "Entry      ")} ${entry?.toFixed(5) ?? "—"}\n`;
    out += `  ${c("red",   "Stop Loss  ")} ${stopLoss?.toFixed(5)   ?? "—"}  ${c("gray", `(${slPips} pips)`)}\n`;
    out += `  ${c("green", "Take Profit")} ${takeProfit?.toFixed(5) ?? "—"}  ${c("gray", `(${tpPips} pips)`)}\n`;
    if (rr) out += `  ${c("cyan", "R:R        ")} 1:${rr}\n`;
  }

  out += `\n  ${c("gray", "Sentiment:")} ${sentiment || "Neutral"} (${sentimentScore || "0"}%)  `;

  // Use dynamic EMA keys from config (default ema8/ema21)
  const emaFastKey = `ema${indicators.ema8 !== undefined ? 8 : 8}`;
  const emaSlowKey = `ema${indicators.ema21 !== undefined ? 21 : 21}`;
  const emaFastVal = indicators[emaFastKey] || indicators.ema8;
  const emaSlowVal = indicators[emaSlowKey] || indicators.ema21;

  if (emaFastVal) out += `${c("gray", "EMA8")} ${emaFastVal.toFixed(5)}  `;
  if (emaSlowVal) out += `${c("gray", "EMA21")} ${emaSlowVal.toFixed(5)}\n`;

  if (indicators.ema200) out += `  ${c("gray", "EMA200")} ${indicators.ema200.toFixed(5)}  `;
  if (indicators.vwap) out += `${c("gray", "VWAP")} ${indicators.vwap.toFixed(5)}  `;
  out += `${c("gray", "RSI7")} ${indicators.rsi?.toFixed(1) ?? "—"}  `;
  out += `${c("gray", "ATR")} ${indicators.atr?.toFixed(5) ?? "—"}`;
  if (indicators.atrAverage) out += ` ${c("gray", "(avg")} ${indicators.atrAverage.toFixed(5)}${c("gray", ")")}`;
  out += `\n`;

  out += `  ${c("gray", "BB ")} ${indicators.bbands.lower?.toFixed(5)} / ${indicators.bbands.upper?.toFixed(5)}`;
  if (indicators.hasPriceAction) out += `  ${c("yellow", "⚡PA")}`;
  if (indicators.nearSupport) out += `  ${c("green", "📍S/R:Support")}`;
  if (indicators.nearResistance) out += `  ${c("red", "📍S/R:Resistance")}`;
  out += `\n`;

  out += `\n  ${c("white", "📊 " + reasoning)}\n`;

  return out;
}

export function formatTradeResult(trade, signal, balance, units) {
  const riskPercent = (units * 10 / balance / 100).toFixed(1); // Rough estimate for display
  const riskAmount = (balance * (riskPercent / 100)).toFixed(2);
  let out = `\n  ${"─".repeat(50)}\n`;
  out += `  ✅  Trade Placed\n`;
  out += `  ${"─".repeat(50)}\n`;
  out += `  ID        : ${trade.id}\n`;
  out += `  Direction : ${signal.action}\n`;
  out += `  Units     : ${units.toLocaleString()}\n`;
  out += `  Fill Price: ${trade.price?.toFixed(5) ?? "pending"}\n`;
  out += `  Risk      : $${riskAmount} (${riskPercent}% of $${parseFloat(balance).toFixed(2)})\n`;
  out += `  ${"─".repeat(50)}\n\n`;
  return out;
}

function confidenceBar(pct) {
  const filled = Math.round((pct ?? 0) / 10);
  const empty  = 10 - filled;
  const color  = pct >= 75 ? "green" : pct >= 55 ? "yellow" : "red";
  return c(color, "█".repeat(filled) + "░".repeat(empty));
}
