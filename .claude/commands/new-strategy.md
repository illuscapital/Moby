# Scaffold New Strategy

Create a new Moby trading strategy from the standard template.

## Steps

1. **Define strategy**: Ask user for strategy name, entry filters, exit rules, position sizing
2. **Create strategy file**: `<name>-strategy.js` with standard structure:
   ```js
   #!/usr/bin/env node
   // <Name>: <one-line description>
   const https = require('https');
   const fs = require('fs');
   const path = require('path');
   require('dotenv').config({ path: path.join(__dirname, '.env') });

   const API_TOKEN = process.env.UW_API_TOKEN;
   if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }

   const DATA_DIR = path.join(__dirname, 'data');
   const STATE_FILE = path.join(DATA_DIR, '<name>-state.json');
   const TRADES_FILE = path.join(DATA_DIR, '<name>-trades.jsonl');
   ```
3. **Required functions**: `loadState()`, `saveState()`, `logTrade()`, `fetchJson()`, `getOptionPrice()`, `shouldExit()`, `run()`
4. **Add to dashboard**:
   - `server.js`: add TRADE_FILES entry, add `/api/<name>` endpoint, add to `/api/summary`
   - `index.html`: add tab, add render function, add strategy card
5. **Add to cron pipeline**: append `&& node <name>-strategy.js` to cron task
6. **Update README**: add strategy section with entry/exit docs
7. **Test**: run once manually, verify state file and JSONL output

## Checklist
- [ ] dotenv loaded at top
- [ ] Fail-fast on missing UW_API_TOKEN
- [ ] State + JSONL file paths defined
- [ ] Rate limiting (300ms between API calls)
- [ ] OPEN/CLOSE entries written to JSONL
- [ ] State saved at end of run
- [ ] Dashboard endpoint + tab added
- [ ] README updated
