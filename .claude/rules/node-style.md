---
paths: ["**/*.js"]
---

# Node.js Style

## Conventions
- Node.js, no TypeScript, `require()` not `import`
- Load env at top of every entry point:
  ```js
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
  ```
- Fail fast on missing required env vars:
  ```js
  const API_TOKEN = process.env.UW_API_TOKEN;
  if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
  ```

## Logging
- Console logging with ISO timestamps: `[${new Date().toISOString()}]`
- Use `console.log` for info, `console.error` for errors
- Log prefix helper: `const LOG_PREFIX = () => \`[\${new Date().toISOString()}]\`;`

## HTTP
- Use Node.js `https` module for API calls (not axios/node-fetch)
- Rate limit: 300ms sleep between API calls (`RATE_LIMIT_MS = 300`)
- Always handle `.on('error')` for HTTP requests

## Async
- Async/await throughout
- Sleep helper: `const sleep = (ms) => new Promise(r => setTimeout(r, ms));`
- Main loops wrapped in try/catch with error logging

## State Management
- State files (JSON): hold open positions, seen alert IDs, stats
- Trade logs (JSONL): append-only, one JSON object per line
- JSONL is source of truth for closed positions — dashboard reads from JSONL
- State `closedPositions` array exists for convenience but JSONL is canonical
- Always call `saveState()` at end of run cycle

## Dependencies
- `dotenv` — env var loading
- `https` (built-in) — API calls
- `fs`, `path` (built-in) — file I/O
- `express` — dashboard server only
