# Deploy Moby Changes

Pre-deploy checklist for pushing changes to the Moby repo.

## Steps

1. **Stage explicitly**: `git add <file1> <file2>` — NEVER `git add -A` or `git add .`
2. **Run validation**: `bash .claude/scripts/validate-deploy.sh` — must exit 0 (no failures). This checks .gitignore, scans for secrets, verifies no .env/data/trade files staged, runs Node.js syntax checks, and catches credential fallback patterns. **Do not proceed if it fails.**
3. **Show diff**: `git diff --cached` — review every staged line with human
4. **Commit**: descriptive message referencing what changed and why
5. **Push**: `git push origin main`
6. **Restart affected processes** via systemctl:
   - `systemctl --user restart moby-dashboard`
   - `systemctl --user restart moby-scanner`
   - `systemctl --user restart moby-exit-monitor`
   - `systemctl --user restart moby-shadow-tracker`
7. **Verify**: check dashboard loads, check scanner/exit-monitor logs

## Rollback
```bash
git log --oneline -5
git revert HEAD
systemctl --user restart moby-scanner moby-exit-monitor moby-dashboard
```
