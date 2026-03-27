/**
 * Terminal Output Formatter
 * Clean, readable signal and trade output
 */

const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  white: "\x1b[97m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

export function formatSignalAlert(signal, indicators, timestamp) {
  const { action, confidence, entry, stopLoss, takeProfit, reasoning } = signal;

  const actionColor =
    action === "BUY" ? "green" : action === "SELL" ? "red" : "yellow";
  const actionBg =
    action === "BUY" ? "bgGreen" : action === "SELL" ? "bgRed" : "bgYellow";

  const rr =
    entry && stopLoss && takeProfit
      ? Math.abs(takeProfit - entry) / Math.abs(entry - stopLoss)
      : null;

  const confBar = confidenceBar(confidence);

  let out = `\n${"─".repeat(56)}\n`;
  out += `  ${c("gray", timestamp)}  Signal: ${c("bold", c(actionBg, ` ${action} `))}  Confidence: ${confBar} ${confidence}%\n`;
  out += `${"─".repeat(56)}\n`;

  if (action !== "WAIT") {
    out += `  ${c("cyan", "Entry")}      ${entry?.toFixed(5) ?? "—"}\n`;
    out += `  ${c("red", "Stop Loss")}  ${stopLoss?.toFixed(5) ?? "—"}`;
    if (entry && stopLoss)
      out += c("gray", `  (${(Math.abs(entry - stopLoss) * 10000).toFixed(1)} pips)`);
    out += `\n`;
    out += `  ${c("green", "Take Profit")} ${takeProfit?.toFixed(5) ?? "—"}`;
    if (entry && takeProfit)
      out += c("gray", `  (${(Math.abs(takeProfit - entry) * 10000).toFixed(1)} pips)`);
    out += `\n`;
    if (rr) out += `  ${c("cyan", "R:R")}        1:${rr.toFixed(2)}\n`;
  }

  out += `\n  ${c("gray", "Indicators")}  EMA9 ${indicators.ema9.toFixed(5)} | EMA21 ${indicators.ema21.toFixed(5)}\n`;
  out += `               RSI ${indicators.rsi.toFixed(1)} | ATR ${indicators.atr.toFixed(5)}\n`;
  out += `\n  ${c("white", "📊 " + reasoning)}\n`;

  return out;
}

export function formatTradeResult(trade, signal, balance, units) {
  const riskAmount = balance * 0.01;
  let out = `\n  ${"─".repeat(48)}\n`;
  out += `  ✅ Trade Placed Successfully\n`;
  out += `  ${"─".repeat(48)}\n`;
  out += `  Trade ID   : #${trade.id}\n`;
  out += `  Direction  : ${signal.action}\n`;
  out += `  Units      : ${units.toLocaleString()}\n`;
  out += `  Fill Price : ${trade.price}\n`;
  out += `  Risk       : $${riskAmount.toFixed(2)} (1% of $${balance.toFixed(2)})\n`;
  out += `  ${"─".repeat(48)}\n\n`;
  return out;
}

function confidenceBar(confidence) {
  const filled = Math.round(confidence / 10);
  const empty = 10 - filled;
  const color = confidence >= 75 ? "green" : confidence >= 55 ? "yellow" : "red";
  return c(color, "█".repeat(filled) + "░".repeat(empty));
}
