# London Asian Fake-Break Reversal — Implementation Plan

**Date:** 2026-05-21  
**Goal:** Add a second, independent strategy module for frequency without weakening the existing `ny_asian_continuation` module.

---

## Strategic thesis

Current system behavior:

| Module | Session | Style | Status |
|---|---|---|---|
| `ny_asian_continuation` | NY overlap | Asian-range breakout continuation | Existing primary module |
| `london_asian_fake_break_reversal` | London open | Failed Asian-range break reversal | Proposed second module |

Research premise:

- London Asian-range breaks often fail or mean-revert.
- NY Asian-range breaks more often continue.
- Frequency should come from a separate market-behavior module, not by loosening NY continuation filters.

---

## Non-negotiable constraints

1. Do not change live execution first.
2. Do not loosen the existing NY strategy to create more trades.
3. Treat London reversal as an independent module with its own config, tests, and backtest results.
4. Keep risk conservative until London-only and combined tests prove robustness.
5. Preserve monitor-only validation before auto-execute support.

---

## Phase 1 — Research-only validation

**Purpose:** Quantify whether London Asian-range fake-break reversals have enough evidence to justify implementation.

### Work items

- Extend `market-regime-analysis.js` to isolate London fake-break events.
- Measure first one-sided London break of the Asian range.
- Measure confirmation styles:
  - same-candle close back inside the Asian range,
  - close back inside within N M5 bars.
- Measure reversal quality after confirmation:
  - average net pips after 60 minutes,
  - MFE/MAE after 60 minutes,
  - midpoint-target vs stop simulation,
  - direction split,
  - H1 trend/alignment split,
  - weekday split.
- Add a package script for the research run.

### Acceptance criteria

Phase 1 is complete when the project can run a command like:

```bash
npm run research:london-fake-break -- --pair EUR_USD --file history_EUR_USD.json
```

and print London fake-break candidate and reversal statistics without changing live bot behavior.

---

## Phase 2 — Pure signal generator

**Purpose:** Add strategy logic as a deterministic pure function, with no live execution changes.

### Candidate function

```text
generateLondonAsianFakeBreakReversalSignal(candles, opts)
```

### Initial logic

SELL reversal:

1. Build Asian range from `00:00–07:00 UTC`.
2. During London window `07:00–10:00 UTC`, price breaks above Asian high by at least `minBreakPips`.
3. Price closes back below Asian high within the confirmation window.
4. Entry is a confirmation stop/market-style level.
5. SL is above fake-break high plus buffer.
6. TP is Asian midpoint, Asian opposite side, or configured RR target.

BUY reversal mirrors this below Asian low.

### Tests

Add synthetic candle tests for:

- missing Asian range,
- outside London window,
- break too small,
- break continuation with no close back inside,
- valid SELL fake-break,
- valid BUY fake-break,
- min/max risk filters,
- JPY pip handling.

---

## Phase 3 — London-only backtest

**Purpose:** Test the London module alone before combining it with NY.

### Work items

- Add `STRATEGY_MODE=london_asian_fake_break_reversal` support in config/backtest only.
- Update `backtest-multi.js` to route London mode to the new signal generator.
- Preserve strategy name on trade records.
- Add package script:

```bash
npm run backtest:london-fake-break
```

### Acceptance metrics

Indicative thresholds before continuing:

| Metric | Target |
|---|---:|
| Trades | Enough sample size; ideally 50+ per evaluated basket |
| Profit factor | >= 1.2 minimum, >= 1.4 preferred |
| Pair stability | At least 2 of core pairs viable |
| Drawdown | Not materially worse than NY module |
| Monthly clustering | Not dependent on one lucky month |

---

## Phase 4 — Combined backtest

**Purpose:** Verify London improves the total system, not just trade count.

### Work items

- Support multiple enabled strategy modules by session.
- Compare:
  - NY only,
  - London only,
  - NY + London.
- Ensure daily risk gates do not allow London losses to degrade NY participation excessively.

### Acceptance criteria

Combined mode should improve at least one of:

