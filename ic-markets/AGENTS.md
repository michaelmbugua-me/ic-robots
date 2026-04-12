# AGENTS.md

## Project Overview

AI-powered forex scalping bot connecting **local Ollama LLMs** to the **IC Markets cTrader Open API** via Protobuf-over-WebSocket. Pure Node.js (ESM), zero framework, no test suite.

## Architecture

The main loop (`index.js`) runs a polling cycle every 60s:
1. **Market data** → `icmarkets.js` fetches multi-timeframe candles (M5 entry + M15 trend)
2. **Indicators** → `indicators.js` computes EMA(8/21), RSI(7), ATR(14), ADX(14), VWAP, Bollinger Bands, MACD — all from scratch, no external library
3. **Hard filters** → Short-circuit checks (ADX floor, RSI extremes, EMA alignment, falling knife, HTF trend) eliminate invalid setups before any AI call
4. **AI gatekeeper** → `ai.js` queries Ollama (or Anthropic) for structured JSON signal (`BUY`/`SELL`/`WAIT` + SL/TP/confidence)
5. **Execution** → `icmarkets.js` places market orders via Protobuf, manages trailing stop, and reconciles state on restart

Data flow: `config.js` (all tuning knobs) → `index.js` (orchestrator) → `icmarkets.js` (broker API) + `ai.js` (LLM) + `news.js` (Finnhub sentiment)

## Key Commands

```bash
npm run auth          # One-time OAuth2 token (launches localhost:3000 callback server)
npm run symbols       # Fetch real symbol IDs → paste into config.js ctraderSymbolIds
npm run download      # Download history.json for backtesting (--pair EUR_USD --days 30)
npm run start         # Monitor-only mode (no trades placed)
npm run auto          # Auto-execute EUR/USD trades
npm run backtest      # Backtest with real AI (requires Ollama running)
npm run backtest-mock # Backtest with deterministic mock signal logic (no AI needed)
npm run test-news     # Debug Finnhub connectivity and news filtering
```

Pair-specific shortcuts: `npm run gbp`, `npm run gbp-auto`, `npm run jpn`, `npm run jpn-auto`. Custom pair via `--pair GBP_USD --auto-execute`.

## Conventions & Patterns

- **ESM only** — all files use `import/export`, `"type": "module"` in package.json
- **No test framework** — validation is done via backtesting (`backtest.js`) and `debug-news.js`
- **Candle format** — standardized as `{ time, complete, volume, mid: { o, h, l, c } }` (OANDA-compatible shape) even though data comes from cTrader Protobuf
- **Pip math** — JPY pairs use `pipSize = 0.01`, all others use `0.0001`. Always check `PAIR.includes("JPY")`
- **cTrader prices** — raw integers divided by `100000` (5 decimal places). Volume is `units * 100` internally
- **Symbol IDs** — use `EUR_USD` format (underscore separator) in config; cTrader uses `EURUSD` or `EUR/USD`
- **State persistence** — `state.json` stores active trade IDs to survive crashes. `activity.log` is append-only JSONL audit trail
- **AI hallucination guards** — `processSignal()` in `index.js` force-corrects entry/SL/TP prices using ATR if AI returns illogical values
- **Config is the single source of truth** — all risk params, strategy thresholds, and API credentials flow from `config.js` (backed by `.env`)
- **Entry confirmation gate** — triggers require at least one of: rejection candle, MACD histogram turning, or above-average volume
- **Trailing stop** — once profit reaches `breakevenTriggerATR` (2.0x ATR), SL trails at `trailingStopATR` (1.5x ATR) behind price; SL only moves forward

## Critical Integration Points

- **cTrader Open API** (`icmarkets.js`): Protobuf binary over WSS port 5035. Uses `.proto` files in project root. Auth is 2-step: app auth → account auth. Heartbeat every 20s required
- **Ollama** (`ai.js`): HTTP POST to `localhost:11434/api/chat` with `format: "json"`. Response parsed with aggressive fallback: strip `<think>` tags → try JSON.parse → regex extract `{...}` → default to WAIT
- **Finnhub** (`news.js`): Dual-channel — REST for economic calendar + WebSocket for real-time headlines. News buffer stored on `global.finnhubWsClient`. Economic calendar may require premium tier
- **Backtest** (`backtest.js`): Simulates spread, slippage, and IC Markets commissions ($3/side per $100k). Reads `history.json` from `download-history.js`. `--mock` flag bypasses AI entirely with deterministic RSI+BB+MACD logic

## Files to Understand First

| File | Why |
|---|---|
| `config.js` | Every tunable parameter lives here — risk %, ATR multipliers, AI mode, session hours, ADX/volume thresholds |
| `index.js` | The `tick()` function is the complete trading pipeline in ~250 lines |
| `icmarkets.js` | Protobuf encode/decode and the request/response matching pattern (`pendingRequests` Map) |
| `ai.js` | System/user prompt construction and the `parseSignalResponse()` fallback chain |
| `indicators.js` | All indicators from scratch: EMA, RSI, ATR, ADX, MACD, BBands, VWAP, rejection candle detection |

