# Workplan — NY Asian Continuation Strategy

## Current Setup

| Instrument | Strategy | Risk | Window | Status |
|---|---|---|---|---|
| EUR/USD | NY Asian Continuation | 1% / trade, 3:1 RR | 7–16 UTC | Live (PM2: ic-scalping-bot) |
| GBP/USD | NY Asian Continuation | 1% / trade, 3:1 RR | 7–16 UTC | Live |
| USD/JPY | NY Asian Continuation | 1% / trade, 3:1 RR | 7–16 UTC | Live |
| XAU/USD | NY Asian Continuation | 1% / trade, 3:1 RR | 7–16 UTC, wide windows | Live (PM2: ic-scalping-gold) |

### Combined Backtest (6.5 yr, corrected commissions)

| | Net | Trades | WR | PF | Annualized |
|---|---|---|---|---|---|
| FX (3 pairs) | $1,160 | 157 | 68% | 2.1 | ~15% |
| Gold | $2,720 | 249 | 53% | 2.8 | ~35% |
| **Combined** | **$3,880** | **406** | — | — | **~25%** |

Account: $1,172 (demo) | Deploy: GitHub Actions → VM (appleboy/ssh-action)

---

## Implementation Order

### Phase 1 — High Impact (Current)

| # | Item | Status | Notes |
|---|---|---|---|
| 1.1 | London Asian Fake-Break Reversal | Pending | Second uncorrelated strategy on same capital. Combine with NY continuation for smoother equity curve. |
| 1.2 | Partial Profit Taking (50% at 1:1, rest to 3:1) | Pending | Reduces loser impact, improves psychological experience. |
| 1.3 | Volatility Regime Filter (skip Gold when ATR top 20%) | Pending | Avoids worst drawdown spikes on Gold. |

### Phase 2 — Medium Impact

| # | Item | Status | Notes |
|---|---|---|---|
| 2.1 | Dynamic RR (scale with market conditions) | Pending | Tighter RR in low vol, wider in trending markets. |
| 2.2 | Swap-Aware Exit (cost of holding past 22:00 UTC) | Pending | Close early when swap is negative and trade is not deep in profit. |
| 2.3 | Add UK100 (when account grows to ~$2,500+) | Pending | Data already downloaded. Needs larger account for position sizing. |

### Phase 3 — Longer-Term

| # | Item | Status | Notes |
|---|---|---|---|
| 3.1 | Regime-Based Allocation (DXY trend, Gold/HUI ratio) | Pending | Tilt between FX and Gold allocation based on macro regime. |
| 3.2 | Scale-Up Plan (re-invest to $5k+ before withdrawals) | Pending | Currently ~$50/mo avg. Reinvesting accelerates growth. |

---

## How to Run

```bash
# FX backtest (EUR/USD, GBP/USD, USD/JPY)
npm run backtest:ny

# Gold backtest
npm run backtest:gold

# Both + reports
npm run backtest:all

# Live (PM2)
pm2 start ecosystem.config.cjs
```
