---
paths: ["**/*.js"]
---

# Unusual Whales API

## Base
- URL: `https://api.unusualwhales.com/api/`
- Auth: `Authorization: Bearer ${API_TOKEN}` header on every request
- Rate limit: 300ms between calls, back off on 429s

## Key Endpoints

### Option Pricing
```
GET /stock/{ticker}/option-contracts?option_symbol={OCC_symbol}
```
Response: `{ data: [{ nbbo_bid, nbbo_ask, last_price, implied_volatility, volume, open_interest, ... }] }`

Always check `result?.data?.[0]` — may return empty array.

Price extraction:
```js
const bid = parseFloat(c.nbbo_bid) || 0;
const ask = parseFloat(c.nbbo_ask) || 0;
const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : parseFloat(c.last_price) || 0;
```

### Flow Activity
```
GET /option-activity/feed?limit=100&offset=0
```
Paginated. Returns unusual options activity alerts with premium, vol/OI, type, ticker, strike, expiry.

### Option Chain
```
GET /stock/{ticker}/option-chain?expiry={YYYY-MM-DD}
```
Full chain for a given expiry. Used for credit spread construction (finding short/long strikes).

### Earnings Calendar
```
GET /stock/{ticker}/earnings
```
Returns earnings dates and times (BMO/AMC).

## OCC Option Symbol Format
Standard OCC format: `{TICKER}{YYMMDD}{C|P}{STRIKE*1000}`
Example: `AAPL260320C00150000` = AAPL March 20 2026 $150 Call

## Common Patterns
- Always `await sleep(RATE_LIMIT_MS)` before each API call
- Parse all numeric fields with `parseFloat()` — API returns strings
- Null-check everything: `if (!c) return null`
- For exit valuation: use mid price, fallback to bid (conservative)
- For entry pricing: use ask (worst-case entry)
