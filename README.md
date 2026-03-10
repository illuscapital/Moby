# 🐋 Moby

Options trading bot built on [Unusual Whales](https://unusualwhales.com) data. Four complementary strategies that profit from unusual options flow in different ways.

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

Sells credit spreads against unusual flow alerts. When large options activity spikes IV on a stock, Riptide fades it — collecting premium and profiting from IV crush when the stock doesn't move as much as the flow implied.

**Entry Filters:**
- Premium ≥ $100K
- Puts and calls — sells bull put spreads or bear call spreads depending on flow direction
- Sweeps allowed — high IV = more premium, exit logic protects
- IV ≥ 60% (need enough inflated premium to sell — no ceiling)
- IV percentile ≥ 70th (only sell when IV is historically elevated)
- DTE: 5–90 days, Vol/OI ≥ 3x
- OTM: 10–30% (short strike must be ≥ 10% out-of-the-money)
- Min credit: $1.50/contract (eliminates bad risk/reward trades)
- Earnings exclusion: skip if ER within 14 days (avoid vol events)
- Credit ≥ 25% of spread width (risk/reward gate)
- Ask-side ≥ 70%, single-leg, no indexes

**Spread Structure:**
- Bull put spread (bearish flow) or bear call spread (bullish flow)
- Dynamic width: $2.50 for strikes < $50, $5.00 for strikes ≥ $50

**Position Sizing:** 5% of $100K account ($5K max risk per trade), 5 max open

**Exit Rules (priority order):**
1. **Moneyness** — underlying within 2% of short strike (thesis broken)
2. **Stop loss** — spread cost ≥ 3x credit received (hard cap)
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

### 🎲 Yolo — Follow the Whales

Goes WITH unusual options flow — buys the same option the whales are buying. Naked long options with tight risk management.

**Entry Filters:**
- Premium ≥ $100K
- Volume/OI ≥ 3x
- DTE: 5–90 days
- OTM: 10–30%
- IV percentile ≥ 50th
- Ask-side ≥ 70% (directional conviction)
- Single-leg, common stock only, no indexes
- Dark pool confirmation: ≥ 5 recent prints, ≥ $1M notional

**Position Sizing:** $5K max per position, 5 max open

**Exit Rules (priority order):**
1. **Trailing stop** — exits if price drops 15% from peak (only activates when in profit, no hard profit cap — let winners run)
2. **Stop loss** — exits at -10% loss (tight, cut losers fast)
3. **Theta guard** — exits after 2/3 of calendar days elapsed (time decay protection)

**Price Delta Tracking:** Measures slippage between whale's alert-time price and Moby's entry price. Negative delta = buying cheaper than the whale (good).

**Exit Monitor:** Standalone process (`yolo-exit-monitor.js`) polls option prices every 90 seconds during market hours. No LLM needed — pure price checks. Runs independently of the cron-based entry scanner.

## Architecture

```
Moby/
├── .env                    — API tokens (gitignored)
├── collector.js            — Fetches UW flow alerts + screener data every 30min
├── strategy.js             — Flow strategy: filters, entries, exits, mark-to-market
├── riptide-strategy.js     — Riptide strategy: credit spread fades against flow alerts
├── theta-strategy.js       — Theta strategy: iron condor construction + management
├── yolo-strategy.js        — Yolo strategy: follow whale flow, long options
├── yolo-exit-monitor.js    — Standalone exit monitor (90s polling, no LLM)
├── report/
│   ├── render-report.js    — Generates combined Flow + Theta HTML report
│   ├── render-theta-report.js — Generates Theta-only HTML report
│   ├── render-ascii.js     — Generates fixed-width text report (webchat)
│   ├── report-template.html — HTML template for report images
│   └── send-report.sh     — CLI pipeline: render → screenshot → Signal
├── scripts/
│   └── flow-alert.js      — Standalone flow alert scanner with file-based dedup
├── data/                   — Runtime state (gitignored)
│   ├── strategy-state.json — Flow open positions + seen alerts
│   ├── theta-state.json   — Theta open positions
│   ├── riptide-state.json — Riptide open positions
│   ├── yolo-state.json    — Yolo open positions + peak prices
│   ├── trades.jsonl       — Flow trade log (source of truth for closed positions)
│   ├── riptide-trades.jsonl — Riptide trade log (source of truth)
│   ├── theta-trades.jsonl — Theta trade log (source of truth)
│   ├── yolo-trades.jsonl  — Yolo trade log (source of truth)
│   ├── yolo-exit-monitor.log — Exit monitor log
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

### Entry Scanner (cron)

Runs via OpenClaw cron every 30min during market hours (9am–4pm ET, weekdays):

```bash
node collector.js && node strategy.js && node theta-strategy.js && node riptide-strategy.js && node yolo-strategy.js
```

### Yolo Exit Monitor (persistent)

Standalone process — polls prices every 90s, exits based on stop/trailing rules:

```bash
cd Moby && setsid nohup node yolo-exit-monitor.js >> data/yolo-exit-monitor.log 2>&1 &
```

Stop: `pkill -f "yolo-exit-monitor.js"`

### Dashboard

```bash
cd Moby && setsid nohup node dashboard/server.js >> dashboard/dashboard.log 2>&1 &
# → http://localhost:3200
```

Stop: `pkill -f "Moby/dashboard/server.js"`

Auto-refreshes every 30 seconds. Shows combined P&L across all four strategies with tabbed views for Flow, Riptide, Theta, and Yolo positions.

## Environment Variables

All stored in `.env` (loaded via dotenv):

```
UW_API_TOKEN=         # Unusual Whales API token (required)
SIGNAL_TARGET_UUID=   # Signal recipient UUID for notifications (optional)
```

## Status

**Paper trading** — collecting data since Feb 16, 2026. No real money at risk.

## License

Private — illuscapital