- total expectancy,
- trade frequency with similar profit factor,
- equity curve smoothness,
- drawdown-adjusted return.

It should not materially worsen:

- max drawdown,
- daily stop hits,
- pair-level stability,
- live execution complexity.

---

## Phase 5 — Monitor-only live integration

**Purpose:** Observe live London fake-break signals without placing orders.

### Work items

- Add live signal routing by session:
  - London window → London fake-break module.
  - NY window → NY Asian continuation module.
- Log strategy-specific reasons.
- Persist strategy name in pending/active trade metadata.
- Run monitor-only for multiple London sessions.

### Acceptance criteria

- Logs match expected strategy behavior.
- No unexpected London signals outside configured window.
- No conflict with NY signal generation.
- No live order placement yet.

---

## Phase 6 — Controlled auto-execute rollout

**Purpose:** Enable London module with conservative risk only after research, tests, and monitor logs validate behavior.

### Initial live constraints

- `CTRADER_ENV=demo` first.
- `MAX_TOTAL_TRADES=1` initially.
- `MAX_TRADES_PER_PAIR=1`.
- Conservative max spread gate.
- Conservative risk percent.
- Broker stop orders preferred if entry style is stop-based.

### Rollout sequence

1. Demo monitor-only.
2. Demo auto-execute with one pair.
3. Demo auto-execute with approved basket.
4. Review fills, slippage, rejects, and state reconciliation.
5. Only then consider live account deployment.

---

## Current start point

Begin with **Phase 1 — Research-only validation**.

---

## Phase 1 status notes

Started on 2026-05-21.

Implemented research-only London fake-break tables in `market-regime-analysis.js` and added:

```bash
npm run research:london-fake-break
npm run research:london-fake-break:sweep
```

Initial local-history read using `--cost-pips 0.7`:

| Pair | Confirmed fake-break reversals | Avg net after lookahead | Win rate | Initial read |
|---|---:|---:|---:|---|
| `EUR_USD` | 833 | -0.38p | 50.8% | Not enough raw edge yet; investigate filters. |
| `GBP_USD` | 922 | -0.34p | 49.7% | Similar to EUR; midpoint model near flat. |
| `USD_JPY` | 588 | +0.09p | 50.5% | Slightly better raw read; downside breaks looked stronger. |
| `AUD_USD` | 245 | -0.16p | 46.9% | Weak basket candidate for now. |

Early interpretation:

- London fake-breaks are frequent enough to study.
- Raw reversal after a simple close-back-inside confirmation is not yet strong enough to implement as a live strategy.
- Next Phase 1 research should test stricter filters before Phase 2 signal implementation, especially:
  - direction-specific filters,
  - weekday filters,
  - H1 trend/alignment filters,
  - minimum/maximum risk filters,
  - alternative exits beyond simple 60-minute close or Asian-midpoint target.

Filter-sweep mode now compares combinations of:

- minimum break pips,
- confirmation bars,
- risk bands,
- weekday filters,
- H1 relationship filters,
- break direction,
- target model.

Supported target models:

| Target model | Meaning |
|---|---|
| `time_exit` | Exit after configured lookahead bars. |
| `asian_midpoint` | TP at Asian range midpoint, SL at fake-break extreme plus buffer. |
| `rr_1_0` | Fixed 1.0R target. |
| `rr_1_2` | Fixed 1.2R target. |
| `asian_opposite` | TP at opposite side of Asian range. |

Example command:

```bash
npm run research:london-fake-break:sweep -- \
  --pair EUR_USD \
  --file history_EUR_USD.json \
  --cost-pips 0.7 \
  --min-obs 80 \
  --sweep-top 20
```

Initial sweep read on `EUR_USD`:

- The best broad rows were mostly `time_exit`, Wednesday or Tue/Wed/Thu filters, and 5–10 or 6–12 pip risk bands.
- Non-time target models produced some positive rows, especially `asian_opposite` and `rr_1_0`/`rr_1_2`, but sample sizes and weekday concentration need caution.
- This is still research-only; no Phase 2 signal should be implemented until the same sweep is reviewed across `GBP_USD` and `USD_JPY` and checked for robustness/clustering.

