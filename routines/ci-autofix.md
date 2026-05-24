# Routine: CI Auto-fix (mediaworks)

> Cloud-hosted Routine. Triggered by a GitHub `check_run.completed` webhook on a failing run, classifies the failure, and auto-fixes the safe categories.

## Register
1. Generate a webhook endpoint in the Claude Code console (Routines → Webhook).
2. GitHub repo → Settings → Webhooks → Add:
   - Payload URL: the Routine webhook endpoint.
   - Events: `Check runs`, `Pull requests`.
   - Secret: `${GITHUB_WEBHOOK_SECRET}` (also set in Routine env).
3. Register the Routine:
   ```
   /schedule webhook:github-check-failed "When a GitHub Check fails on a mediaworks PR, follow routines/ci-autofix.md. Permissions: GitHub read + write to PR branches only. Never push to main, never force-push to main."
   ```

## Trigger conditions
All of:
- `check_run.conclusion === "failure"`
- PR is not draft
- PR author is not a bot (`vercel[bot]`, `dependabot[bot]`, etc.)
- Same commit has not already been auto-fixed in this Routine

## Steps

### 1. Classify the failure (Haiku 4.5, low effort)
Read the failing job log via `gh run view <run-id> --log-failed`. Map to one of:
- `flaky` — same code passes on rerun
- `lint` — auto-fixable style issue
- `typecheck` — `tsc --noEmit` failure (often a missing type)
- `merge_conflict` — rebase against main required
- `test_logic` — actual test failure (likely a real bug)
- `dep` — lockfile / version conflict
- `infra` — CI runner / network glitch

### 2. Act by category

#### flaky / infra
- Rerun once: `gh run rerun <run-id>`.
- 3rd repeat on the same test → log to `routines/LEARNINGS-flaky.md` and ping the owner. Don't keep retrying forever.

#### lint
In an isolated worktree:
```bash
git worktree add ../fix-lint-<pr> <pr-branch>
cd ../fix-lint-<pr>
npm run lint -- --fix
git commit -am "chore: auto-lint via ci-autofix"
git push origin <pr-branch>
git worktree remove ../fix-lint-<pr>
```
Comment on the PR: "Auto-fixed lint. CI re-running."

#### typecheck
- Switch to Opus 4.7 for the analysis.
- If the fix is a missing type / obvious narrowing → apply, commit, push.
- If it requires real refactor → comment with the hypothesis + the failing snippet, ping author.

#### merge_conflict
- Attempt `git fetch origin main && git rebase origin/main` in a worktree.
- Pure text conflict → resolve.
- Semantic conflict (auth.ts, RLS migrations, registry files) → **call architect-advisor**, do NOT auto-merge.
- On success, push to the PR branch only. **Never** to main, **never** `--force` to main.

#### test_logic
- **Do not auto-fix.** Likely a real bug.
- Read the failure, form a hypothesis, comment with: failing test name + suspected root cause + which file to inspect. Tag the author.

#### dep
- Lockfile conflict only → regenerate (`rm package-lock.json && npm install`), commit, push.
- Semver-major upgrade → don't auto-bump. Comment + ping.

### 3. Report on the PR
Comment (edit in place across reruns):
```
🤖 CI Auto-fix
- Failure category: <category>
- Action: <auto-fixed | analyzed | escalated>
- Status: <re-running | needs human>
- ETA: <minutes or n/a>
[Run logs](<url>)
```

### 4. Self-improve
Per run, append to `routines/LEARNINGS-ci-autofix.md`:
- category, action, success?, time-to-green
- Any new failure pattern observed

## Safety rails
- Same PR hits this Routine ≥5 times in 24h → halt, ping the owner. Likely a loop.
- Never push to `main`. Never `--force` to `main`. Never `git reset --hard` on a branch that isn't a fresh worktree.
- Never `git clean -f` outside an isolated worktree.
- Cost cap: 100k tokens per PR. Above that → stop, ping.

## Metrics to surface monthly
- Auto-fix success rate per category.
- Median time from CI red → CI green.
- Human-escalation rate.

## What this Routine deliberately won't do
- Touch security-relevant files (`lib/auth/**`, `supabase/migrations/**`, anything under `app/api/cron/**`) — those go straight to a human.
- Push to a branch matching `^main$|^release/.+`.
- Modify `package.json` (only `package-lock.json` regeneration is in scope).
