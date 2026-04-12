# AGENTS.md

## Project Overview

AI-powered forex scalping bot connecting **local Ollama LLMs** to the **IC Markets cTrader Open API** via Protobuf-over-WebSocket. Pure Node.js (ESM), zero framework, no test suite.

## Architecture

The main loop (`index.js`) runs a polling cycle every 60s:
1. **Market data** → `icmarkets.js` fetches multi-timeframe candles (M5 entry + M15 trend)
2. **Indicators** → `indicators.js` computes EMA(8/21), RSI(7), ATR(14), ADX(14), VWAP, Bollinger Bands (with squeeze detection), MACD — all from scratch, no external library
3. **Hard filters** → Short-circuit checks (ADX floor, RSI extremes, EMA alignment, falling knife, HTF trend) eliminate invalid setups
4. **Signal generation** → Default mode (`OFF`) uses pure indicators with zero latency. Optional `HYBRID`/`ALWAYS` modes route through `ai.js` for Ollama/Anthropic confirmation
5. **Execution** → `icmarkets.js` places market orders via Protobuf, manages trailing stop, and reconciles state on restart

**Dual-strategy system** — each pair runs one of two strategy modes (set via `config.pairOverrides`):
- `pullback` (default, EUR_USD): buys oversold dips near lower BB in uptrend, sells overbought near upper BB in downtrend
- `momentum` (GBP_USD): buys BB squeeze breakouts (bands expanding from compression) with RSI/MACD/volume/candle-body confirmation, sells breakdowns below lower BB

**Per-pair state** — `pairState` Map tracks `{ lastSignal, activeTrades }` per pair. Account-level checks (daily circuit breaker, cooldown) are shared across all pairs.

Data flow: `config.js` (all tuning knobs) → `index.js` (orchestrator, scans all `tradingPairs` each tick) → `icmarkets.js` (broker API) + `ai.js` (LLM, optional) + `news.js` (Finnhub sentiment)

## Key Commands

```bash
npm run auth          # One-time OAuth2 token (launches localhost:3000 callback server)
npm run symbols       # Fetch real symbol IDs → paste into config.js ctraderSymbolIds
npm run download      # Download history_PAIR.json for backtesting (--pair EUR_USD,GBP_USD --days 30)
npm run start         # Monitor-only mode (no trades placed)
npm run auto          # Auto-execute EUR/USD trades
npm run backtest      # Backtest with real AI (supports multi-pair: --pair EUR_USD,GBP_USD)
npm run backtest-mock # Backtest with deterministic mock signal logic (no AI needed)
npm run test-news     # Debug Finnhub connectivity and news filtering
```

Backtest also accepts `--provider ollama|anthropic` and `--model MODEL_NAME` to override AI settings from the CLI.

Pair-specific shortcuts: `npm run gbp`, `npm run gbp-auto`, `npm run jpn`, `npm run jpn-auto`. Custom pair via `--pair GBP_USD --auto-execute`.

## Conventions & Patterns

- **ESM only** — all files use `import/export`, `"type": "module"` in package.json
- **No test framework** — validation is done via backtesting (`backtest.js`) and `debug-news.js`
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
- **Finnhub** (`news.js`): Dual-channel — REST for economic calendar + WebSocket for real-time headlines. News buffer stored on `global.finnhubWsClient`. Economic calendar may require premium tier
- **Backtest** (`backtest-multi.js`): Simulates spread, slippage, and IC Markets commissions ($3/side per $100k). Supports multi-pair testing by syncing candles from multiple `history_PAIR.json` files. `--mock` flag bypasses AI entirely with deterministic RSI+BB+MACD logic.

## Files to Understand First

| File | Why |
|---|---|
| `config.js` | Every tunable parameter lives here — risk %, ATR multipliers, AI mode, session hours, ADX/volume thresholds |
| `index.js` | The `tick()` function is the complete trading pipeline in ~250 lines |
| `icmarkets.js` | Protobuf encode/decode and the request/response matching pattern (`pendingRequests` Map) |
| `ai.js` | System/user prompt construction and the `parseSignalResponse()` fallback chain |
| `backtest-multi.js` | Multi-pair backtester with shared balance and commission simulation |
| `indicators.js` | All indicators from scratch: EMA, RSI, ATR, ADX, MACD, BBands, VWAP, rejection candle detection |
| `news.js` | Finnhub REST + WebSocket integration, economic calendar cache, high-impact news blocker |
| `formatter.js` | Terminal output formatting for signal alerts and trade results |

