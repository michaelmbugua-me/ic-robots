# Selected Combined Research Profile

Generated: 2026-06-30T13:17:54.177Z

## Selected profile

| Field | Value |
|---|---|
| NY module | `ny_asian_continuation` current basket |
| London module | `london_asian_fake_break_reversal` Candidate B |
| London pairs | `EUR_USD,USD_JPY` |
| London window | `07:00–09:00 UTC` |
| London brake | `LONDON_MAX_LOSSES_PER_DAY=1` |
| Live status | Monitor/demo first; no live auto-execute yet |

## Backtest result

| Metric | NY only | London only | Combined |
|---|---:|---:|---:|
| Pairs | `EUR_USD,GBP_USD,USD_JPY` | `EUR_USD,USD_JPY` | `EUR_USD,GBP_USD,USD_JPY` |
| Trades | 104 | 40 | 144 |
| Win rate | 70.2% | 60.0% | 67.4% |
| Net | $1322.50 | $463.42 | $2097.46 |
| Profit factor | 2.538 | 2.446 | 2.557 |
| Expectancy | $12.72 | $11.59 | $14.57 |
| Trade-level max DD | $114.09 | $75.84 | $116.36 |

## Trade-count increase ranking

| Candidate | Added trades vs NY | Trade increase | Added net vs NY | Verdict |
|---|---:|---:|---:|---|
| Selected London module | +40 | 38.5% | $774.96 | PASS — robust enough for monitor/demo validation |

Allowed-pair leakage check: **PASS — combined London trades only appear on selected London pairs**.

## Robustness ranking

| Profile | Trades | Net | PF | Max DD | Max losses | Positive months | Worst month | Positive years | Worst year |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| NY only | 104 | $1322.50 | 2.538 | $114.09 | 2 | 32/45 (71.1%) | 2022-04 $-49.52 | 5/5 (100.0%) | 2022 $50.66 |
| London selected | 40 | $463.42 | 2.446 | $75.84 | 3 | 19/29 (65.5%) | 2022-07 $-32.85 | 5/5 (100.0%) | 2024 $11.71 |
| Combined | 144 | $2097.46 | 2.557 | $116.36 | 5 | 31/48 (64.6%) | 2025-09 $-57.51 | 5/5 (100.0%) | 2022 $73.29 |

Robustness checks:

| Check | Result |
|---|---|
| Added trades and net are positive | PASS |
| Drawdown expansion vs NY is acceptable | PASS ($2.27) |
| Loss-streak expansion vs NY is acceptable | PASS (+3) |
| Combined positive-month rate >= 55% | PASS (64.6%) |
| London allowed-pair leakage absent | PASS |
| Overall | **PASS — robust enough for monitor/demo validation** |

## Combined trade-level metrics

These metrics come from the direct `combined_ny_london` backtest, not from manually merging separate result files.

| Metric | Value |
|---|---:|
| Combined trades | 144 |
| Combined wins | 97 |
| Combined losses | 47 |
| Combined win rate | 67.4% |
| Combined gross profit | $3444.46 |
| Combined gross loss | $1347.00 |
| Combined net | $2097.46 |
| Combined profit factor | 2.557 |
| Combined expectancy/trade | $14.57 |
| Combined max consecutive losses | 5 |
| Positive months | 31 |
| Negative months | 17 |

## Combined module breakdown

| Pair | Module | Trades | Win rate | Net | PF | Expectancy |
|---|---|---:|---:|---:|---:|---:|
| EUR_USD | `london_asian_fake_break_reversal` | 29 | 62.1% | $509.92 | 3.201 | $17.58 |
| USD_JPY | `london_asian_fake_break_reversal` | 11 | 54.5% | $88.47 | 1.527 | $8.04 |
| EUR_USD | `ny_asian_continuation` | 36 | 66.7% | $394.45 | 2.188 | $10.96 |
| GBP_USD | `ny_asian_continuation` | 30 | 73.3% | $502.29 | 2.719 | $16.74 |
| USD_JPY | `ny_asian_continuation` | 38 | 71.1% | $602.33 | 2.863 | $15.85 |

## Monthly distribution of combined profits

| Month | Trades | Win rate | Net |
|---|---:|---:|---:|
| 2022-03 | 1 | 0.0% | $-29.51 |
| 2022-04 | 4 | 25.0% | $-49.52 |
| 2022-05 | 4 | 75.0% | $64.82 |
| 2022-06 | 4 | 50.0% | $-10.72 |
| 2022-07 | 3 | 0.0% | $-38.56 |
| 2022-08 | 7 | 42.9% | $-11.86 |
| 2022-09 | 3 | 66.7% | $39.27 |
| 2022-10 | 3 | 100.0% | $42.32 |
| 2022-12 | 7 | 57.1% | $67.06 |
| 2023-01 | 3 | 100.0% | $81.59 |
| 2023-02 | 4 | 50.0% | $-6.27 |
| 2023-03 | 7 | 71.4% | $77.28 |
| 2023-04 | 6 | 83.3% | $176.08 |
| 2023-05 | 8 | 75.0% | $161.24 |
| 2023-06 | 1 | 100.0% | $42.44 |
| 2023-07 | 1 | 100.0% | $34.08 |
| 2023-08 | 3 | 33.3% | $-0.80 |
| 2023-09 | 2 | 0.0% | $-50.36 |
| 2023-10 | 2 | 50.0% | $-19.61 |
| 2023-11 | 5 | 100.0% | $157.57 |
| 2023-12 | 2 | 100.0% | $95.65 |
| 2024-01 | 2 | 50.0% | $-24.26 |
| 2024-02 | 3 | 33.3% | $-19.29 |
| 2024-04 | 1 | 100.0% | $21.34 |
| 2024-05 | 3 | 100.0% | $79.65 |
| 2024-06 | 1 | 100.0% | $37.36 |
| 2024-07 | 2 | 50.0% | $-5.24 |
| 2024-08 | 3 | 100.0% | $115.69 |
| 2024-09 | 1 | 100.0% | $30.97 |
| 2024-10 | 1 | 100.0% | $7.77 |
| 2024-11 | 2 | 100.0% | $84.15 |
| 2024-12 | 3 | 33.3% | $-11.43 |
| 2025-01 | 1 | 100.0% | $35.66 |
| 2025-02 | 4 | 100.0% | $165.40 |
| 2025-03 | 4 | 75.0% | $81.08 |
| 2025-04 | 4 | 75.0% | $82.40 |
| 2025-05 | 4 | 75.0% | $88.95 |
| 2025-06 | 2 | 100.0% | $114.75 |
| 2025-07 | 5 | 80.0% | $139.21 |
| 2025-08 | 1 | 0.0% | $-45.84 |
| 2025-09 | 1 | 0.0% | $-57.51 |
| 2025-10 | 4 | 50.0% | $11.98 |
| 2025-11 | 2 | 100.0% | $81.79 |
| 2025-12 | 1 | 100.0% | $44.43 |
| 2026-01 | 4 | 100.0% | $257.79 |
| 2026-03 | 2 | 50.0% | $-10.54 |
| 2026-04 | 1 | 0.0% | $-47.51 |
| 2026-05 | 2 | 50.0% | $16.54 |

## Decision

This is the current working combined research candidate only if the added-trade row remains positive and the leakage check passes after future data refreshes.

Continue with:

```bash
npm run research:combined:selected
npm run start:london
```

Do **not** enable London live execution until monitor-only/demo validation has collected enough sessions.
