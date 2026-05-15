# SYSTEM ANALYSIS — Kutoka Block Scalping Bot
## Written: May 2026 | Template for system improvement

---

## 1. WHAT THIS SYSTEM ACTUALLY IS

Despite the AGENTS.md describing a sophisticated multi-phase AI-driven system with RSI, ATR, ADX, VWAP, Bollinger Bands, MACD, and AI signal generation — **none of that exists in the live trading pipeline**.

The system that actually runs when you execute `npm run start` or `npm run auto` is a **simple 3-condition EMA pullback strategy** on a single pair (EUR_USD) on M5 candles. Nothing more.

---

## 2. THE LIVE TRADING PIPELINE — WHAT ACTUALLY RUNS

### Entry point: `index.js`

```
startup
  ├── connect to cTrader WebSocket (icmarkets.js)
  ├── authenticate (app auth + account auth via Protobuf)
  ├── reconcileAccount() — fetch open positions from broker & sync state
  ├── subscribeTicks(pair) — subscribe to live spot events (used for spread only)
  └── setInterval(tick, 10_000) — poll loop every 10 seconds
```

### Every tick (`tick()` → `tickPair()`):

```
1. WEEKEND / SESSION GUARD
   └── Skip if Saturday, Sunday, or outside session window (UTC)
       └── Default session: ny_only = 12:30–16:00 UTC
           Configurable via SESSION_WINDOW_MODE env var

2. CANDLE REFRESH
   └── icmarkets.getCandles(pair, "M5", 100)
       └── Fetches 100 M5 candles from cTrader via ProtoOAGetTrendbarsReq
       └── Returns { time, complete, volume, mid: { o, h, l, c } }
       └── If fetch fails but cache exists → continue with cached candles
       └── Minimum 22 candles required, otherwise skip

3. COOLDOWN CHECK
   └── If cooldownCandlesRemaining > 0 → skip (counts down each new candle)
       └── Triggered after a stop-loss hit (cooldownCandlesAfterLoss = 1 candle default)

4. SIGNAL GENERATION — generateSignal() from indicators.js
   └── See Section 3 below

5. TRADE GATE
   └── If activeTrades.length >= maxTradesPerPair (1) → skip
   └── If signal === 'none' → skip

6. EXECUTION (only if --auto-execute flag is set)
   └── riskManager.calculateVolume(pair, riskPips, entry) — compute lot size
   └── icmarkets.openPosition(pair, action, units, sl, tp, entry)
   └── On success: push to activeTrades[], saveState()
```

### Execution events (async, not in the poll loop):

```
icmarkets.on(2126, handleExecutionEvent)
  └── Fires when a position is closed broker-side (DEAL_FILLED)
  └── Removes from activeTrades[]
  └── If exit price ≈ SL → sets cooldownCandlesRemaining = 1
  └── Calls saveState()
```

---

## 3. SIGNAL GENERATION — THE ONLY STRATEGY IN USE

**File:** `indicators.js`  
**Function:** `generateSignal(candles, opts)`

### Indicators calculated (ALL that exist):

| Indicator | Periods | Used for |
|---|---|---|
| EMA | 5 | Fast trend line |
| EMA | 10 | Trigger line (pullback + trigger detection) |
| EMA | 20 | Slow trend line |

### The 4 conditions that must ALL pass for a signal:

```
Condition 1 — EMA TREND ALIGNMENT (detectTrend)
  BUY:  EMA5 > EMA10 > EMA20 (all stacked bullish)
  SELL: EMA5 < EMA10 < EMA20 (all stacked bearish)
  ELSE: 'neutral' → NO SIGNAL

Condition 2 — OPTIONAL EMA SEPARATION FILTER
  |EMA5 - EMA20| / pipSize >= emaSeparationMinPips
  Default: 0 (disabled). Set via EMA_SEPARATION_MIN_PIPS env var.
  ny_quality mode sets this to 0.5 pips.

Condition 3 — PULLBACK ON PREVIOUS CANDLE (hasPullback)
  BUY:  prevCandle.low  <= prevEMA10  OR  prevCandle.low  <= prevEMA20
  SELL: prevCandle.high >= prevEMA10  OR  prevCandle.high >= prevEMA20

Condition 4 — EARLY TRIGGER ON CURRENT CANDLE (hasEarlyTrigger)
  BUY:  prevClose <= EMA10  AND  currentClose > EMA10  (crosses back above)
  SELL: prevClose >= EMA10  AND  currentClose < EMA10  (crosses back below)
```

### Trade parameter calculation (calcTradeParams):

```
Entry   = currentClose
SL      = triggerCandle.low  - pipBuffer  (BUY)
          triggerCandle.high + pipBuffer  (SELL)
          pipBuffer = 0.00005 (0.5 pip buffer)
Risk    = |entry - SL|
TP      = entry + (risk × rrRatio)  (BUY)
          entry - (risk × rrRatio)  (SELL)
          rrRatio = 1.5

Risk filters:
  riskPips < 2 pips  → NO SIGNAL (minRiskPips)
  riskPips > 15 pips → NO SIGNAL (maxRiskPips)
```

### What `generateSignal()` returns:

```js
{
  signal:     'buy' | 'sell' | 'none',
  trend:      'bull' | 'bear' | 'neutral',
  entry:      number,   // currentClose, 5dp
  sl:         number,   // absolute price, 5dp
  tp:         number,   // absolute price, 5dp
  riskPips:   number,
  rewardPips: number,
  ema5:       number,
  ema10:      number,
  ema20:      number,
  reason:     string    // human-readable explanation
}
```

---

## 4. POSITION SIZING — WHAT RiskManager.calculateVolume() DOES

Called in `index.js` immediately before placing a trade:

```
units = riskAmountPerTradeKES / (slPips × pipValuePerUnitKES)

where:
  riskAmountPerTradeKES = dailyStopLossKES / maxOpenTrades
                        = 1,000 KES / 1 = 1,000 KES

  pipValuePerUnitKES (for EUR_USD):
    pipValueUSD per std lot = 0.0001 × 100,000 = $10
    pipValueKES per std lot = $10 × usdKesRate (129.0)
    pipValuePerUnitKES      = 1,290 / 100,000 = 0.0129 KES

Leverage cap:
  notionalKES = units × currentRate × usdKesRate
  maxNotionalKES = accountCapitalKES × maxLeverage = 50,000 × 100 = 5,000,000 KES
  If notionalKES > maxNotionalKES → cap units

Also caps at config.maxPositionSizeUnits
  ⚠️  BUG: config.maxPositionSizeUnits is NOT defined in config.js
      This makes the comparison (units > undefined) → always false, so the cap never fires
      But it does not throw — JavaScript treats undefined comparisons as false
```

---

## 5. THE CONNECTION LAYER — icmarkets.js

### Protocol
- **Protobuf binary** over **WebSocket Secure (WSS) port 5035**
- Uses 4 `.proto` files in the project root to encode/decode messages
- The outer wrapper is `ProtoMessage { payloadType, payload (bytes), clientMsgId }`
- The inner payload is the specific message type (e.g., `ProtoOAGetTrendbarsReq`)

### Authentication sequence (called every connect):
```
1. ProtoOAVersionReq       (payloadType 2104) → ProtoOAVersionRes
2. ProtoOAApplicationAuthReq (2100, clientId + secret) → ProtoOAApplicationAuthRes
3. ProtoOAAccountAuthReq   (2102, accountId + accessToken) → ProtoOAAccountAuthRes
```

