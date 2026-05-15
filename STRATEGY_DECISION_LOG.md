# Strategy Decision Log — NY Asian Continuation

**Date:** 2026-05-15  
**Current focus:** Build a safer, selective multi-pair NY Asian Range Continuation system for a 50,000 KES account.

---

## Current Strategy

Primary strategy mode:

```bash
STRATEGY_MODE=ny_asian_continuation
SESSION_WINDOW_MODE=all_windows
```

Core logic:

- Define Asian range from `00:00–07:00 UTC`
- Ignore London continuation breaks for now
- Trade NY continuation only during `12:30–15:30 UTC`
- Prefer setups after `13:00 UTC`
- BUY break of Asian high
- SELL break of Asian low
- Use H1 alignment as a quality filter
- Use pending stop style entries
- Reject risk outside configured bounds
- Exit by TP, SL, time exit, or 16:00 UTC cutoff

---

## Latest Multi-Pair Backtest Result Reviewed

Reported result:

```text
FINAL: $438.30 | Trades: 99 | Win Rate: 63.6%

Per-pair summary:
EUR_USD  Trades: 28 | Win: 64.3% | PF: 1.779 | Net: +$15.61
GBP_USD  Trades: 23 | Win: 69.6% | PF: 2.359 | Net: +$18.46
AUD_USD  Trades: 18 | Win: 38.9% | PF: 0.646 | Net: -$7.54
USD_JPY  Trades: 30 | Win: 73.3% | PF: 2.645 | Net: +$26.77
```

Interpretation:

- This is the best result so far.
- `EUR_USD`, `GBP_USD`, and `USD_JPY` are profitable and worth continuing with.
- `AUD_USD` is damaging the basket and should be excluded for now.

---

## Current Pair Decision

### Keep

```text
EUR_USD
GBP_USD
USD_JPY
```

Reason:

| Pair | Verdict |
|---|---|
| `EUR_USD` | Good, PF 1.779 |
| `GBP_USD` | Very good, PF 2.359 |
| `USD_JPY` | Best, PF 2.645 |

### Drop for now

```text
AUD_USD
```

Reason:

- Win rate only 38.9%
- PF only 0.646
- Net negative
- Actively reduces portfolio quality

---

## Working Backtest Command

The current working basket is already reflected in `package.json`:

```bash
npm run backtest:ny-asian:multi
```

Equivalent raw command:

```bash
TRADING_PAIRS=EUR_USD,GBP_USD,USD_JPY STRATEGY_MODE=ny_asian_continuation SESSION_WINDOW_MODE=all_windows node backtest-multi.js
```

---

## Important Strategic Conclusion

This system is promising, but it is not yet a daily-income engine.

Current role:

> High-quality NY breakout module, not the whole trading system.

Expected behavior:

- Selective entries
- Better quality than the old EMA strategy
- Still low/moderate frequency
- Needs robustness checks before live automation

---

## Recommended Next Steps

### Step 2 — Add robustness reporting

Before changing the strategy further, add reporting for:

- Monthly P&L
- Yearly P&L
- Max drawdown
- Longest losing streak
- Per-pair drawdown
- Per-pair monthly stability
- Profit clustering checks

Goal:

> Confirm profits are not coming from one lucky period.

---

### Step 3 — Add automatic pair keep/drop recommendation

Backtester should flag pairs using rules like:

```text
KEEP if:
  trades >= 20
  netProfit > 0
  profitFactor >= 1.2
  winRate >= 50%

DROP otherwise
```

Expected current decision:

```text
KEEP: EUR_USD, GBP_USD, USD_JPY
DROP: AUD_USD
```

---

### Step 4 — Strengthen live multi-pair safety

Before auto-trading multiple pairs, live bot should enforce:

```text
active trades + pending orders <= maxTotalTrades
```

Recommended account-level limit for now:

```text
maxTotalTrades = 1
```

Reason:

- Protects 50,000 KES account
- Prevents multiple pairs arming/triggering at once
- Keeps daily risk aligned with 300 KES stop target

---

### Step 5 — Monitor mode on 3-pair basket

After live safety is improved, run monitor mode first:

```bash
TRADING_PAIRS=EUR_USD,GBP_USD,USD_JPY npm run start:ny-asian
```

Do not immediately auto-trade multi-pair.

---

### Step 6 — Add second strategy for frequency

Once NY Asian Continuation is stable, add:

```text
London Asian-range fake-break reversal
```

Reason from regime research:

- London Asian range breaks often reverse/fail
- NY Asian range breaks often continue

Potential final system:

| Module | Session | Style |
|---|---|---|
| NY Asian Continuation | NY | Breakout continuation |
| London Fake-Break Reversal | London | Reversal after failed Asian break |

---

## Current Risk Direction

For 50,000 KES account:

```text
Risk per trade: ~250 KES
Daily stop: ~300 KES
Daily target: ~300 KES
Max open trades total: 1
```

Do not increase risk yet.

---

## Things Not To Do Yet

Avoid for now:

- Do not add AI execution decisions
- Do not add many indicators just to increase complexity
- Do not add `AUD_USD` back unless future tests improve
- Do not increase risk to force daily profit
- Do not auto-trade multi-pair until global pending/active trade safety is confirmed
- Do not loosen all filters just to get more trades

---

## Resume Point

Continue from:

> Implement Step 2: robustness reporting for `trades_backtest.json` and per-pair monthly/yearly stability.

Suggested next command before coding Step 2:

```bash
npm run backtest:ny-asian:multi
```

Then inspect `trades_backtest.json` and add a robustness report generator.

