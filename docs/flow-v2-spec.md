# Flow v2 Spec — Effective Monday 2026-03-16

## Entry Filters
- **Option Price:** $0 – $3
- **Premium:** $100K – $5M
- **Vol/OI:** 0 – 50
- **IV:** 0 – 70%
- **DTE:** 15 – 90
- **OTM%:** 0 – 20%
- **Earnings:** Must have earnings date within 15 calendar days (≤14 trading days)
- **Sweeps only:** Required
- **Single-leg:** Required (no multi-leg)
- **Ask-side premium:** ≥ 70%
- **Exclude indexes:** SPX, SPXW, SPY, QQQ, IWM, DIA, XSP, VIX, NDX, RUT

## Position Sizing
- **Base:** $300 per trade
- **Dark pool confirmed:** 1.5x = $450 per trade
- Dark pool is a size multiplier only — not required for entry

## Position Limits
- **Max open positions:** 75

## Exit Logic
- Keep existing exit rules (stop-loss, profit target, time decay)
- Note: with DTE ≥ 15 and earnings within 15 days, the earnings event should always occur before expiry

## Fresh Start
- Wipe all prior Flow state (strategy-state.json open positions) on Monday morning
- Research/shadow data unaffected