### Price data flow:
```
icmarkets.getCandles(pair, "M5", 100)
  → ProtoOAGetTrendbarsReq
    { ctidTraderAccountId, symbolId, period: 5, fromTimestamp, toTimestamp, count: 100, quoteType: 1 (BID) }
  ← ProtoOAGetTrendbarsRes { trendbar: [...] }

Each trendbar:
  { low (int), deltaOpen (int), deltaClose (int), deltaHigh (int), utcTimestampInMinutes, volume }
  
Decoded as:
  low   = bar.low / 100000
  open  = (bar.low + bar.deltaOpen)  / 100000
  close = (bar.low + bar.deltaClose) / 100000
  high  = (bar.low + bar.deltaHigh)  / 100000
  time  = new Date(bar.utcTimestampInMinutes * 60_000).toISOString()

⚠️  NOTE: Only BID candles are fetched in the live bot (quoteType=1)
    The download script fetches both BID and ASK and merges to MID.
    The live bot does not simulate spread — it trades on bid prices only.
```

### Order placement:
```
icmarkets.openPosition(pair, action, units, sl, tp, entryPriceHint)
  → icmarkets.createOrder({ instrument, units (signed), stopLoss, takeProfit, entryPrice })
    → ProtoOANewOrderReq {
        orderType: 1 (MARKET),
        tradeSide: 1 (BUY) or 2 (SELL),
        volume: units × 100 (cTrader internal format),
        slippage: maxSlippagePips × pipSize × 100000 (default: 2 pips),
        relativeStopLoss:   |stopLoss - entryPrice| × 100000,
        relativeTakeProfit: |takeProfit - entryPrice| × 100000
      }
  ← Waits for ProtoOAExecutionEvent (executionType = 3 ORDER_FILLED)
     OR ProtoOAOrderErrorEvent (throws error)
  
Returns: { id: positionId, price: executionPrice, units, instrument, time }
```

### Health maintenance:
```
Heartbeat:     ProtoHeartbeat every 20s
Keepalive:     WebSocket-level ping every 4 minutes (prevents GCP idle TCP drop)
Health monitor: Checks lastMessageTime every 5s; logs EMERGENCY alert if >60s silence
Auto-reconnect: On WebSocket close → waits 5s → reconnect() + authenticate()
```

### Symbol ID resolution:
```
_resolveSymbolId(instrument)
  1. Check this.symbols cache (populated by getSymbol())
  2. Fallback to config.ctraderSymbolIds["EUR_USD"] → hardcoded as 1
  
⚠️  config.ctraderSymbolIds is hardcoded: { "EUR_USD": 1 }
    Symbol ID 1 is almost certainly WRONG for a real account.
    Must run get-symbols.js and update config.js before live trading.
```

---

## 6. STATE PERSISTENCE

### `state.json`
- Written by `saveState()`, read by `loadState()` on startup
- Format: `{ activeTrades: [{ id, direction, pair, entry, sl, tp }] }`
- Used to survive crashes — on restart, `reconcileAccount()` syncs against broker

### `risk-state.json`
- Written/read by `RiskManager._saveState()` / `_loadState()`
- Format: `{ currentDayUTC, tradingEnabled, dailyRealizedPnLKES, dailyRealizedProfit, dailyRealizedLoss, openTradeCount, tradeLog, lastUpdated }`
- Resets every UTC day
- ⚠️  **CRITICAL GAP**: `RiskManager.onTradeOpened()` and `onTradeClosed()` are never called in `index.js`
  - `openTradeCount` in the RiskManager is always 0
  - Daily P&L is never tracked

### `activity.log`
- Append-only JSONL
- Only written to by `logConnectionAlert()` in icmarkets.js — only on connection health alerts
- Not written to on trades

---

## 7. SESSION MANAGEMENT

### Session windows (UTC):
```
ny_only    (default): 12:30 – 16:00 UTC
ny_quality:           12:30 – 16:00 UTC  (+ EMA separation ≥ 0.5 pips)
ny_trimmed:           12:45 – 15:45 UTC
all_windows:          07:00 – 10:00 UTC (London open) + 12:30 – 16:00 UTC (NY overlap)
```

