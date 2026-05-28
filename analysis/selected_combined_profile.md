# Selected Combined Research Profile

Generated: 2026-05-28T10:11:49.318Z

## Selected profile

| Field | Value |
|---|---|
| NY module | `ny_asian_continuation` current basket |
| London module | `london_asian_fake_break_reversal` Candidate B |
| London pairs | `EUR_USD,USD_JPY` |
| London window | `07:00–09:00 UTC` |
| London pair/day exclusion | `EUR_USD:Thu` |
| London brake | `LONDON_MAX_LOSSES_PER_DAY=1` |
| Live status | Monitor/demo first; no live auto-execute yet |

## Backtest/correlation result

| Metric | NY only | London only | Combined |
|---|---:|---:|---:|
| Trades | 28 | 43 | — |
| Win rate | 78.6% | 41.9% | — |
| Net | $134.09 | $60.78 | $194.87 |
| Profit factor | 2.909 | 1.232 | — |
| Expectancy | $4.79 | $1.41 | — |
| Daily-equity max DD | $25.16 | $96.91 | $76.97 |

## Combined trade-level metrics

These metrics merge NY trades and the selected London trades chronologically.

| Metric | Value |
|---|---:|
| Combined trades | 71 |
| Combined wins | 40 |
| Combined losses | 31 |
| Combined win rate | 56.3% |
| Combined gross profit | $527.29 |
| Combined gross loss | $332.42 |
| Combined net | $194.87 |
| Combined profit factor | 1.586 |
| Combined expectancy/trade | $2.74 |
| Combined max consecutive losses | 4 |
| Positive months | 8 |
| Negative months | 9 |

## London/NY relationship

| Metric | Value |
|---|---:|
| Active overlap days | 2 |
| Correlation on active overlap days | 1.000 |
| Both-loss days | 1 |
| London-loss / NY-win days | 0 |
| NY average on London losing days | $-0.46 |

## Monthly distribution of combined profits

| Month | Trades | Win rate | Net |
|---|---:|---:|---:|
| 2024-12 | 1 | 0.0% | $-11.04 |
| 2025-01 | 2 | 50.0% | $6.12 |
| 2025-02 | 5 | 100.0% | $84.12 |
| 2025-03 | 6 | 66.7% | $54.37 |
| 2025-04 | 6 | 50.0% | $-3.47 |
| 2025-05 | 8 | 37.5% | $-32.73 |
| 2025-06 | 5 | 60.0% | $-2.91 |
| 2025-07 | 8 | 75.0% | $74.23 |
| 2025-08 | 3 | 33.3% | $0.88 |
| 2025-09 | 3 | 0.0% | $-35.33 |
| 2025-10 | 5 | 40.0% | $-0.34 |
| 2025-11 | 3 | 66.7% | $14.32 |
| 2025-12 | 3 | 66.7% | $1.03 |
| 2026-01 | 7 | 85.7% | $75.23 |
| 2026-03 | 2 | 50.0% | $-5.13 |
| 2026-04 | 2 | 0.0% | $-22.67 |
| 2026-05 | 2 | 50.0% | $-1.80 |

## Decision

This is the current working combined research candidate because it produced the best selected total net while keeping drawdown materially lower than the earlier uncleaned two-pair London basket.

Continue with:

```bash
npm run research:combined:selected
npm run start:london-monitor:cleaned
```

Do **not** enable London live execution until monitor-only/demo validation has collected enough sessions.
