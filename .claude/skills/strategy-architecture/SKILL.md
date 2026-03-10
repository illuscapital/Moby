---
name: strategy-architecture
description: Moby's 4 trading strategies — entry/exit logic, state management, data flow
---

# Strategy Architecture

## Overview
Moby runs 4 options strategies on Unusual Whales flow data. All paper trading.

| Strategy | File | Style | Risk/Trade |
|----------|------|-------|------------|
| Flow | strategy.js | Directional earnings longs | $5K |
| Riptide | riptide-strategy.js | Credit spread fades | $5K |
| Theta | theta-strategy.js | Iron condors on earnings | $2.5K |
| Yolo | yolo-strategy.js | Follow whale flow (longs) | $5K |

## Flow — Directional Earnings
- Entry: large premium (≥$200K), high vol/OI (≥5x), earnings within 10 trading days
- Position: buy the option at ask price
- Exit: at earnings open (BMO/AMC), +175% profit, ≤3 DTE pre-expiry, ≤1 DTE emergency
- No stop loss — position sizing is risk control

## Riptide — Credit Spread Fade
- Entry: sell credit spreads against flow alerts, IV ≥60%, IV pctl ≥70th
- Spread: bull put (bearish flow) or bear call (bullish flow), dynamic width
- Exit priority: moneyness → 3x stop → 50% profit → IV crush → time decay → earnings → DTE floor
- Min credit $1.50/contract, earnings exclusion 14 days

## Theta — Earnings Premium Selling
- Entry: iron condors on earnings stocks, IV rank >50%, earnings 0-3 days
- Structure: short strikes ~8% OTM, wings $5 or 3% further
- Exit: at earnings open, 50% profit target, 200% stop

## Yolo — Follow the Whales
- Entry: buy same option as whale alert, premium ≥$100K, OTM 10-30%, IV pctl ≥50th
- Exit: -10% stop loss, 15% trailing stop from peak (profit only), theta guard at 2/3 time
- No profit cap — let winners run
- Exit monitor: standalone `yolo-exit-monitor.js` polls every 90s during market hours

## Data Flow
```
UW API → collector.js → flow-YYYY-MM-DD.jsonl (raw alerts)
                      → screener-YYYY-MM-DD.jsonl (earnings data)
       → strategy.js        → strategy-state.json + trades.jsonl
       → riptide-strategy.js → riptide-state.json + riptide-trades.jsonl
       → theta-strategy.js   → theta-state.json + theta-trades.jsonl
       → yolo-strategy.js    → yolo-state.json + yolo-trades.jsonl
       → yolo-exit-monitor.js (reads/writes yolo-state.json + yolo-trades.jsonl)
```

## State File Format
```json
{
  "openPositions": [{ "ticker": "AAPL", "entryPrice": 1.50, "contracts": 33, ... }],
  "closedPositions": [],
  "seenAlertIds": ["uuid1", "uuid2"],
  "stats": { "totalPnl": 0, "totalTrades": 0, "wins": 0, "losses": 0 },
  "lastRun": "2026-03-10T16:00:00.000Z"
}
```

## JSONL Trade Log Format
One JSON object per line. OPEN lines = entries, CLOSE lines = exits:
```json
{"action":"OPEN","ticker":"AAPL","type":"call","strike":150,"entryPrice":1.50,"contracts":33,...}
{"action":"CLOSE","ticker":"AAPL","exitPrice":2.80,"pnl":4290,"pnlPct":86.7,"exitReason":"profit_target",...}
```

JSONL is the source of truth for closed positions. Dashboard reads JSONL, not state file closedPositions.