### `getActiveSessionWindowUTC(now)` in index.js:
- Returns the matching window object if within a window, or `null` if outside
- Weekends (day 0 or 6) are blocked unconditionally
- Only checks UTC time — no timezone conversion

---

## 8. FILES AND THEIR ACTUAL STATUS

### ACTIVE — called from the live pipeline

| File | Role | Called by |
|---|---|---|
| `index.js` | Entry point, main loop | `npm run start / auto` |
| `icmarkets.js` | WebSocket client, order execution, candle data | `index.js` |
| `indicators.js` | EMA 5/10/20 signal generator | `index.js`, backtests |
| `config.js` | All configuration | every file |
| `risk-manager.js` | Volume/lot calculation (partially wired) | `index.js` |

### ACTIVE — development / offline tooling only

| File | Role | Called by |
|---|---|---|
| `backtest-multi.js` | Multi-pair backtester using history files | `npm run backtest` |
| `backtest.js` | Single-pair backtester (older, still works) | `npm run backtest-mock` (via description) |
| `download-history.js` | Downloads historical candles to JSON | `npm run download` |
| `auth.js` | One-time OAuth2 token flow | `npm run auth` |
| `get-symbols.js` | Fetch real symbol IDs (JSON protocol, port 5036) | `npm run symbols` |
| `trade-analyzer.js` | CLI summary of trades_backtest.json | `npm run analyze` |
| `generate-report.js` | HTML dashboard from trades_backtest.json | `npm run analyze` |
| `compare-modes.js` | Runs backtest across all session modes | `npm run compare:modes` |
| `prune-mode-snapshots.js` | Cleans old mode_compare_*.json files | `npm run compare:modes:prune` |

### DEAD CODE — not imported anywhere in the live pipeline

| File | Why it exists | Current status |
|---|---|---|
| `ai.js` | Ollama/Anthropic AI integration | `config.aiMode = "OFF"`. Not imported in `index.js`. Fully unused in live bot and backtests. |
| `formatter.js` | Terminal output formatting | Not imported in `index.js`. Only useful if AI mode were active. References indicators (RSI7, ATR, EMA8/21/200, VWAP, BBands) that **do not exist** in the current `indicators.js`. |

---

## 9. WHAT THE AGENTS.md DESCRIBES VS WHAT IS REAL

The AGENTS.md describes a significantly more advanced version of the system. Here is what is documented vs what actually exists:

| Feature described in AGENTS.md | Reality |
|---|---|
| EMA(8/21/200) | NOT in indicators.js. Only EMA 5/10/20 exist. |
| RSI(7) | NOT in indicators.js. |
| ATR(14) | NOT in indicators.js. |
| ADX(14) | NOT in indicators.js. |
| VWAP | NOT in indicators.js. |
| Bollinger Bands with squeeze detection | NOT in indicators.js. |
| MACD | NOT in indicators.js. |
| Engulfing patterns | NOT in indicators.js. |
| Pin bars | NOT in indicators.js. |
| S/R zones | NOT in indicators.js. |
| Multi-timeframe (M5 + M15 + H1) | NOT in index.js. Only M5 is fetched. |
| Phase 2 filters (EMA200, ATR volatility, session hours) | Only session hours exist. No EMA200. No ATR filter. |
| Phase 3 triggers (price action, S/R zone requirement) | NOT implemented. |
| AI signal generation (HYBRID/ALWAYS mode) | Not wired in index.js. aiMode = "OFF" and no AI call exists. |
| RiskManager.canTrade() gate before orders | canTrade() is **never called** in index.js. |
| Daily KES P&L tracking (onTradeOpened/onTradeClosed) | Neither method is called in index.js. Daily tracking is broken. |
| Breakeven / trailing stop | NOT implemented in index.js. |
| 2-pip slippage protection | ✅ Exists in icmarkets.js (createOrder). |
| KES-denominated lot sizing | ✅ calculateVolume() exists and is called. |
| Cooldown after stop loss | ✅ Implemented in index.js + backtests. |
| Session windows gating | ✅ Implemented. |

