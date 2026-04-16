#!/usr/bin/env bash
# validate-deploy.sh — Pre-deploy safety checks for Moby repo
# Exit codes: 0 = all clear, 1 = blocking issue found
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0
WARN=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)) || true; }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)) || true; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; ((WARN++)) || true; }

echo "═══════════════════════════════════════════"
echo "  Moby Pre-Deploy Validation"
echo "═══════════════════════════════════════════"
echo ""

# ── 1. Check .gitignore exists and has required entries ──
echo "▸ .gitignore"
REQUIRED_IGNORES=(".env" "data/" "*.jsonl" "node_modules/" "*.log")
if [ ! -f .gitignore ]; then
    fail ".gitignore does not exist"
else
    ALL_FOUND=true
    for entry in "${REQUIRED_IGNORES[@]}"; do
        if ! grep -qF "$entry" .gitignore; then
            fail "Missing from .gitignore: $entry"
            ALL_FOUND=false
        fi
    done
    if $ALL_FOUND; then
        pass "All required entries present"
    fi
fi

# ── 2. Check staged files for secrets ──
echo "▸ Staged secrets scan"
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
if [ -z "$STAGED" ]; then
    warn "No files staged — nothing to check (did you forget to git add?)"
else
    SECRET_HITS=$(git diff --cached 2>/dev/null | grep -inE "(api_key|api_secret|api_token|private_key|password|token|passphrase|bearer)\s*[=:]" | grep -v "process\.env\|getenv\|#.*example\|#.*TODO\|//.*example" || true)
    if [ -n "$SECRET_HITS" ]; then
        fail "Possible secrets in staged diff:"
        echo "$SECRET_HITS" | head -10 | while IFS= read -r line; do
            echo -e "    ${RED}$line${NC}"
        done
    else
        pass "No secrets detected in staged diff"
    fi
fi

# ── 3. Check for dangerous git add patterns in staged files ──
echo "▸ Dangerous git patterns"
if [ -n "$STAGED" ]; then
    BAD_ADD=$(git diff --cached 2>/dev/null | grep -n "git add -A\|git add \.\|git add --all" || true)
    if [ -n "$BAD_ADD" ]; then
        fail "Staged code contains dangerous git add pattern"
    else
        pass "No dangerous git add patterns"
    fi
else
    pass "No staged files to check"
fi

# ── 4. Verify .env and data files are not staged ──
echo "▸ .env protection"
ENV_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E "^\.env" || true)
if [ -n "$ENV_STAGED" ]; then
    fail ".env file is staged for commit: $ENV_STAGED"
else
    pass "No .env files staged"
fi

echo "▸ Data file protection"
DATA_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E '\.(jsonl|log)$' || true)
JSONDATA_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -E '^data/' || true)
COMBINED=$(printf '%s\n%s' "$DATA_STAGED" "$JSONDATA_STAGED" | sort -u | grep -v '^$' || true)
if [ -n "$COMBINED" ]; then
    fail "Data/trade files staged (these should NOT be committed):"
    echo "$COMBINED" | while IFS= read -r f; do echo -e "    ${RED}$f${NC}"; done
else
    pass "No data/trade files staged"
fi

# ── 5. Node.js syntax check on staged .js files ──
echo "▸ Node.js syntax"
JS_FILES=$(git diff --cached --name-only 2>/dev/null | grep '\.js$' || true)
if [ -z "$JS_FILES" ]; then
    pass "No JS files staged"
else
    JS_OK=true
    while IFS= read -r jsfile; do
        if [ -f "$jsfile" ]; then
            if ! node --check "$jsfile" 2>/dev/null; then
                fail "Syntax error: $jsfile"
                JS_OK=false
            fi
        fi
    done <<< "$JS_FILES"
    if $JS_OK; then
        pass "All staged .js files pass syntax check"
    fi
fi

# ── 6. Verify env vars use fail-fast pattern in staged JS ──
echo "▸ Env var safety"
if [ -n "$JS_FILES" ]; then
    FALLBACK_HITS=$(git diff --cached 2>/dev/null | grep -n "process\.env\." | grep -E "\|\|.*['\"]" | grep -iE "token|key|secret|password|passphrase" || true)
    if [ -n "$FALLBACK_HITS" ]; then
        fail "Credential env vars with fallback defaults (must fail-fast):"
        echo "$FALLBACK_HITS" | head -5 | while IFS= read -r line; do
            echo -e "    ${RED}$line${NC}"
        done
    else
        pass "No credential fallback patterns"
    fi
else
    pass "No JS files to check"
fi

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════"
echo -e "  Results: ${GREEN}${PASS} passed${NC}  ${RED}${FAIL} failed${NC}  ${YELLOW}${WARN} warnings${NC}"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
    echo -e "\n${RED}BLOCKED — fix failures before deploying.${NC}"
    exit 1
else
    echo -e "\n${GREEN}CLEAR — safe to proceed with deploy.${NC}"
    exit 0
fi
