# Moby

Options trading system built on [Unusual Whales](https://unusualwhales.com) flow data. Four complementary strategies that exploit options mispricing around earnings, IV crush, and whale activity.

**Status: Paper trading.** All positions are simulated. No broker integration.

## Architecture

```
                         Unusual Whales API
                               │
                ┌──────────────┼──────────────┐
                │              │              │
                ▼              ▼              ▼
         flow-alerts     screener      option-contracts
                │              │              │
                └──────┬───────┘              │
                       │                      │
               ┌───────▼────────┐    ┌────────▼────────┐
               │   scanner.js   │    │ exit-monitor.js  │
               │  (entries)     │    │  (exits)         │
               │  polls 90s     │    │  polls 90s       │
               │                │    │                  │
               │  Flow          │    │  Flow exits      │
               │  Riptide       │    │  Riptide exits   │
               │  Yolo          │    │  Theta exits     │
               │  Theta (30min) │    │  Yolo exits      │
               └───────┬────────┘    └────────┬────────┘
                       │                      │
            ┌──────────┼──────────┐    ┌──────┼──────────┐
            ▼          ▼          ▼    ▼      ▼          ▼
       state.json  trades.jsonl  seen  state  trades   prices
            │          │                │      │
            └──────────┼────────────────┘      │
                       ▼                       │
              ┌────────────────┐               │
              │ dashboard/     │◄──────────────┘
              │ server.js      │  (read-only)
              │ :3200          │
              └────────────────┘
```

### Two Persistent Processes

**`scanner.js`** — Entry system. Polls UW flow alerts every 90 seconds (configurable via `SCANNER_POLL_INTERVAL_MS`). Deduplicates alerts, archives to daily JSONL files, enriches tickers with IV percentile and dark pool data, then runs each new alert through Flow, Riptide, and Yolo entry filters. Theta runs on a separate 30-minute schedule within the same process (earnings-based, not flow-based). Screener collection and enrichment also run every 30 minutes. All entries tagged with `entrySource: 'scanner'`.

**`exit-monitor.js`** — Exit system. Polls option prices every 90 seconds for all open positions across all 4 strategies. Performs mark-to-market valuation and checks each strategy's exit rules. Only runs during market hours (9:30 AM – 4:00 PM ET). Exits blocked before 10:00 AM ET (30-minute opening buffer). All exits tagged with `exitSource: 'exit-monitor'`.

**Dashboard** (`dashboard/server.js`) — Read-only Express server on port 3200. Reads state files for open positions and JSONL trade logs for closed positions. Never mutates data.

### Data Flow

- JSONL trade logs are the **source of truth** for closed positions (append-only, crash-safe)
- State JSON files hold open positions, seen alert IDs, and running stats
- Each strategy has its own state file and trade log
- Dashboard computes all KPIs from JSONL at request time

### Legacy Strategy Files

The individual strategy `.js` files (`strategy.js`, `riptide-strategy.js`, `theta-strategy.js`, `yolo-strategy.js`) contain the original entry + exit logic used by the cron-based system. They still work as standalone scripts but are now backup only — `scanner.js` and `exit-monitor.js` have absorbed all entry and exit logic respectively. Similarly, `collector.js` (data collection) is now handled by `scanner.js`.

## Strategies

### Flow — Pre-Earnings Directional

Buy naked long options on stocks with unusual flow ahead of earnings.

| Parameter | Value |
|---|---|
| Min premium | $200,000 |
| Min vol/OI ratio | 5x |
| DTE range | 5–45 |
| OTM range | 2–15% |
| IV range | 15–80% |
| Earnings window | Within 10 trading days |
| Require single-leg | Yes |
| Min ask-side premium | 70% |
| Exclude indexes | Yes (SPX, SPXW, SPY, QQQ, IWM, DIA, XSP, VIX, NDX, RUT) |
| Position size | $5,000 per trade (1.5x with dark pool confirmation) |
| Max open positions | 10 |

**Dark pool confirmation:** If ticker has ≥ 50 recent prints and ≥ $1M notional, position size scales to 1.5x ($7,500).

**Exit rules:**

| Rule | Trigger |
|---|---|
| Profit take | +175% unrealized gain |
| Earnings BMO | Exit at open on ER day |
| Earnings AMC | Exit next business day open |
| Pre-expiry | ER after option expiry and DTE ≤ 3 |
| Emergency | DTE ≤ 1 |

### Riptide — Credit Spread Fade

Sell credit spreads against high-IV unusual flow. Inverse of Flow — profits from IV crush.

| Parameter | Value |
|---|---|
| Min premium | $100,000 |
| Min vol/OI ratio | 3x |
| DTE range | 5–90 |
| OTM range | 10–30% |
| Min entry IV | 60% |
| Min IV percentile | 70th |
| Earnings exclusion | Skip if ER within 14 trading days |
| Allowed types | Puts and calls |
| Spread width | $2.50 (strike ≤ $50), $5.00 (strike > $50) |
| Min credit/contract | $1.50 |
| Min credit/width ratio | 25% |
| Account size / max risk | $100,000 / 5% per trade ($5,000) |
| Max open positions | 5 |

**Exit rules (priority order):**

| # | Rule | Trigger |
|---|---|---|
| 1 | Moneyness | Underlying within 2% of short strike |
| 2 | Stop loss | Spread cost ≥ 3x credit received |
| 3 | Profit take | 50% of credit captured |
| 4 | IV crush | IV dropped ≥ 30% from entry (and profitable) |
| 5 | Time decay stop | 50%+ time elapsed and still losing |
| 6 | Earnings proximity | ≤ 2 trading days before ER |
| 7 | DTE floor | ≤ 7 DTE |

### Theta — Earnings Iron Condors

Sell iron condors around earnings when IV is elevated and no strong directional flow exists.

| Parameter | Value |
|---|---|
| Min IV rank | 50% |
| Max bid/ask spread | 15% on short strikes |
| Earnings window | 0–3 trading days before ER |
| Short strike OTM | ~8% each side |
| Wing width | $5 or 3% of stock price (whichever is greater) |
| Max risk per trade | $2,500 |
| Max open positions | 5 |
| Exclude indexes | Yes |
| Skip if Flow has position | Yes |

**Entry:** Runs on a 30-minute schedule within `scanner.js`. Scans UW screener for stocks with upcoming earnings, checks IV rank ≥ 50%, builds iron condor from option chain.

**Exit rules:**

| Rule | Trigger |
|---|---|
| Profit take | 50% of max credit captured |
| Stop loss | Loss ≥ 200% of credit received |
| Post-earnings | Exit on ER day (BMO) or next business day (AMC) |

### Yolo — Follow the Whales

Buy the same option the whales are buying. Naked long, momentum-driven.

| Parameter | Value |
|---|---|
| Min premium | $100,000 |
| Min vol/OI ratio | 3x |
| DTE range | 5–90 |
| OTM range | 10–30% |
| Min entry IV | 60% |
| Min IV percentile | 70th |
| Earnings exclusion | Skip if ER within 14 trading days |
| Max entry delta | $0.10 above alert ask price |
| Position size | $5,000 per trade |
| Max open positions | 10 |
| Theta guard fraction | 2/3 of calendar days to expiry |

**Exit rules:**

| # | Rule | Trigger |
|---|---|---|
| 1 | Trailing stop | 15% drop from peak price (only when in profit) |
| 2 | Stop loss | -10% from entry |
| 3 | Theta guard | 2/3 of calendar days elapsed |

No hard profit cap — let winners run, trailing stop locks in gains.

## File Structure

```
Moby/
├── scanner.js              # Entry system — persistent process, polls every 90s
├── exit-monitor.js         # Exit system — persistent process, polls every 90s
├── strategy.js             # Flow strategy (legacy standalone, backup only)
├── riptide-strategy.js     # Riptide strategy (legacy standalone, backup only)
├── theta-strategy.js       # Theta strategy (legacy standalone, backup only)
├── yolo-strategy.js        # Yolo strategy (legacy standalone, backup only)
├── collector.js            # Legacy data collector (absorbed into scanner.js)
├── dashboard/
│   ├── server.js           # Express API server (port 3200)
│   └── index.html          # Dashboard frontend (dark theme, auto-refresh 30s)
├── scripts/
│   └── flow-alert.js       # Standalone flow alert notifier (Signal messages)
├── report/
│   ├── render-ascii.js     # ASCII position table for Flow
│   ├── render-report.js    # HTML report renderer
│   ├── render-theta-report.js  # Theta-specific report
│   ├── report-template.html    # HTML report template
│   └── send-report.sh     # Report delivery script
├── data/                   # Runtime data (gitignored)
│   ├── strategy-state.json     # Flow open positions + stats
│   ├── riptide-state.json      # Riptide open positions + stats
│   ├── theta-state.json        # Theta open positions + stats
│   ├── yolo-state.json         # Yolo open positions + stats
│   ├── trades.jsonl            # Flow trade log (source of truth)
│   ├── riptide-trades.jsonl    # Riptide trade log
│   ├── theta-trades.jsonl      # Theta trade log
│   ├── yolo-trades.jsonl       # Yolo trade log
│   ├── flow-YYYY-MM-DD.jsonl   # Daily archived flow alerts
│   ├── screener-YYYY-MM-DD.jsonl  # Daily screener snapshots
│   ├── seen-flow-alerts.json   # Deduplication state (pruned to 7-day window)
│   ├── enrichment-cache.json   # IV percentile + dark pool cache (30min TTL)
│   ├── scanner.log             # Scanner process log
│   └── exit-monitor.log        # Exit monitor process log
├── .env                    # API tokens and config (gitignored)
├── package.json
└── package-lock.json
```

## Running

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `UW_API_TOKEN` | Yes | — | Unusual Whales API bearer token |
| `SIGNAL_TARGET_UUID` | No | — | Signal messenger target UUID for trade notifications |
| `SCANNER_POLL_INTERVAL_MS` | No | `90000` | Scanner poll interval in ms |
| `MOBY_DASH_PORT` | No | `3200` | Dashboard server port |
| `MOBY_EPOCH` | No | — | ISO date — only show positions entered on/after this date |

### Install

```bash
npm install
```

Dependencies: `dotenv`, `express`. All API calls use Node.js built-in `https`.

### Start Scanner (entries)

```bash
cd Moby && nohup setsid node scanner.js </dev/null >> data/scanner.log 2>&1 &
```

### Start Exit Monitor (exits)

```bash
cd Moby && setsid nohup node exit-monitor.js >> data/exit-monitor.log 2>&1 &
```

### Start Dashboard

```bash
node dashboard/server.js
# or
npm run dashboard
```

Dashboard at `http://localhost:3200`. Auto-refreshes every 30 seconds.

### Stop Processes

```bash
pkill -f "scanner.js"
pkill -f "exit-monitor.js"
```

## Data Files

| File | Format | Contents |
|---|---|---|
| `*-state.json` | JSON | Open positions, closed positions (convenience copy), seen alert IDs, running stats |
| `*-trades.jsonl` | JSONL | Append-only trade log. Each line: `{action: 'OPEN'|'CLOSE', ...position, timestamp}`. Source of truth for P&L. |
| `flow-YYYY-MM-DD.jsonl` | JSONL | Raw flow alerts from UW API, deduplicated by alert ID |
| `screener-YYYY-MM-DD.jsonl` | JSONL | Option screener snapshots, collected every 30 minutes |
| `enrichment-cache.json` | JSON | Per-ticker IV percentile (`_ivPctl`), dark pool stats (`_dpPrintCount`, `_dpRecentNotional`). 30-minute TTL. |
| `seen-flow-alerts.json` | JSON | Alert deduplication map (`alertId → date`). Pruned to 7-day window. |

## Reports

```bash
# Flow positions — ASCII table
node report/render-ascii.js

# HTML reports
node report/render-report.js
node report/render-theta-report.js
```

## Dashboard API

Read-only JSON endpoints:

| Endpoint | Description |
|---|---|
| `GET /api/flow` | Flow open/closed positions and stats |
| `GET /api/riptide` | Riptide open/closed positions and stats |
| `GET /api/theta` | Theta open/closed positions and stats |
| `GET /api/yolo` | Yolo open/closed positions, delta stats |
| `GET /api/summary` | Combined KPIs across all 4 strategies |

## Status

Paper trading — no real money at risk. Not deployed to production.