---

## 10. KNOWN BUGS / GAPS

### Bug 1: `config.maxPositionSizeUnits` is undefined
**Location:** `risk-manager.js` line 133  
**Code:** `if (units > config.maxPositionSizeUnits)`  
**Effect:** `config.maxPositionSizeUnits` is not defined in `config.js`. The comparison `units > undefined` is always `false`. The lot size cap never fires. This is benign but means the leverage cap (`accountCapitalKES × maxLeverage`) is the only upper bound.

### Bug 2: `riskManager.canTrade()` is never called
**Location:** `index.js` — not present anywhere  
**Effect:** The daily stop-loss (1,000 KES) and daily profit target (500 KES) hard limits are never checked before placing trades. The bot will trade regardless of daily P&L breaches.

### Bug 3: `riskManager.onTradeOpened()` and `riskManager.onTradeClosed()` are never called
**Location:** `index.js` — not present anywhere  
**Effect:** The RiskManager's daily P&L state is never updated. `openTradeCount` in RiskManager is always 0 (though `state.activeTrades` is tracked separately and works). `risk-state.json` daily counters are frozen at their loaded values.

### Bug 4: Symbol ID is hardcoded as 1
**Location:** `config.js` — `ctraderSymbolIds: { "EUR_USD": 1 }`  
**Effect:** On any real IC Markets account, EUR/USD is almost certainly not symbol ID 1. The bot will fail to place orders or fetch candles silently using wrong data. Must run `node get-symbols.js` and update the config.

### Bug 5: Live candles are BID-only, no spread simulation
**Location:** `icmarkets.js` — `getCandles(..., quoteType = 1)`  
**Effect:** The bot evaluates signals and places entries based on bid prices. For SELL orders, entry should ideally be on the ASK. In backtesting, spread is simulated (+/- SPREAD_PIPS/2). In live trading, this discrepancy is unhandled — the slippage protection is the only guard.

### Bug 6: `riskManager.validateRiskReward()` takes `signal.stopLoss` / `signal.takeProfit`
**Location:** `risk-manager.js` line 146  
**Effect:** The method uses `signal.stopLoss` and `signal.takeProfit` as property names, but `generateSignal()` returns `signal.sl` and `signal.tp`. The method would always return `false` if called. It is not called anywhere in the live bot.

---

## 11. THE BACKTEST PIPELINE

### Multi-pair backtester (`backtest-multi.js`):
```
1. Load history_PAIR.json for each pair in config.tradingPairs
2. Merge bid+ask to mid if needed (history files have bid, ask, mid fields)
3. Build a unified sorted timestamp list across all pairs
4. For each timestamp:
   a. Check if weekend → skip
   b. Check session window via isTradeWindowUTC() → skip if outside
   c. Check cooldown → skip if active
   d. Run generateSignal() on last 100 candles
   e. If signal and slot available → open trade
   f. On next candles, check if SL or TP hit (using bid/ask simulation)
5. Output: trades_backtest.json
```

### Spread simulation in backtest (but not in live):
```
spread = SPREAD_PIPS × pipSize = 0.5 × 0.0001 = 0.00005 (EUR_USD)
bidLow  = midLow  - spread/2
bidHigh = midHigh - spread/2
askHigh = midHigh + spread/2
askLow  = midLow  + spread/2

BUY hit SL:  bidLow  <= trade.sl
BUY hit TP:  bidHigh >= trade.tp
SELL hit SL: askHigh >= trade.sl
SELL hit TP: askLow  <= trade.tp
```