Cross-pair comparison command:

```bash
npm run research:london-fake-break:compare -- \
  --pairs EUR_USD,GBP_USD,USD_JPY \
  --cost-pips 0.7 \
  --min-obs 80 \
  --top 15
```

Cross-pair result:

- Common filter sets across all three pairs: `2980`.
- Robust positive filter sets where every pair had `avgNet > 0` and `PF > 1`: `143`.

Best broad robust row found:

| Parameter | Value |
|---|---|
| Minimum break | `2` pips |
| Confirmation | close back inside within `3` M5 bars |
| Risk band | `5-10` pips |
| Weekdays | `TueWedThu` |
| H1 relationship | `reversal_with_h1` / equivalent `break_counter_h1` |
| Direction | both up and down breaks |
| Target | `time_exit` after lookahead |
| Total sample | `378` trades across `EUR_USD`, `GBP_USD`, `USD_JPY` |
| Minimum pair avg net | `+0.88p` |
| Average net | `+0.94p` |
| Minimum pair PF | `1.18` |
| Average win rate | `53.7%` |

Pair split for that row:

| Pair | Avg net | PF | n |
|---|---:|---:|---:|
| `EUR_USD` | `+0.88p` | `1.21` | `136` |
| `GBP_USD` | `+1.00p` | `1.18` | `157` |
| `USD_JPY` | `+0.92p` | `1.18` | `85` |

Non-time target comparison command:

```bash
npm run research:london-fake-break:compare -- \
  --pairs EUR_USD,GBP_USD,USD_JPY \
  --cost-pips 0.7 \
  --min-obs 80 \
  --top 10 \
  --sweep-targets asian_midpoint,rr_1_0,rr_1_2,asian_opposite
```

Non-time target result:

- Robust positive non-time target rows: `55`.
- Best robust non-time model was `asian_opposite`:
  - min break `4` pips,
  - confirm within `2` bars,
  - risk `5-10` pips,
  - weekdays `TueWedThu`,
  - all H1 states,
  - all break directions,
  - total sample `563`,
  - minimum pair avg net `+0.58p`,
  - average net `+0.94p`,
  - minimum pair PF `1.12`.

Phase 1 conclusion before Phase 2:

- The London fake-break idea has at least two cross-pair robust research candidates.
- The strongest broad candidate is time-exit based and H1 counter-break/reversal-aligned.
- The strongest non-time candidate targets the opposite side of the Asian range and is simpler to convert into bracket-order backtesting.
- Before implementing live/production behavior, Phase 2 should start with a pure signal generator for both candidate profiles behind config flags, then Phase 3 should backtest them separately.

---

## Phase 2 status notes

Started on 2026-05-21 with Candidate B only.

Implemented pure signal generator in `indicators.js`:

```text
generateLondonAsianFakeBreakReversalSignal(candles, opts)
```

Candidate B defaults encoded in the pure generator:

| Parameter | Default |
|---|---|
| Session | London `07:00–10:00 UTC` |
| Weekdays | `Tue`, `Wed`, `Thu` |
| Minimum Asian-range break | `4` pips |
| Confirmation | close back inside within `2` M5 bars |
| Risk band | `5–10` pips |
| Stop | fake-break extreme plus `0.5` pip buffer |
| Target | opposite side of Asian range |
| Signal style | market-style `buy` / `sell` on confirmation close |

No live routing, config mode, or backtest execution has been changed yet.

Tests added:

```text
tests/indicators-london-fake-break.test.js
```

Covered cases:

- valid SELL fake-break above Asian high,
- valid BUY fake-break below Asian low,
- weekday blocker,
- break too small,
- no close-back-inside confirmation,
- risk too large,
- JPY pip sizing.

Validation:

```bash
npm test
```

Result:

```text
London fake-break indicator tests passed
risk-manager tests passed
package sanity tests passed
```

