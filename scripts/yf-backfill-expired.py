#!/usr/bin/env python3
"""Backfill unpriced EXPIRED shadow positions using yfinance history()."""
import json, time, sys, os
from datetime import datetime

import yfinance as yf

STATE_FILE = os.path.join(os.path.dirname(__file__), '..', 'data', 'shadow-state.json')

with open(STATE_FILE) as f:
    state = json.load(f)

# All unpriced with optionSymbol (expired included)
unpriced = [
    (pid, pos) for pid, pos in state['positions'].items()
    if (not pos.get('lastPrice') or pos['lastPrice'] == 0)
    and pos.get('optionSymbol')
]

print(f"Total unpriced positions: {len(unpriced)}")
if not unpriced:
    sys.exit(0)

priced = 0
not_found = 0
errors = 0
rate_limited = 0
SAVE_EVERY = 50

for i, (pid, pos) in enumerate(unpriced):
    sym = pos['optionSymbol']
    try:
        time.sleep(0.4)
        ticker = yf.Ticker(sym)
        df = ticker.history(period="max", auto_adjust=False)

        if df.empty or len(df) == 0:
            not_found += 1
            continue

        last_row = df.iloc[-1]
        close = float(last_row.get('Close', 0))

        if close <= 0:
            not_found += 1
            continue

        pos['lastPrice'] = close
        pos['lastUpdated'] = datetime.utcnow().isoformat() + 'Z'
        pos['lastSource'] = 'yfinance'

        # Peak from history
        all_highs = float(df['High'].max())
        if all_highs > (pos.get('peakPrice') or 0):
            pos['peakPrice'] = all_highs

        # Simulated PnL
        entry = pos.get('entryPrice', 0)
        if entry and entry > 0 and entry * 100 <= 5000:
            ctrs = max(1, int(5000 / (entry * 100)))
            pos['simulatedPnl'] = (close - entry) * 100 * ctrs
            pos['simulatedPnlPct'] = (close - entry) / entry * 100

        priced += 1

    except Exception as e:
        err_str = str(e)
        if '429' in err_str or 'rate' in err_str.lower():
            rate_limited += 1
            print(f"  Rate limited at {i+1}, waiting 10s (total: {rate_limited})")
            if rate_limited > 20:
                print("Too many rate limits, saving and stopping")
                break
            time.sleep(10)
        else:
            errors += 1

    if (i + 1) % SAVE_EVERY == 0:
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f, indent=2)
        print(f"[{i+1}/{len(unpriced)}] priced={priced} notFound={not_found} errors={errors} rateLimits={rate_limited}")

# Final save
with open(STATE_FILE, 'w') as f:
    json.dump(state, f, indent=2)

still_unpriced = sum(1 for p in state['positions'].values()
                     if (not p.get('lastPrice') or p['lastPrice'] == 0) and p.get('optionSymbol'))

print("=== DONE ===")
print(f"Priced: {priced} | Not found: {not_found} | Errors: {errors} | Rate limits: {rate_limited}")
print(f"Still unpriced: {still_unpriced}")
