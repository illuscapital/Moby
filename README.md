# 🐋 Moby

Paper trading bot that follows unusual options flow into earnings events.

## Strategy

Moby monitors [Unusual Whales](https://unusualwhales.com) flow alerts for large, directional options bets ahead of earnings. When a signal passes all filters, Moby enters a paper position and holds through earnings.

### Entry Filters
- **Premium**: ≥ $200K
- **Volume/OI**: ≥ 5x (unusual size relative to open interest)
- **DTE**: 5–45 days to expiration
- **OTM**: 2–15% out of the money
- **Earnings**: Within 10 trading days
- **Ask-side**: ≥ 70% of premium (directional conviction)
- **Single-leg only** (no spreads/straddles)
- **Common stock only** (no indexes)

### Position Sizing
- $5,000 max per position
- 10 max open positions

### Exit Rules
- **No stop losses** — position sizing is the risk control
- Exit at first market open after earnings (BMO → same day, AMC → next day)
- Emergency exit at ≤ 1 DTE if earnings haven't occurred

## Architecture

```
strategy/
  collector.js   — Fetches UW flow alerts + screener data every 30min
  strategy.js    — Filters signals, enters/exits paper trades, mark-to-market

scripts/
  flow-alert.js  — Standalone flow alert scanner with file-based dedup
```

## Running

Designed to run via OpenClaw cron jobs:

```bash
# Collect flow data + run strategy (every 30min during market hours)
cd strategy && node collector.js && node strategy.js

# Flow alert scanner (standalone, sends Signal notifications)
node scripts/flow-alert.js
```

## Data

Runtime data stored in `strategy/data/` (gitignored):
- `strategy-state.json` — open/closed positions, stats
- `trades.jsonl` — trade log
- `flow-YYYY-MM-DD.jsonl` — daily flow alert archives
- `screener-YYYY-MM-DD.jsonl` — daily screener archives
- `seen-flow-alerts.json` — dedup state for alert scanner

## Status

**Paper trading** — collecting data since Feb 16, 2026. No real money at risk.

## License

Private — illuscapital