Next step is Phase 3: wire this generator into `backtest-multi.js` behind `STRATEGY_MODE=london_asian_fake_break_reversal`, run London-only backtests, and compare Candidate B against the Phase 1 research profile.

---

## Phase 3 status notes

Started on 2026-05-21 with London-only backtest wiring.

Implemented:

- Added `london_asian_fake_break_reversal` to `config.strategy.supportedModes`.
- Added `config.strategy.londonAsianFakeBreakReversal` Candidate B defaults.
- Routed `backtest-multi.js` to `generateLondonAsianFakeBreakReversalSignal()` when:

```bash
STRATEGY_MODE=london_asian_fake_break_reversal
```

- Added package scripts:

```bash
npm run backtest:london-fake-break
npm run backtest:london-fake-break:multi
```

- Added live safety guard in `index.js`: this mode is research/backtest-only and returns no live signal until later monitor/live phases intentionally wire it.

First London-only multi-pair backtest command:

```bash
npm run backtest:london-fake-break:multi
```

First result:

```text
FINAL: $2017.54 | Trades: 561 | Win Rate: 39.4%

Per-pair summary:
EUR_USD  Trades: 215 | Win: 42.8% | PF: 1.037 | Net: +$44.71
GBP_USD  Trades: 234 | Win: 35.0% | PF: 0.951 | Net: -$77.92
USD_JPY  Trades: 112 | Win: 42.0% | PF: 1.179 | Net: +$112.76
```

Interpretation:

- Candidate B now runs end-to-end in the full backtester.
- The full backtest is weaker than the research sweep suggested after realistic costs, position sizing, commissions, time-exit behavior, daily gates, and multi-pair interaction.
- `USD_JPY` is promising, `EUR_USD` is barely positive, and `GBP_USD` is currently damaging the basket.
- Do **not** proceed to live/monitor integration from this result.

Recommended next Phase 3 work:

1. Run pair-specific London backtests and compare against the sweep rows.
2. Test `TRADING_PAIRS=USD_JPY` and `TRADING_PAIRS=EUR_USD,USD_JPY` baskets.
3. Add/backtest Candidate A time-exit profile because it was the strongest cross-pair research row.
4. Consider stronger pair filters before any Phase 4 combined NY+London testing.

Candidate A/B comparison completed:

| Test | Command | Trades | Win rate | Result |
|---|---|---:|---:|---:|
| Candidate B, `USD_JPY` only | `npm run backtest:london-fake-break:usdjpy` | 113 | 42.5% | `+$153.42`, PF `1.244` |
| Candidate B, `EUR_USD,USD_JPY` | `npm run backtest:london-fake-break:eurusd-usdjpy` | 328 | 42.7% | final `$2136.12`; `EUR_USD +$44.71` PF `1.037`, `USD_JPY +$153.42` PF `1.244` |
| Candidate A, `USD_JPY` only | `npm run backtest:london-fake-break:a:usdjpy` | 82 | 42.7% | `+$1.92`, PF `1.004` |
| Candidate A, `EUR_USD,USD_JPY` | `npm run backtest:london-fake-break:a:eurusd-usdjpy` | 215 | 36.7% | final `$1710.88`; `EUR_USD -$229.03` PF `0.744`, `USD_JPY +$1.92` PF `1.004` |
| Candidate A, 3-pair cross-check | `npm run backtest:london-fake-break:a:multi` | 374 | 37.4% | final `$1789.85`; `EUR_USD -$229.03`, `GBP_USD +$78.97`, `USD_JPY +$1.92` |

Phase 3 comparison conclusion:

- Candidate A was strongest in the research sweep but does **not** survive the full backtest well.
- Candidate B remains the better practical London profile.
- Best London-only approach so far: `USD_JPY` only.
- Best broader London basket so far: `EUR_USD,USD_JPY` with Candidate B.
- Avoid Candidate A for now unless its time-exit model is redesigned.
- Avoid adding `GBP_USD` to Candidate B basket for now because it damaged the 3-pair result.

Updated recommendation before Phase 4:

1. Keep Candidate B as the working London profile.
2. Treat `USD_JPY` as the primary London pair.
3. Treat `EUR_USD` as optional/secondary because PF is only barely above 1.
4. Do not proceed to live integration yet.
5. Next useful test is combined backtest comparison:
   - NY-only current basket,
   - London Candidate B `USD_JPY` only,
   - London Candidate B `EUR_USD,USD_JPY`,
   - NY + London with strict account-level trade caps.

---

## Profitability analysis before next phase

Current best London setup remains Candidate B:

```text
LONDON_FAKE_BREAK_PROFILE=candidate_b
LONDON_FAKE_BREAK_TARGET_MODE=asian_opposite
LONDON_FAKE_BREAK_MIN_BREAK_PIPS=4
LONDON_FAKE_BREAK_CONFIRM_BARS=2
LONDON_FAKE_BREAK_MIN_RISK_PIPS=5
LONDON_FAKE_BREAK_MAX_RISK_PIPS=10
LONDON_FAKE_BREAK_ALLOWED_WEEKDAYS=Tue,Wed,Thu
```

Focused variant analysis command:

```bash
npm run research:london-fake-break:variants
```

Variant results:

| Case | Trades | Win rate | Net | Key read |
|---|---:|---:|---:|---|
| `USDJPY_B_default` | 113 | 42.5% | `+$153.42` | Best single-pair London result. |
| `USDJPY_B_time_exit` | 113 | 42.5% | `+$120.69` | Worse than keeping the far opposite-range TP. |
| `USDJPY_B_h1_reversal_time` | 51 | 43.1% | `+$12.73` | H1 reversal filter removes too much edge. |
| `USDJPY_B_min5_risk6_12_time` | 98 | 43.9% | `+$65.24` | Tighter research-style filter underperforms default. |
| `USDJPY_B_all_weekdays_time` | 183 | 38.8% | `+$62.69` | More trades, worse quality. Keep Tue/Wed/Thu. |
| `EU_UJ_B_default` | 328 | 42.7% | `+$198.13` | Best total net but includes weak EUR/USD. |
| `EU_UJ_B_time_exit` | 328 | 42.7% | `+$163.05` | Worse than default. |
| `EU_UJ_B_h1_reversal_time` | 140 | 40.7% | `-$108.32` | Bad. |
| `EU_UJ_B_min5_risk6_12_time` | 267 | 44.2% | `+$60.75` | Too restrictive / less profitable. |

Robustness check on best two-pair London setup:

```bash
npm run backtest:london-fake-break:eurusd-usdjpy
node trade-analyzer.js
```

Result summary:

```text
Total net PnL: +$198.13
Max drawdown: $190.63 (9.8%)
Longest losing streak: 8 trades (-$87.30)
Profitable days: 133
Losing days: 173
Green day ratio: 43.5%
Best month share: 6.6%
Top 3 months share: 18.2%
```

Pair robustness:

| Pair | Trades | PF | Net | Max DD | Green months | Read |
|---|---:|---:|---:|---:|---:|---|
| `EUR_USD` | 215 | 1.04 | `+$44.71` | `$138.28` | 51.1% | Barely positive; low expectancy. |
| `USD_JPY` | 113 | 1.24 | `+$153.42` | `$88.89` | 40.6% | Main source of London edge. |

Important observations:

- Candidate B is profitable, but the edge is thin.
- `USD_JPY` carries the London module.
- `EUR_USD` adds net profit but also materially increases drawdown and low-quality trade count.
- `GBP_USD` should stay excluded from London Candidate B.
- Pure time-exit variants are not better in the full backtester, even though the research sweep liked time exits.
- Adding all weekdays increases frequency but degrades quality.
- H1 reversal filtering is harmful in the full backtester.

Practical path to make the strategy more profitable:

1. Keep Candidate B default as the baseline.
2. Prefer `USD_JPY` only if prioritizing quality/PF/drawdown.
3. Use `EUR_USD,USD_JPY` only if prioritizing higher total net and accepting weaker robustness.
4. Do not add `GBP_USD` to London Candidate B.
5. Before next phase, the most promising improvement is not another H1/time-exit filter; it is adding a portfolio-level combined backtest to confirm whether London `USD_JPY` improves the existing NY module without consuming risk budget before NY setups.

---

## London-vs-NY correlation and module-brake analysis

Implemented repeatable day-level comparison:

```bash
npm run research:london-ny:correlation
```

This runs and saves:

```text
analysis/ny_current.json
analysis/london_usdjpy.json
analysis/london_eurusd_usdjpy.json
analysis/london_ny_correlation.json
```

NY baseline in this comparison:

```text
TRADING_PAIRS=EUR_USD,GBP_USD,USD_JPY
STRATEGY_MODE=ny_asian_continuation
SESSION_WINDOW_MODE=all_windows
```

NY-only result:

| Metric | Value |
|---|---:|
| Trades | 178 |
| Win rate | 69.7% |
| Net | `+$560.70` |
| PF | `1.906` |
| Max daily-equity DD | `$49.49` |

### London `USD_JPY` + NY

| Metric | Value |
|---|---:|
| London trades | 113 |
| London net | `+$153.42` |
| Combined net | `+$714.12` |
| Combined daily-equity DD | `$69.94` |
| Active overlap days | 7 |
| Overlap correlation | `0.326` |
| Both-loss days | 3 |
| Avg NY PnL on London losing days | `-$0.22` |

Read:

- London `USD_JPY` adds net profit to NY.
- It increases drawdown vs NY-only but not catastrophically.
- There are very few overlapping active days, so it is mostly an additive frequency module.
- Brakes do not change `USD_JPY` much because there is usually only one London trade per active day.

### London `EUR_USD,USD_JPY` + NY

No London brake:

| Metric | Value |
|---|---:|
| London trades | 328 |
| London net | `+$198.13` |
| Combined net | `+$758.84` |
| Combined daily-equity DD | `$172.28` |
| Active overlap days | 24 |
| Overlap correlation | `0.317` |
| Both-loss days | 5 |
| Avg NY PnL on London losing days | `+$0.30` |

With `max_1_loss` London brake:

| Metric | Value |
|---|---:|
| London trades | 312 |
| London net | `+$252.44` |
| Combined net | `+$813.15` |
| Combined daily-equity DD | `$149.45` |

With `$10` max London daily loss brake:

| Metric | Value |
|---|---:|
| London trades | 314 |
| London net | `+$250.71` |
| Combined net | `+$811.41` |
| Combined daily-equity DD | `$160.33` |

Read:

- The two-pair London module adds more total net than `USD_JPY` alone.
- Its raw drawdown is too high without a module brake.
- A simple `max_1_loss` brake improved London net and reduced combined drawdown.
- London losing days are not obviously followed by bad NY days; NY average PnL on London losing days was slightly positive in the two-pair test.

Strongest current pointer:

```text
If we include EUR_USD in London, use a London module brake.
```

Practical pre-live candidate order after correlation analysis:

1. Conservative: London `USD_JPY` only, Candidate B default.
2. More profitable but needs risk brake: London `EUR_USD,USD_JPY`, Candidate B default, stop London after first same-day London loss.
3. Do not include `GBP_USD`.

Next implementation candidate:

- Add backtest/live-compatible London module risk controls:
  - `LONDON_MAX_LOSSES_PER_DAY=1`
  - `LONDON_MAX_DAILY_LOSS_USD` or KES equivalent
  - per-module counters separate from global risk manager
- Keep disabled in live until monitor-only phase validates signal frequency and spread.

### London module brakes implemented

Implemented backtest-level London module brakes:

```bash
LONDON_MAX_LOSSES_PER_DAY=1
LONDON_MAX_DAILY_LOSS_USD=10   # optional, 0 disables
```

Convenience scripts:

```bash
npm run backtest:london-fake-break:usdjpy:braked
npm run backtest:london-fake-break:eurusd-usdjpy:braked
```

