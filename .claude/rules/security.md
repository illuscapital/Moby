---
paths: ["**/*.js", "**/.env*", "**/.gitignore"]
---

# Security Rules

## Secrets
- NEVER read, output, or log .env file contents
- NEVER hardcode API tokens — use `process.env` via dotenv with fail-fast `process.exit(1)` if missing
- NEVER use `|| 'fallback'` patterns for credentials

## Git Safety
- NEVER use `git add -A`, `git add .`, or `git add --all` — always stage files explicitly
- Before any commit: `git diff --cached | grep -i "token\|key\|secret\|password\|private"` — abort if matches
- .gitignore MUST include: `.env`, `data/`, `*.jsonl`, `node_modules/`, `*.log`
- Show full diff to human before deploying

## Data Files
- JSONL trade logs are append-only source of truth — never modify closed trade records
- State JSON files hold open positions only — closedPositions array is for dashboard reads
- Never "hack" data in API responses — if numbers need to change, change the source data
