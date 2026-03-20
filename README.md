# 🐋 Moby

Options trading system built on [Unusual Whales](https://unusualwhales.com) flow data. Four complementary strategies that exploit options mispricing around earnings, IV crush, and whale activity.


## Strategies

### 🐋 Flow — Pre-Earnings Directional (Sweeps Only)

Buy naked long options on stocks with unusual sweep flow ahead of earnings.

| Parameter | Value |
|---|---|
| Option price | $0–$3 per share |
| Premium range | $100K–$5M |
| Vol/OI ratio | 0–50x |
| IV range | 0–70% |
| DTE range | 15–90 |
| OTM range | 0–20% |
| Earnings window | Required, within 14 trading days |
| Sweeps only | Yes |
| Require single-leg | Yes |
| Min ask-side premium | 70% |
| Exclude indexes | Yes (SPX, SPXW, SPY, QQQ, IWM, DIA, XSP, VIX, NDX, RUT) |
| Position size | $500 per trade (1.5x with dark pool confirmation) |
| Max open positions | 50 |

**Dark pool confirmation:** If ticker has ≥ 50 recent prints and ≥ $1M notional, position size scales to 1.5x ($750).

**Exit rules:**

| Rule | Trigger |
|---|---|
| Profit take | +175% unrealized gain |
| Earnings BMO | Exit at open on ER day |
| Earnings AMC | Exit next business day open |
| Pre-expiry | ER after option expiry and DTE ≤ 3 |
| Emergency | DTE ≤ 1 |

### 🌊 Riptide — Credit Spread Fade (Sweeps Only)

Sell credit spreads against unusual sweep flow. Profits from IV crush and theta decay.

| Parameter | Value |
|---|---|
| Option price | $0–$3 per share |
| Premium range | $100K–$5M |
| Vol/OI ratio | 0–10x |
| IV range | 20–200% |
| DTE range | 0–30 |
| OTM range | 0–50% |
| Min IV percentile | 60th |
| Sweeps only | Yes |
| Require single-leg | Yes |
| Min ask-side premium | 15% |
| Exclude indexes | Yes |
| Earnings exclusion | None |
| Spread width | $2.50 (strike ≤ $50), $5.00 (strike > $50) |
| Min credit/contract | $1.50 |
| Min credit/width ratio | 25% |
| Max risk per trade | $500 |
| Max open positions | 50 |

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

### ⏳ Theta — Earnings Iron Condors

Sell iron condors around earnings when IV is elevated and no strong directional flow exists.

| Parameter | Value |
|---|---|
| Min IV rank | 50% |
| Max bid/ask spread | 15% on short strikes |
| Earnings window | 0–3 trading days before ER |
| Short strike OTM | ~8% each side |
| Wing width | $5 or 3% of stock price (whichever is greater) |
| Max risk per trade | $5,000 |
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

### 🎲 Yolo — Follow the Whales (No Earnings)

Buy the same option the whales are buying. Naked long, momentum-driven. Same filters as Flow but inverted earnings logic — only enters when NO earnings or earnings ≥ 14 trading days away.

| Parameter | Value |
|---|---|
| Option price | $0–$3 per share |
| Premium range | $100K–$5M |
| Vol/OI ratio | 0–50x |
| IV range | 0–70% |
| DTE range | 15–90 |
| OTM range | 0–20% |
| Earnings | Missing or ≥ 14 trading days away |
| Require single-leg | Yes |
| Min ask-side premium | 70% |
| Exclude indexes | Yes |
| Max entry delta | $0.10 above alert ask price |
| Position size | $500 per trade (1.5x with dark pool confirmation) |
| Max open positions | 50 |
| Theta guard fraction | 2/3 of calendar days to expiry |

**Exit rules:**

| # | Rule | Trigger |
|---|---|---|
| 1 | Trailing stop | 15% drop from peak price (only when in profit) |
| 2 | Stop loss | -10% from entry |
| 3 | Theta guard | 2/3 of calendar days elapsed |

No hard profit cap — let winners run, trailing stop locks in gains.

## Running

All four processes run as **systemd user services** — they auto-start on boot and restart on crash.

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

### Service Management

```bash
# Status
systemctl --user status moby-scanner moby-exit-monitor moby-shadow-tracker moby-dashboard

# Start/stop/restart individual services
systemctl --user start moby-scanner
systemctl --user stop moby-scanner
systemctl --user restart moby-scanner

# View logs
journalctl --user -u moby-scanner -f
tail -f data/scanner.log

# Start all
systemctl --user start moby-scanner moby-exit-monitor moby-shadow-tracker moby-dashboard

# Stop all
systemctl --user stop moby-scanner moby-exit-monitor moby-shadow-tracker moby-dashboard
```

### Services

| Service | Unit Name | Process | Log |
|---|---|---|---|
| Scanner | `moby-scanner` | `scanner.js` | `data/scanner.log` |
| Exit Monitor | `moby-exit-monitor` | `exit-monitor.js` | `data/exit-monitor.log` |
| Shadow Tracker | `moby-shadow-tracker` | `shadow-tracker.js` | `data/shadow-tracker.log` |
| Dashboard | `moby-dashboard` | `dashboard/server.js` | `dashboard/dashboard.log` |

Service files: `~/.config/systemd/user/moby-*.service`

User lingering is enabled (`loginctl enable-linger`) so services persist across logouts.

## Data Files

| File | Format | Contents |
|---|---|---|
| `*-state.json` | JSON | Open positions, closed positions (convenience copy), seen alert IDs, running stats |
| `*-trades.jsonl` | JSONL | Append-only trade log. Each line: `{action: 'OPEN'|'CLOSE', ...position, timestamp}`. Source of truth for P&L. |
| `flow-YYYY-MM-DD.jsonl` | JSONL | Flow alerts from UW API, deduplicated by alert ID. Stamped with enrichment data (`_ivPctl`, `_dpRecentNotional`, etc.) when available at archive time. |
| `screener-YYYY-MM-DD.jsonl` | JSONL | Option screener snapshots, collected every 30 minutes |
| `enrichment-cache.json` | JSON | Per-ticker IV percentile (`_ivPctl`), dark pool stats (`_dpPrintCount`, `_dpRecentNotional`). 30-minute TTL. |
| `shadow-state.json` | JSON | Shadow pricing for all flow alerts. Per-alert: entry/last/peak prices, simulated PnL, status (active/expired). Updated by `shadow-tracker.js`. |
| `seen-flow-alerts.json` | JSON | Alert deduplication map (`alertId → date`). Pruned to 7-day window. |

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

### Four Persistent Processes

**`scanner.js`** — Entry system. Polls UW flow alerts every 90 seconds (configurable via `SCANNER_POLL_INTERVAL_MS`). Deduplicates alerts, archives to daily JSONL files, enriches tickers with IV percentile and dark pool data, then runs each new alert through Flow, Riptide, and Yolo entry filters. Theta runs on a separate 30-minute schedule within the same process (earnings-based, not flow-based). Screener collection and enrichment also run every 30 minutes. All entries tagged with `entrySource: 'scanner'`.

**`exit-monitor.js`** — Exit system. Polls option prices every 90 seconds for all open positions across all 4 strategies. Performs mark-to-market valuation and checks each strategy's exit rules. Only runs during market hours (9:30 AM – 4:00 PM ET). Exits blocked before 10:00 AM ET (30-minute opening buffer). All exits tagged with `exitSource: 'exit-monitor'`.

**`shadow-tracker.js`** — Research pricing. Monitors option prices for ALL historical flow alerts (not just traded ones). Runs every 30 minutes during market hours. Feeds the Research page on the dashboard for backtesting filter combinations.

**`dashboard/server.js`** — Read-only Express server on port 3200. Reads state files for open positions and JSONL trade logs for closed positions. Never mutates data.

### Data Flow

- JSONL trade logs are the **source of truth** for closed positions (append-only, crash-safe)
- State JSON files hold open positions, seen alert IDs, and running stats
- Each strategy has its own state file and trade log
- Dashboard computes all KPIs from JSONL at request time

### Legacy Files (deprecated)

The standalone strategy files (`strategy.js`, `riptide-strategy.js`, `theta-strategy.js`, `yolo-strategy.js`, `collector.js`) are **deprecated**. All entry logic lives in `scanner.js`, all exit logic in `exit-monitor.js`. The old cron-based pipeline that called these files individually has been disabled. These files remain for reference only.

## Dashboard

Two top-level sections accessible from the header nav:

### 📊 Strategy

Combined KPIs (total P&L, win rate, open positions), per-strategy summary cards, and tabbed views for each strategy's open/closed positions plus a unified Trade Log.

### 🔬 Research

Backtesting tool for evaluating filter combinations against all historical flow alerts. Powered by `shadow-tracker.js` which prices every alert option, not just traded ones.

**Filters:**
- Range sliders: Option Price, Premium, Vol/OI, IV, DTE, OTM%, Days to ER, Ask Side %, Min Trade Count
- Dropdowns: Type (All/Calls/Puts), Rule (All/RepeatedHits/Ascending Fill), Sector, Date Range
- Checkboxes: Opening Only, Require Earnings, Exclude Indexes, Sweeps Only, Single Leg, Active/Expired/Invalid status

**Result columns:** Ticker, Open Date, Type, Strike, Entry, Last/Exit, Expiry, PnL, PnL%, Peak%, Size, Trades, Premium, Vol/OI, IV, IV Pctl, DTE, OTM%, Spread%, DP $, ER, Status

**Optimizer:** Server-side batch job (`POST /api/research/optimize`) that grid-searches ~344K parameter combinations across premium, vol/OI, IV, DTE, OTM%, spread%, sweeps, trade count, and type. Inherits current dropdown/checkbox selections as baseline. Returns top 50 results ranked by total PnL with win rate, avg PnL, and avg peak%. Click any result row to apply those filters.

**Enrichment data:** Scanner stamps IV percentile (`_ivPctl`) and dark pool stats (`_dpRecentNotional`, `_dpPrintCount`, `_dpAvgPrintSize`) from the enrichment cache onto flow JSONL alerts at archive time. Old alerts before this change show "—" for these columns.

## Dashboard API

JSON endpoints:

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/flow` | GET | Flow open/closed positions and stats |
| `GET /api/riptide` | GET | Riptide open/closed positions and stats |
| `GET /api/theta` | GET | Theta open/closed positions and stats |
| `GET /api/yolo` | GET | Yolo open/closed positions, delta stats |
| `GET /api/summary` | GET | Combined KPIs across all 4 strategies |
| `GET /api/research` | GET | All flow alerts with shadow pricing, enrichment data |
| `POST /api/research/optimize` | POST | Start optimizer batch job (accepts baseline filters as JSON body) |
| `GET /api/research/optimize` | GET | Poll optimizer status/results (`idle`/`running`/`done`/`error`) |

