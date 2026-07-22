---
sessionId: session-260722-090848-tzbi
---

# Requirements

### Overview & Goals
The goal is to perform a high-fidelity backtest for Gold (XAU_USD) using tick data from January 2020. This will use the newly implemented SQLite tick-cache system to ensure maximum accuracy in resolving SL/TP outcomes within 5-minute candles.

### Scope
- **Pair**: XAU_USD
- **Period**: 2020-01-01 to 2020-02-01 (Inclusive start, exclusive end)
- **Data Source**: cTrader Historical Ticks (BID/ASK)
- **Storage**: SQLite Database (`data/ticks.sqlite`)
- **Strategy**: NY Asian Continuation (as defined in the `gold` preset)

### Approach
1. **Automated Orchestration**: Use the `backtest:accurate` script which combines downloading, validation, and backtesting into a single workflow.
2. **Tick Accuracy**: Enable `BACKTEST_INTRABAR_MODE=tick` to avoid the "conservative" M5 assumptions that led to discrepancies in previous live vs. backtest comparisons.
3. **Strict Validation**: Ensure tick data is complete and matches historical OHLC before proceeding with the backtest.

# Technical Design

### Current Implementation
- **SQLite Support**: `better-sqlite3` is confirmed to be working.
- **Tick Downloader**: `download-ticks.js` is capable of fetching historical ticks and storing them in a daily-chunked SQLite database.
- **Backtester**: `backtest-multi.js` is updated to query SQLite for ticks during intrabar replay.
- **Orchestrator**: `accurate-backtest.js` handles the sequence of operations.

### Proposed Workflow
- **Command**: `npm run backtest:accurate -- --preset gold --from 2020-01-01 --to 2020-02-01 --report`
- **Download Path**: IC Markets API -> `download-ticks.js` -> `data/ticks.sqlite`
- **Validation Path**: `validate-tick-cache.js` compares SQLite ticks vs. `history_XAU_USD.json`.
- **Backtest Path**: `backtest-multi.js` (Strict Tick Mode) -> `trades_backtest.json`.
- **Reporting Path**: `generate-report.js` -> `report.html`.

### Recommendations for Large Data
- **Memory**: The system loads one day of ticks at a time into memory (or queries range-based from SQLite), making it safe for multi-year runs.
- **Reliability**: If the download is interrupted, re-running the same command will resume from where it left off (merging existing coverage).
- **Concurrency**: Avoid running multiple downloaders for the same pair simultaneously to prevent rate limits.

# Delivery Steps

### ✓ Step 1: Run Accurate Backtest for Jan 2020
Run the accurate backtest command for the specified period.
- Execute `npm run backtest:accurate -- --preset gold --from 2020-01-01 --to 2020-02-01 --report`.
- This will automatically trigger `download-ticks.js` to fetch and store 2020-01 ticks in SQLite.
- The script will then validate the tick coverage against local M5 history.
- Finally, it will run the tick-accurate backtest for Gold.

### ✓ Step 2: Verify Results and Report
Analyze the results and generated report.
- Verify the console output for tick coverage and validation metrics (aiming for 0 mismatched OHLC).
- Open `report.html` to inspect the performance metrics, drawdown, and trade logs.
- Compare the tick-accurate results with previous M5-only runs (if any) to see the impact of intrabar precision.

### * Step 3: Run Accurate Backtest for 2026
Download tick data and perform a comprehensive backtest for Gold for the current year.
- Execute `npm run backtest:accurate -- --preset gold --from 2026-01-01 --to 2026-07-23 --report`.
- This will build the 2026 tick cache in SQLite and run the strategy.
- Analyze the performance of the Gold strategy across the different market regimes of 2026.

###   Step 4: Verify 2026 Results
Analyze the generated report for 2026.
- Check for any significant drawdown periods or performance shifts.
- Verify that the tick-accurate resolution handles high-volatility events throughout the year.
- Compare the 2026 performance to the 2020 benchmark.