# 🐋 Moby

Options trading bot built on [Unusual Whales](https://unusualwhales.com) data. Three complementary strategies that profit from earnings volatility in different ways.

## Strategies

### 🐋 Flow — Directional Earnings Bets

Follows unusual options flow into earnings. When smart money makes large, directional bets before an earnings release, Moby follows.

**Entry Filters:**
- Premium ≥ $200K
- Volume/OI ≥ 5x (unusual size)
- DTE: 5–45 days
- OTM: 2–15%
- IV: 15–80% (skip NO_DATA, avoid extreme IV crush)
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

### 🌊 Riptide — Credit Spread Fade

Sells put credit spreads against unusual flow alerts. When large put activity spikes IV on a stock, Riptide fades it — collecting premium and profiting from IV crush when the stock doesn't crash as much as the flow implied.

**Entry Filters:**
- Premium ≥ $100K
- Puts only — call fades skipped entirely (backtest: calls lost money selling)
- No sweeps — sweep flow has real smart money conviction, dangerous to fade
- IV ≥ 60% (need enough inflated premium to sell — no ceiling)
- IV data required (skip NO_DATA)
- DTE: 5–45 days, OTM: 2–15%, Vol/OI ≥ 5x
- Ask-side ≥ 70%, single-leg, no indexes
- Earnings NOT required — sells premium on any high-IV put flow

**Spread Structure:**
- Bull put spread: sell alert strike put, buy protection lower
- Dynamic width: $2.50 for strikes < $50, $5.00 for strikes ≥ $50

**Position Sizing:** 5% of $100K account ($5K max risk per trade), 5 max open

**Exit Rules (priority order):**
1. **Moneyness** — underlying drops within 2% of short strike (thesis broken)
2. **Stop loss** — spread cost ≥ 2x credit received (hard cap)
3. **Profit target** — captured ≥ 50% of credit (don't get greedy)
4. **IV crush** — IV dropped ≥ 30% from entry AND position is profitable (edge is gone)
5. **Time decay stop** — 50%+ of time elapsed and P&L is negative (cut losers)
6. **Earnings proximity** — ≤ 2 trading days before ER if one exists (gap risk)
7. **DTE floor** — ≤ 7 DTE (gamma risk too high for credit spreads)


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
Moby/
├── collector.js            — Fetches UW flow alerts + screener data every 30min
├── strategy.js             — Flow strategy: filters, entries, exits, mark-to-market
├── riptide-strategy.js     — Riptide strategy: credit spread fades against flow alerts
├── theta-strategy.js       — Theta strategy: iron condor construction + management
├── report/
│   ├── render-report.js    — Generates combined Flow + Theta HTML report
│   ├── render-theta-report.js — Generates Theta-only HTML report
│   ├── render-ascii.js     — Generates fixed-width text report (webchat)
│   ├── report-template.html — HTML template for report images
│   └── send-report.sh     — CLI pipeline: render → screenshot → Signal
├── scripts/
│   └── flow-alert.js      — Standalone flow alert scanner with file-based dedup
├── data/                   — Runtime state (gitignored)
│   ├── strategy-state.json — Flow positions, stats
│   ├── theta-state.json   — Theta positions, stats
│   ├── trades.jsonl       — Flow trade log
│   ├── riptide-state.json — Riptide positions, stats
│   ├── riptide-trades.jsonl — Riptide trade log
│   ├── theta-trades.jsonl — Theta trade log
│   ├── flow-YYYY-MM-DD.jsonl    — Daily flow alert archives
│   └── screener-YYYY-MM-DD.jsonl — Daily screener archives
├── dashboard/
│   ├── server.js          — Express API server (port 3200)
│   └── index.html         — Single-page dashboard UI
├── .githooks/
│   └── pre-commit         — Blocks commits containing secrets
└── .env.example
```

## Running

Designed to run via OpenClaw cron jobs (every 5min during market hours):

```bash
node collector.js && node strategy.js && node theta-strategy.js && node riptide-strategy.js
```

### Dashboard

```bash
npm run dashboard
# → http://localhost:3200
```

Auto-refreshes every 30 seconds. Shows combined P&L across all three strategies with tabbed views for Flow, Riptide, and Theta positions.

## Environment Variables

```
UW_API_TOKEN=         # Unusual Whales API token (required)
SIGNAL_TARGET_UUID=   # Signal recipient UUID for notifications (optional)
```

## Status

**Paper trading** — collecting data since Feb 16, 2026. No real money at risk.

## License

Private — illuscapital