Exact comparison after implementing the brakes:

| Case | Trades | Win rate | Net | PF / Notes |
|---|---:|---:|---:|---|
| NY only current basket | 178 | 69.7% | `+$560.70` | PF `1.906`, core module remains strongest. |
| London `USD_JPY` only | 113 | 42.5% | `+$153.42` | PF `1.244`, cleanest London-only module. |
| London `EUR_USD,USD_JPY` with `LONDON_MAX_LOSSES_PER_DAY=1` | 316 | 43.0% | `+$238.42` | `EUR_USD +$48.67` PF `1.041`; `USD_JPY +$189.75` PF `1.325`. |
| NY + London `USD_JPY` | — | — | `+$714.12` combined | Combined DD `$69.94`. |
| NY + London `EUR_USD,USD_JPY` braked | — | — | `+$799.12` combined | Combined DD `$150.74`. |

Interpretation after actual brake enforcement:

- The braked `EUR_USD,USD_JPY` London basket is now the best total-net London candidate.
- It improves London-only net from `+$198.13` to `+$238.42` versus unbraked two-pair Candidate B.
- It improves combined NY+London net from `+$758.84` unbraked to `+$799.12` with actual brake enforcement.
- Drawdown is still materially higher than NY-only and higher than London `USD_JPY` only, so this is the aggressive total-net option.
- The conservative option remains London `USD_JPY` only.

Current priority if optimizing for total portfolio net:

```text
London Candidate B
Pairs: EUR_USD,USD_JPY
Brake: LONDON_MAX_LOSSES_PER_DAY=1
Live status: still backtest/research only
```

Risk-adjusted update:

- Because the two-pair London drawdown is still high, use London `USD_JPY` only as the working implementation candidate for now.
- Keep the braked `EUR_USD,USD_JPY` profile documented as the higher-net/aggressive alternative, but do not move it toward monitor/live until drawdown is improved.
- Next strong recommendation to pursue: diagnostics by pair, weekday, London hour, break direction, risk band, and exit reason.

Diagnostics command:

```bash
npm run research:london:diagnostics
```

Diagnostics pointers found:

- `09:00–10:00 UTC` is damaging:
  - `USD_JPY` only: `09:00–10:00` PF `0.64`, net `-$14.61`.
  - braked `EUR_USD,USD_JPY`: `09:00–10:00` PF `0.39`, net `-$133.96`.
- `EUR_USD` Thursday is strongly negative:
  - `EUR_USD Thu`: PF `0.56`, net `-$223.07`.
- `Wednesday` is the strongest day in the two-pair profile:
  - PF `1.68`, net `+$334.70`.
- `08:00–09:00 UTC` is the strongest hour:
  - PF `1.42`, net `+$205.67` in the braked two-pair profile.

Cleaned scripts added:

```bash
npm run backtest:london-fake-break:usdjpy:cleaned
npm run backtest:london-fake-break:eurusd-usdjpy:cleaned
```

Cleaned profile settings:

```text
LONDON_FAKE_BREAK_TRADE_END_UTC=9
LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS=EUR_USD:Thu
LONDON_MAX_LOSSES_PER_DAY=1
```

Cleaned comparison:

| Case | Trades | Win rate | Net | PF / Read |
|---|---:|---:|---:|---|
| `USD_JPY` current | 113 | 42.5% | `+$153.42` | PF `1.244` |
| `USD_JPY` cleaned, no entries after 09:00 | 104 | 44.2% | `+$168.03` | PF `1.286`, modest improvement |
| `EUR_USD,USD_JPY` braked current | 316 | 43.0% | `+$238.42` | `EUR_USD` PF `1.041`, `USD_JPY` PF `1.325` |
| `EUR_USD,USD_JPY` cleaned | 218 | 48.6% | `+$517.94` | `EUR_USD` PF `1.602`, `USD_JPY` PF `1.322` |

Updated recommendation:

