# 🤖 Forex Scalping Bot — Setup Guide

AI-powered forex scalping signals using **Claude AI** + **OANDA**.

---

## 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- An OANDA account (practice/demo recommended to start)
- An Anthropic API key

---

## 2. Get Your API Keys

### OANDA (Free Practice Account)
1. Sign up at https://www.oanda.com → open a **Demo account**
2. Go to **My Services → Manage API Access**
3. Generate an API key
4. Note your **Account ID** (shown on dashboard)

### Anthropic
1. Go to https://console.anthropic.com
2. Create an API key under **API Keys**

---

## 3. Install

```bash
cd forex-bot
npm install
```

---

## 4. Set Environment Variables

Create a `.env` file (or set in your terminal):

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
OANDA_API_KEY=your-oanda-api-key
OANDA_ACCOUNT_ID=your-account-id
```

Then load it before running:
```bash
export $(cat .env | xargs)
```

Or on Windows (PowerShell):
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-xxx"
$env:OANDA_API_KEY="your-key"
$env:OANDA_ACCOUNT_ID="your-id"
```

---

## 5. Run the Bot

### Monitor Only (recommended to start)
```bash
node index.js
```
Claude will print signals — YOU decide whether to trade.

### Auto-Execute Mode
```bash
node index.js --auto-execute
```
⚠️ Trades will be placed automatically via OANDA.

### Change Currency Pair
```bash
node index.js --pair GBP_USD
node index.js --pair USD_JPY --auto-execute
```

### npm shortcuts
```bash
npm start          # EUR/USD monitor
npm run auto       # EUR/USD auto-execute
npm run gbp        # GBP/USD monitor
npm run gbp-auto   # GBP/USD auto-execute
```

---

## 6. Configuration (`config.js`)

| Setting | Default | Description |
|---|---|---|
| `oandaEnv` | `"practice"` | `"practice"` or `"live"` |
| `granularity` | `"M5"` | Candle timeframe |
| `pollIntervalSeconds` | `60` | How often to check |
| `riskPercentPerTrade` | `1` | % of balance per trade |
| `minConfidenceToExecute` | `72` | Min AI confidence to auto-trade |

---

## 7. Understanding the Output

```
────────────────────────────────────────────────────────
  14:32:05  Signal: [ BUY ]  Confidence: ████████░░ 80%
────────────────────────────────────────────────────────
  Entry       1.08432
  Stop Loss   1.08390  (4.2 pips)
  Take Profit 1.08516  (8.4 pips)
  R:R         1:2.00

  Indicators  EMA9 1.08441 | EMA21 1.08398
              RSI 54.3 | ATR 0.00048

  📊 Bullish EMA crossover with RSI in neutral zone during London session
```

---

## 8. ⚠️ Important Risk Warnings

- **Start on practice/demo** — never test with live money first
- Scalping is high-risk; most retail traders lose money
- The bot risks **1% of balance per trade** by default — do not increase this
- Only trade during **London (8am–5pm GMT)** or **New York (1pm–10pm GMT)** sessions
- This is not financial advice — use at your own risk
- Monitor the bot regularly; don't leave it unattended for long periods

---

## 9. Best Pairs for Scalping

| Pair | Spread | Volatility | Best Session |
|---|---|---|---|
| EUR/USD | Low | Medium | London + NY |
| GBP/USD | Medium | High | London |
| USD/JPY | Low | Medium | Tokyo + NY |
| EUR/JPY | Medium | High | London + Tokyo |

---

## Architecture

```
OANDA API  →  candles  →  indicators.js  →  index.js
                                               │
                                    Anthropic API (Claude)
                                               │
                                         Signal JSON
                                               │
                              ┌────────────────┴──────────────┐
                         Terminal Alert                  OANDA Order
                        (always shown)               (if --auto-execute)
```
