---
name: dashboard-api
description: Moby dashboard — Express API endpoints, frontend rendering, KPI calculations
---

# Dashboard API

## Server
- `dashboard/server.js` — Express on port 3200
- `dashboard/index.html` — single-page app, vanilla HTML/CSS/JS
- Start: `cd Moby && setsid nohup node dashboard/server.js >> dashboard/dashboard.log 2>&1 &`
- Stop: `pkill -f "Moby/dashboard/server.js"`

## API Endpoints

### GET /api/summary
Combined KPIs for all 4 strategies. Powers the main strategy cards.
```json
{
  "flow": { "totalPnl": 0, "totalTrades": 5, "wins": 3, "losses": 2, "openCount": 2, "unrealized": 150 },
  "riptide": { ... },
  "theta": { ... },
  "yolo": { ... },
  "combined": { "totalPnl": 0, "totalUnrealized": 0, "totalTrades": 0, "wins": 0, "losses": 0, "openPositions": 0 }
}
```

### GET /api/flow, /api/riptide, /api/theta
Per-strategy detail: `{ openPositions, closedPositions, stats }`.
Closed positions read from JSONL trade logs (source of truth).

### GET /api/yolo
Same as above plus `deltaStats` (price slippage tracking):
```json
{
  "deltaStats": { "avgDelta": -0.05, "avgDeltaPct": -2.1, "avgDelaySec": 35, "totalSlippage": -150, "samples": 10 }
}
```

## Data Rules
- Dashboard is READ-ONLY — never mutate trade data in API responses
- `computeStats(closed, extras)` is the single P&L aggregation function
- JSONL is source of truth for closed positions, not state file
- `MOBY_EPOCH` env var filters positions by entry date (ISO or YYYY-MM-DD)

## Frontend

### Structure
- Tab bar: Flow, Riptide, Theta, Yolo, Trade Log
- Strategy cards on main view with: Realized P&L, Unrealized, Win Rate, Open/Closed counts
- Each tab shows open positions table + closed positions table

### Helpers
```js
pnl(val)      // Format dollar value: $1,234 or ($567)
pct(val)      // Format percentage: 12.3%
pnlClass(val) // Returns 'pos' or 'neg' for CSS coloring
```

### Auto-refresh
Fetches all APIs every 30 seconds via `setInterval`.

### Adding a New Strategy Tab
1. Add tab button: `<div class="tab" data-tab="name">🎯 Name</div>`
2. Add content div: `<div id="tab-name" class="tab-content"></div>`
3. Add render function: `function renderNameTable(state) { ... }`
4. Add fetch in `loadAll()`: `fetch('/api/name').then(r => r.json())`
5. Add strategy card: `renderStratCard($('nameCard'), 'Name', '🎯', summary.name)`