- For lowest complexity/risk: London `USD_JPY` cleaned (`07:00–09:00`, Candidate B).
- For total net while controlling drawdown: cleaned `EUR_USD,USD_JPY` profile with `EUR_USD` Thursday excluded and London stopped after first same-day London loss.
- The cleaned two-pair profile is now materially better than `USD_JPY` only, but must still be validated in combined NY+London analysis before live monitor integration.

### Final combined check with cleaned London profiles

Command:

```bash
npm run research:london-ny:correlation
```

Final comparison:

| Setup | London trades | London net | Combined net | Combined DD | Read |
|---|---:|---:|---:|---:|---|
| NY only | — | — | `+$560.70` | `$49.49` | Highest quality core module. |
| NY + cleaned London `USD_JPY` | 104 | `+$168.03` | `+$728.73` | `$69.94` | Conservative add-on. |
| NY + cleaned London `EUR_USD,USD_JPY` | 218 | `+$517.94` | `+$1078.64` | `$94.30` | Best total-net option. |
| NY + cleaned London `EUR_USD,USD_JPY` plus same analysis max-1-loss simulation | 215 | `+$521.30` | `+$1082.00` | `$93.01` | Best row in final comparison. |

Final Phase 3/4 research conclusion:

- Cleaned two-pair London Candidate B is now clearly stronger than `USD_JPY` only on total portfolio net.
- The drawdown problem from the earlier two-pair version was mostly caused by `09:00–10:00 UTC` trades and `EUR_USD` Thursday trades.
- With those removed, the two-pair London profile adds substantial net while keeping combined drawdown much more reasonable.
- Current best research profile for total portfolio net:

```text
Strategy: london_asian_fake_break_reversal
Profile: candidate_b
Pairs: EUR_USD,USD_JPY
Trade window: 07:00–09:00 UTC
Excluded pair/day: EUR_USD:Thu
Brake: LONDON_MAX_LOSSES_PER_DAY=1
Live status: still disabled until monitor-only phase
```

Next recommended implementation step:

- Move to Phase 5 monitor-only live integration for this cleaned profile only, while keeping auto-execute disabled.
- Log signal reasons, pair/day filters, London brake status, and live spread at signal time.

Selected profile to work toward:

```text
Row: london_eurusd_usdjpy_cleaned + max_1_loss
London net: +$521.30
Combined net: +$1082.00
Combined DD: $93.01
Correlation overlap: 0.291
Both-loss days: 5
```

Repeatable command:

```bash
npm run research:combined:selected
```

This writes:

```text
analysis/selected_combined_profile.md
```

This profile should be tested on past data and a demo/monitor account before any live rollout.

---

## Phase 5 status notes

Implemented initial monitor-only live routing for London fake-break.

New cleaned monitor command:

```bash
npm run start:london-monitor:cleaned
```

Profile used by the command:

```text
TRADING_PAIRS=EUR_USD,USD_JPY
STRATEGY_MODE=london_asian_fake_break_reversal
SESSION_WINDOW_MODE=london_only
LONDON_MONITOR_ENABLED=true
LONDON_LIVE_EXECUTION_ENABLED=false
LONDON_FAKE_BREAK_TRADE_END_UTC=9
LONDON_FAKE_BREAK_EXCLUDED_PAIR_WEEKDAYS=EUR_USD:Thu
LONDON_MAX_LOSSES_PER_DAY=1
```

Safety behavior:

- `index.js` routes London signals only when `STRATEGY_MODE=london_asian_fake_break_reversal` and `LONDON_MONITOR_ENABLED=true`.
- London signals are marked `monitorOnly` unless `LONDON_LIVE_EXECUTION_ENABLED=true` is explicitly set.
- With monitor-only enabled, signal logs include spread snapshot and reason, then return before trade gates/order placement.
- No London orders are placed by the Phase 5 command.

Next Phase 5 validation tasks:

1. Run during London session in demo.
2. Confirm `EUR_USD` Thursday exclusion appears in logs.
3. Confirm no `09:00–10:00 UTC` London signals are accepted.
4. Confirm spread at signal time is logged.
5. Collect several London sessions before considering any live execution flag.














