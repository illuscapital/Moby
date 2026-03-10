---
name: options-pricing
description: Option pricing via Unusual Whales API — bid/ask/mid, delta tracking, valuation
---

# Options Pricing

## Price Sources
All option prices come from UW API: `/stock/{ticker}/option-contracts?option_symbol={symbol}`

## Price Hierarchy
- **Entry**: use ask price (worst-case, what you'd actually pay)
- **Exit valuation**: use mid price (fair value), fallback to bid
- **Exit fill**: use bid price (what you'd actually receive)

```js
// Entry
const entryPrice = quote.ask > 0 ? quote.ask : quote.price;

// Exit check (should we exit?)
const currentPrice = quote?.mid > 0 ? quote.mid : (quote?.bid > 0 ? quote.bid : null);

// Exit fill (what we'd get)
const exitPrice = quote?.bid > 0 ? quote.bid : currentPrice;
```

## Price Delta Tracking (Yolo)
Measures slippage between whale's price and our entry:
```js
const priceDelta = entryPrice - alertAsk;      // negative = we got cheaper (good)
const priceDeltaPct = (priceDelta / alertAsk) * 100;
const alertDelaySec = (Date.now() - alertTime) / 1000;
```

## P&L Calculation
```js
// Per contract (options are 100 shares per contract)
const pnlPerContract = (exitPrice - entryPrice) * 100;
const totalPnl = pnlPerContract * contracts;
const pnlPct = (exitPrice - entryPrice) / entryPrice * 100;
```

## Credit Spread P&L (Riptide)
```js
// Credit received = premium collected upfront
// Current cost to close = ask of the spread
// P&L = credit - closePrice (per contract × 100)
const pnl = (creditReceived - currentSpreadPrice) * contracts * 100;
```

## Trailing Stop (Yolo)
```js
// Track peak
if (!position.peakPrice || currentPrice > position.peakPrice) {
  position.peakPrice = currentPrice;
}
// Exit if dropped 15% from peak (only when in profit)
if (peakPrice > entryPrice) {
  const dropFromPeak = (peakPrice - currentPrice) / peakPrice * 100;
  if (dropFromPeak >= 15) exit();
}
```

## OCC Symbol Format
`{TICKER}{YYMMDD}{C|P}{STRIKE*1000}` padded to 8 digits
- `AAPL260320C00150000` = AAPL March 20 2026 $150 Call
- `SPY260115P00580000` = SPY Jan 15 2026 $580 Put