### Lot sizing in backtest (different from live):
```
units = min(10000, floor((INITIAL_BALANCE × 0.02) / (riskPips × (10/100000))))
⚠️  This formula does not use RiskManager.calculateVolume()
    It is a fixed 2% USD risk formula, not KES-denominated
```

---

## 12. CONFIGURATION REFERENCE (config.js — all active fields)

```
ctraderClientId, ctraderClientSecret, ctraderAccessToken  → from .env
ctraderAccountId                                          → from .env
ctraderEnv: "demo"                                        → hardcoded, must change for live

ctraderSymbolIds: { "EUR_USD": 1 }                        → ⚠️  must be updated from get-symbols.js

tradingPairs: ["EUR_USD"]                                 
granularity: "M5"                                         
pollIntervalSeconds: 10                                   
connectionTimeoutSeconds: 60                              

sessionWindowMode: "ny_only"                              → override with SESSION_WINDOW_MODE env
sessionWindowsUTC: [{ name, start, end }]                 → selected from presets based on mode
sessionStartUTC: 12.5  / sessionEndUTC: 16.0              → legacy fallback only

risk.accountCapitalKES: 50,000
risk.dailyStopLossKES: 1,000
risk.dailyProfitTargetKES: 500
risk.maxLeverage: 100
risk.usdKesRate: 129.0
risk.riskPerTradeKES: 1,000
risk.minRiskReward: 1.5

maxTotalTrades: 1
maxTradesPerPair: 1

strategy.pipBuffer: 0.00005
strategy.rrRatio: 1.5
strategy.minRiskPips: 2         → override with MIN_RISK_PIPS env
strategy.maxRiskPips: 15        → override with MAX_RISK_PIPS env
strategy.cooldownCandlesAfterLoss: 1  → override with COOLDOWN_CANDLES_AFTER_LOSS env
strategy.emaSeparationMinPips: 0      → override with EMA_SEPARATION_MIN_PIPS env

backtest.spreadPips: 0.2
backtest.slippagePips: 0.3
backtest.commissionPerSideUSD: 3.00
backtest.initialBalance: 385          → ~$50,000 KES at 129 rate
```

---

## 13. DEPENDENCY MAP

```
index.js
  ├── icmarkets.js
  │     ├── ws (npm: WebSocket)
  │     ├── protobufjs (npm: Protobuf encode/decode)
  │     ├── long (npm: 64-bit integer support for cTrader IDs)
  │     └── config.js
  ├── config.js
  │     └── dotenv (npm: .env loader)
  ├── indicators.js  (no external deps — pure math)
  └── risk-manager.js
        └── config.js

backtest-multi.js / backtest.js
  ├── indicators.js
  └── config.js

ai.js (UNUSED in live pipeline)
  ├── config.js
  └── @anthropic-ai/sdk (dynamically imported only if provider = "anthropic")

formatter.js (UNUSED)
  └── (no deps)
```

---

## 14. IMPROVEMENT OPPORTUNITIES (observed gaps, no implementation yet)

Based strictly on what was found in the code — no assumptions:

1. **Wire up RiskManager.canTrade()** — add a call in `tickPair()` before the execution block
2. **Wire up onTradeOpened() / onTradeClosed()** — call in handleExecutionEvent() and after openPosition() success
3. **Fix symbol IDs** — replace hardcoded `{ "EUR_USD": 1 }` with real IDs from get-symbols.js
4. **Add missing config.maxPositionSizeUnits** — undefined reference in risk-manager.js
5. **Live spread awareness** — fetch both BID and ASK for signal evaluation, or use mid prices
6. **Add more indicators to indicators.js** — RSI, ATR are natural first additions that many of the other files (formatter.js, ai.js) already expect
7. **Activate formatter.js** — replace raw console.log in index.js with formatted output once indicators match
8. **Session time verification** — current bot is fixed to UTC; no EAT (UTC+3) awareness in the running code

---

*This document reflects the actual state of the code as of May 2026. It is intended as the ground-truth baseline before any further development.*

