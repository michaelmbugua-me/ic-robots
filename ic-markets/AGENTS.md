# AGENTS.md

## Project Overview

AI-powered forex scalping bot connecting **local Ollama LLMs** to the **IC Markets cTrader Open API** via Protobuf-over-WebSocket. Pure Node.js (ESM), zero framework, no test suite. **KES-denominated risk engine** manages a 50,000 KES account with strict daily drawdown limits.

## Architecture

The main loop (`index.js`) runs a polling cycle every 60s:
1. **RiskManager gate** → `risk-manager.js` checks daily KES P&L limits, open trade count, and trading permission before ANY order
2. **Market data** → `icmarkets.js` fetches multi-timeframe candles (M5 entry + M15 trend + H1 for EMA200)
3. **Data validation** → All tick data validated for NaN/zero/invalid values before indicator calculation
4. **Indicators** → `indicators.js` computes EMA(8/21/200), RSI(7), ATR(14), ADX(14), VWAP, Bollinger Bands (with squeeze detection), MACD, engulfing patterns, pin bars, S/R zones — all from scratch, no external library
5. **Phase 2 filters** → EMA(200) trend filter (H1), ATR volatility filter (ATR > 20-day avg), session hours (London/NY overlap only)
6. **Hard filters** → Short-circuit checks (ADX floor, RSI extremes, EMA alignment, falling knife, HTF trend)
7. **Phase 3 triggers** → Price Action confirmation (Bullish Engulfing / Pin Bar) within S/R zones required for entry
8. **Signal generation** → Default mode (`OFF`) uses pure indicators. Optional `HYBRID`/`ALWAYS` modes route through `ai.js`
9. **RiskManager execution gate** → `riskManager.canTrade()` called AGAIN before `ProtoOANewOrderReq`
10. **Execution** → `icmarkets.js` places market orders with 2-pip slippage protection, RiskManager-calculated KES lot sizing

**Risk Engine (4 Phases):**
- **Phase 1**: Global guardrails — 1,000 KES daily stop-loss, 1,000 KES profit target, max 1 trade, dynamic KES-based lot sizing, 1:100 max leverage
- **Phase 2**: Market environment — EMA(200) on H1 trend filter, 15:00–19:00 EAT session, ATR volatility filter
- **Phase 3**: Trade execution — Price action triggers (engulfing/pin bar) at S/R zones, 1:1.5 min R:R, breakeven at 1×risk, 2-pip max slippage
- **Phase 4**: Error handling — 10s connection heartbeat monitor, tick data validation, emergency logging

## Key Commands

```bash
npm run auth          # One-time OAuth2 token (launches localhost:3000 callback server)
npm run symbols       # Fetch real symbol IDs → paste into config.js ctraderSymbolIds
npm run download      # Download history_PAIR.json for backtesting (--pair EUR_USD,GBP_USD --days 30)
npm run start         # Monitor-only mode (no trades placed)
npm run auto          # Auto-execute EUR/USD trades
npm run backtest      # Backtest with real AI (supports multi-pair: --pair EUR_USD,GBP_USD)
npm run backtest-mock # Backtest with deterministic mock signal logic (no AI needed)
```

Backtest also accepts `--provider ollama|anthropic` and `--model MODEL_NAME` to override AI settings from the CLI.

Pair-specific shortcuts: `npm run gbp`, `npm run gbp-auto`, `npm run jpn`, `npm run jpn-auto`. Custom pair via `--pair GBP_USD --auto-execute`.

## Conventions & Patterns

- **ESM only** — all files use `import/export`, `"type": "module"` in package.json
- **No test framework** — validation is done via backtesting (`backtest.js`)
- **Candle format** — standardized as `{ time, complete, volume, mid: { o, h, l, c } }` (OANDA-compatible shape) even though data comes from cTrader Protobuf
- **Pip math** — JPY pairs use `pipSize = 0.01`, all others use `0.0001`. Always check `PAIR.includes("JPY")`
- **cTrader prices** — raw integers divided by `100000` (5 decimal places). Volume is `units * 100` internally
- **Symbol IDs** — use `EUR_USD` format (underscore separator) in config; cTrader uses `EURUSD` or `EUR/USD`
- **State persistence** — `state.json` stores per-pair state as `{ pairStates: { PAIR: { lastSignal, activeTrades } } }` to survive crashes. `loadState()` auto-migrates the old flat `activeTrades` format. `activity.log` is append-only JSONL audit trail
- **AI hallucination guards** — `processSignal()` in `index.js` force-corrects entry/SL/TP prices using ATR if AI returns illogical values
- **Config is the single source of truth** — all risk params, strategy thresholds, and API credentials flow from `config.js` (backed by `.env`)
- **Entry confirmation gate** — triggers require at least one of: rejection candle, MACD histogram turning, or above-average volume
- **Trailing stop** — once profit reaches `breakevenTriggerATR` (1.5x ATR), SL trails at `trailingStopATR` (1.0x ATR) behind price; SL only moves forward. Per-pair overrides in `pairOverrides` (e.g., GBP_USD uses 1.3x/1.0x)
- **Session hours** — bot only trades 08:00–18:00 UTC (London + New York). `currentSession()` in `index.js` returns `"off"` outside this window
- **History files** — `download-history.js` fetches both BID and ASK candles, merging into `history_PAIR.json` with separate `bid`, `ask`, and `mid` OHLC fields for realistic backtest spread simulation

## Critical Integration Points

- **cTrader Open API** (`icmarkets.js`): Protobuf binary over WSS port 5035. Uses `.proto` files in project root. Auth is 2-step: app auth → account auth. Heartbeat every 20s required. Note: `get-symbols.js` uses the older JSON protocol on port 5036
- **Ollama** (`ai.js`): HTTP POST to `localhost:11434/api/chat` with `format: "json"`. Response parsed with aggressive fallback: strip `<think>` tags → try JSON.parse → regex extract `{...}` → default to WAIT
- **Backtest** (`backtest-multi.js`): Simulates spread, slippage, and IC Markets commissions ($3/side per $100k). Supports multi-pair testing by syncing candles from multiple `history_PAIR.json` files. `--mock` flag bypasses AI entirely with deterministic RSI+BB+MACD logic.

## Files to Understand First

| File | Why |
|---|---|
| `config.js` | Every tunable parameter — KES risk params, ATR multipliers, AI mode, session hours, ADX/volume thresholds |
| `risk-manager.js` | **NEW** — RiskManager class: daily KES P&L tracking, lot size calculator, R:R validation, trade lifecycle |
| `index.js` | The `tick()` function is the complete trading pipeline with 4-phase risk engine |
| `icmarkets.js` | Protobuf encode/decode, slippage protection, connection health monitoring |
| `ai.js` | System/user prompt construction and the `parseSignalResponse()` fallback chain |
| `backtest-multi.js` | Multi-pair backtester with shared balance and commission simulation |
| `indicators.js` | All indicators: EMA(8/21/200), RSI, ATR, ADX, MACD, BBands, VWAP, engulfing patterns, S/R zones |
| `formatter.js` | Terminal output formatting for signal alerts and trade results |

