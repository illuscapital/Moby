---
name: strategy-architecture
description: Moby's 4 trading strategies — entry/exit logic, state management, data flow
---

# Strategy Architecture

## Overview
Moby runs 4 options strategies on Unusual Whales flow data. All paper trading.

All entry logic lives in `scanner.js`. All exit logic lives in `exit-monitor.js`. The old standalone strategy files have been removed.

| Strategy | Style | Risk/Trade | Max Positions |
|----------|-------|------------|---------------|
| Flow | Directional earnings longs (sweeps only) | $500 (1.5x w/ DP) | 50 |
| Riptide | Credit spread fades | $5K max risk | 5 |
| Theta | Iron condors on earnings | $5K max risk | 5 |
| Yolo | Follow whale flow (longs, no earnings) | $500 (1.5x w/ DP) | 50 |

## Flow — Directional Earnings (Sweeps Only)
- Entry: option price $0–$3, premium $100K–$5M, vol/OI 0–50x, IV 0–70%, DTE 15–90, OTM 0–20%
- Requires: earnings within 14 trading days, sweep order, single-leg, ask-side ≥70%, no indexes
- Position: buy the option at ask price, $500/trade (1.5x with dark pool confirmation)
- Exit: at earnings open (BMO/AMC), +175% profit, ≤3 DTE pre-expiry, ≤1 DTE emergency
- No stop loss — position sizing is risk control

## Riptide — Credit Spread Fade
- Entry: sell credit spreads against flow alerts, IV ≥80%, IV pctl ≥60th
- Spread: bull put (bearish flow) or bear call (bullish flow), dynamic width
- Exit priority: moneyness → 3x stop → 50% profit → IV crush → time decay → earnings → DTE floor
- Min credit $1.50/contract, earnings exclusion 14 days

## Theta — Earnings Premium Selling
- Entry: iron condors on earnings stocks, IV rank >50%, earnings 0–3 days
- Structure: short strikes ~8% OTM, wings $5 or 3% further
- Exit: at earnings open, 50% profit target, 200% stop

## Yolo — Follow the Whales (No Earnings)
- Entry: same filters as Flow but inverted earnings — only enters when NO earnings or earnings ≥14 trading days away
- Option price $0–$3, premium $100K–$5M, vol/OI 0–50x, IV 0–70%, DTE 15–90, OTM 0–20%
- Position: buy the option at ask price, $500/trade (1.5x with dark pool confirmation)
- Exit: -10% stop loss, 15% trailing stop from peak (profit only), theta guard at 2/3 time elapsed
- No profit cap — let winners run

## Processes (systemd user services)

| Service | Unit | Role |
|---------|------|------|
| Scanner | `moby-scanner` | Polls UW flow every 90s, runs Flow/Riptide/Yolo entry filters, Theta scan every 30min |
| Exit Monitor | `moby-exit-monitor` | Polls option prices every 90s, checks exits for all 4 strategies |
| Shadow Tracker | `moby-shadow-tracker` | Prices all historical alerts every 30min for Research page |
| Dashboard | `moby-dashboard` | Read-only Express UI on port 3200 |

```bash
systemctl --user status moby-scanner    # check
systemctl --user restart moby-scanner   # restart
```

## Data Flow
```
UW API → scanner.js → flow-YYYY-MM-DD.jsonl (raw alerts)
                    → screener-YYYY-MM-DD.jsonl (earnings data)
                    → enrichment-cache.json (IV pctl, dark pool)
                    → strategy-state.json + trades.jsonl (Flow)
                    → riptide-state.json + riptide-trades.jsonl (Riptide)
                    → theta-state.json + theta-trades.jsonl (Theta)
                    → yolo-state.json + yolo-trades.jsonl (Yolo)

       → exit-monitor.js → reads/writes all *-state.json + *-trades.jsonl
       → shadow-tracker.js → shadow-state.json (Research page)
       → dashboard/server.js → reads all state + JSONL files (read-only)
```

## State File Format
```json
{
  "openPositions": [{ "ticker": "AAPL", "entryPrice": 1.50, "contracts": 1, ... }],
  "closedPositions": [],
  "seenAlertIds": ["uuid1", "uuid2"],
  "stats": { "totalPnl": 0, "totalTrades": 0, "wins": 0, "losses": 0 },
  "lastRun": "2026-03-18T17:00:00.000Z"
}
```

## JSONL Trade Log Format
One JSON object per line. OPEN lines = entries, CLOSE lines = exits:
```json
{"action":"OPEN","ticker":"AAPL","type":"call","strike":150,"entryPrice":1.50,"contracts":1,...}
{"action":"CLOSE","ticker":"AAPL","exitPrice":2.80,"pnl":130,"pnlPct":86.7,"exitReason":"profit_target",...}
```

JSONL is the source of truth for closed positions. Dashboard reads JSONL, not state file closedPositions.
