---
name: dashboard-api
description: Moby dashboard — Express API endpoints, frontend rendering, KPI calculations
---

# Dashboard API

## Server
- `dashboard/server.js` — Express on port 3200
- `dashboard/index.html` — single-page app, vanilla HTML/CSS/JS
- Start: `cd Moby && setsid nohup node dashboard/server.js >> dashboard/dashboard.log 2>&1 &`

## Dashboard Structure
Two top-level sections in header nav:
- **📊 Strategy** — Summary KPIs, per-strategy cards, tabbed views (Flow/Riptide/Theta/Yolo/Trade Log)
- **🔬 Research** — Backtesting tool with filters, sortable paginated results, server-side optimizer

## API Endpoints

### Strategy APIs

| Endpoint | Returns |
|----------|---------|
| `GET /api/summary` | Combined KPIs for all 4 strategies |
| `GET /api/flow` | Flow open + closed positions + stats |
| `GET /api/riptide` | Riptide positions + credit stats |
| `GET /api/theta` | Theta positions + condor stats |
| `GET /api/yolo` | Yolo positions + delta stats |

### Research APIs

| Endpoint | Method | Returns |
|----------|--------|---------|
| `GET /api/research` | GET | All flow alerts with shadow pricing, enrichment data |
| `POST /api/research/optimize` | POST | Start optimizer batch job (accepts baseline filters as JSON) |
| `GET /api/research/optimize` | GET | Poll optimizer status/results (idle/running/done/error) |

## Research Page

### Filters
- **Range sliders**: Option Price, Premium, Vol/OI, IV, DTE, OTM%, Days to ER, Ask Side %, Min Trade Count (all with "All" bypass checkbox)
- **Dropdowns**: Type (All/Calls/Puts), Rule (All/RepeatedHits/Ascending Fill), Sector, Date Range
- **Checkboxes**: Opening Only, Require Earnings, Exclude Indexes, Sweeps Only, Single Leg, Active/Expired/Invalid

### Result Columns
Ticker, Open Date, Type, Strike, Entry, Last/Exit, Expiry, PnL, PnL%, Peak%, Size, Trades, Premium, Vol/OI, IV, IV Pctl, DTE, OTM%, Spread%, DP $, ER, Status

### Optimizer
Server-side batch job searching ~344K parameter combinations:
- Dimensions: premium min, vol/OI min, IV max, DTE range, OTM% range, spread% max, sweeps, trade count min, type
- Inherits current dropdown/checkbox selections as baseline
- Returns top 50 results ranked by total PnL
- Click any row to apply those filters

## Data Rules
- Dashboard is READ-ONLY — never mutate trade data in API responses
- `computeStats(closed, extras)` is the single P&L aggregation function
- JSONL is source of truth for closed positions, not state file
- `MOBY_EPOCH` env var filters positions by entry date (ISO or YYYY-MM-DD)

## Frontend Helpers
```js
pnl(val)      // Format dollar value: $1,234 or ($567)
pct(val)      // Format percentage: +12.3%
pnlClass(val) // Returns 'pos' or 'neg' for CSS coloring
```

Auto-refresh every 30 seconds via `setInterval` (Strategy section only).

### Adding a New Strategy Tab
1. Add tab button: `<div class="tab" data-tab="name">🎯 Name</div>`
2. Add content div: `<div id="tab-name" class="tab-content"></div>`
3. Add render function: `function renderNameTable(state) { ... }`
4. Add fetch in `refresh()`: `fetch('/api/name').then(r => r.json())`
5. Add strategy card: `renderStratCard($('nameCard'), 'Name', '🎯', summary.name)`
