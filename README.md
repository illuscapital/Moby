# 🐋 Moby

Options trading bot built on [Unusual Whales](https://unusualwhales.com) data. Two complementary strategies that profit from earnings volatility in opposite ways.

## Strategies

### 🐋 Flow — Directional Earnings Bets

Follows unusual options flow into earnings. When smart money makes large, directional bets before an earnings release, Moby follows.

**Entry Filters:**
- Premium ≥ $200K
- Volume/OI ≥ 5x (unusual size)
- DTE: 5–45 days
- OTM: 2–15%
- IV: 15–85% (avoids extreme IV crush)
- Earnings within 10 trading days
- Ask-side ≥ 70% (directional conviction)
- Single-leg, common stock only

**Position Sizing:** $5K max per position, 10 max open

**Exit Rules:**
- No stop losses — position sizing is the risk control
- Profit-take at +175%
- Exit at first market open after earnings (BMO → same day, AMC → next day)
- Pre-expiry exit at ≤ 3 DTE if earnings are after expiry
- Emergency exit at ≤ 1 DTE

### 🐋⏳ Theta — Earnings Premium Selling

Sells iron condors on earnings stocks where Flow has no directional signal. Profits from IV crush when the stock stays in range.

**Entry Filters:**
- IV rank > 50% (elevated premium to sell)
- Earnings within 0–3 trading days
- No position conflict with Flow strategy
- Liquid chains (bid-ask spread < 15%)

**Condor Structure:**
- Short strikes ~8% OTM each side
- Wings $5 or 3% further out (whichever is greater)
- Defined risk on both sides

**Position Sizing:** $2.5K max risk per condor, 5 max open

**Exit Rules:**
- Close at first market open after earnings
- Profit target: 50% of max credit
- Stop loss: 200% of credit received

## Architecture

```
strategy/
  collector.js          — Fetches UW flow alerts + screener data every 30min
  strategy.js           — Flow strategy: filters, entries, exits, mark-to-market
  theta-strategy.js     — Theta strategy: iron condor construction + management
  report-template.html  — HTML template for Flow report images
  render-report.js      — Generates Flow report HTML
  render-theta-report.js — Generates Theta report HTML

scripts/
  flow-alert.js         — Standalone flow alert scanner with file-based dedup
```

## Running

Designed to run via OpenClaw cron jobs (every 30min during market hours):

```bash
cd strategy && node collector.js && node strategy.js && node theta-strategy.js
```

## Environment Variables

```
UW_API_TOKEN=         # Unusual Whales API token (required)
SIGNAL_TARGET_UUID=   # Signal recipient UUID for notifications (optional)
```

## Data

Runtime data stored in `strategy/data/` (gitignored):
- `strategy-state.json` — Flow open/closed positions, stats
- `theta-state.json` — Theta open/closed positions, stats
- `trades.jsonl` / `theta-trades.jsonl` — trade logs
- `flow-YYYY-MM-DD.jsonl` — daily flow alert archives
- `screener-YYYY-MM-DD.jsonl` — daily screener archives

## Status

**Paper trading** — collecting data since Feb 16, 2026. No real money at risk.

## License

Private — illuscapital
