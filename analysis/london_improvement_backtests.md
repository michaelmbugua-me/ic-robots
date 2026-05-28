# London Improvement Backtests

Generated: 2026-05-28T10:37:35.863Z

## Assumptions

- NY is run at full current risk.
- London is combined at 25% of current risk by scaling London trade P/L.
- London base profile: Candidate B, EUR_USD + USD_JPY, 07:00–09:00 UTC, EUR_USD:Thu excluded, max 1 London loss/day.
- Asian range filter uses 15–60 pips for this first pass.

## Combined results

| Variant | Trades | Win rate | Net | PF | Exp/trade | Daily DD | Max daily loss | Active-day Sharpe |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| NY only | 88 | 73.9% | $359.54 | 2.363 | $4.09 | $25.23 | $-11.98 | 0.440 |
| NY + London 25% | 204 | 57.8% | $426.17 | 2.002 | $2.09 | $27.57 | $-14.28 | 0.301 |
| NY + London 25% + no Thursday | 181 | 59.7% | $420.46 | 2.073 | $2.32 | $25.12 | $-14.28 | 0.323 |
| NY + London 25% + Wednesday only | 136 | 66.2% | $412.97 | 2.287 | $3.04 | $27.82 | $-14.07 | 0.386 |
| NY + London 25% + trend no-fade filter | 143 | 63.6% | $386.09 | 2.136 | $2.70 | $26.08 | $-13.73 | 0.346 |
| NY + London 25% + Asian range filter | 165 | 62.4% | $408.12 | 2.132 | $2.47 | $25.12 | $-14.07 | 0.336 |
| NY + London 25% + reclaim-inside-range confirmation | 182 | 61.5% | $421.40 | 2.100 | $2.32 | $29.41 | $-13.73 | 0.323 |

## London-only contribution at 25% risk

| Variant | Trades | Win rate | Net | PF | Daily DD |
|---|---:|---:|---:|---:|---:|
| London 25% | 116 | 45.7% | $66.63 | 1.412 | $24.23 |
| London 25% + no Thursday | 93 | 46.2% | $60.92 | 1.476 | $16.78 |
| London 25% + Wednesday only | 48 | 52.1% | $53.44 | 1.937 | $13.70 |
| London 25% + trend no-fade filter | 55 | 47.3% | $26.56 | 1.350 | $16.72 |
| London 25% + Asian range filter | 77 | 49.4% | $48.59 | 1.502 | $10.79 |
| London 25% + reclaim-inside-range confirmation | 94 | 50.0% | $61.86 | 1.518 | $18.53 |

## Notes

- **NY only**: Benchmark; no London trades included.
- **NY + London 25%**: Current cleaned London profile, scaled to 25% risk in the combined portfolio.
- **NY + London 25% + no Thursday**: Excludes all Thursday London trades, not only EUR_USD Thursday.
- **NY + London 25% + Wednesday only**: Keeps only Wednesday London setups.
- **NY + London 25% + trend no-fade filter**: Blocks fake-break reversals when the Asian-range break is aligned with H1 trend.
- **NY + London 25% + Asian range filter**: Initial range-quality filter: Asian range must be between 15 and 60 pips unless overridden by env.
- **NY + London 25% + reclaim-inside-range confirmation**: Requires the reclaim close to occur after the break candle; same-candle fake breaks are ignored.
