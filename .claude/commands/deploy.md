# Deploy Moby Changes

Pre-deploy checklist for pushing changes to the Moby repo.

## Steps

1. **Show diff**: `git diff` — review every changed line
2. **Security scan**: `git diff --cached | grep -i "token\|key\|secret\|password\|private"` — must be clean
3. **Syntax check**: `node --check <changed-files>` — verify no parse errors
4. **Verify .gitignore**: confirm `.env`, `data/`, `*.jsonl`, `*.log`, `node_modules/` are listed
5. **Stage explicitly**: `git add <file1> <file2>` — NEVER `git add -A` or `git add .`
6. **Commit**: descriptive message referencing what changed and why
7. **Push**: `git push origin main`
8. **Restart affected processes** via systemctl:
   - `systemctl --user restart moby-dashboard`
   - `systemctl --user restart moby-scanner`
   - `systemctl --user restart moby-exit-monitor`
   - `systemctl --user restart moby-shadow-tracker`
9. **Verify**: check dashboard loads, check scanner/exit-monitor logs

## Rollback
```bash
git log --oneline -5
git revert HEAD
systemctl --user restart moby-scanner moby-exit-monitor moby-dashboard
```
