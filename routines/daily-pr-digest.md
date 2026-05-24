# Routine: Daily PR Digest (mediaworks)

> Cloud-hosted Claude Code Routine. Fires every weekday morning, summarizes yesterday's PR activity, posts to the team channel.

## Register
This Routine lives on Anthropic's cloud. Register once via Claude Code:

```
/schedule "Every weekday at 09:00 KST (00:00 UTC), summarize yesterday's mediaworks PR activity and post to the team channel. Follow routines/daily-pr-digest.md."
```

If posting to a chat channel: set up a Slack / Discord / Linear MCP connection in Claude Code settings first. If no chat integration: write the digest to `docs/pr-digests/<YYYY-MM-DD>.md` instead and the team reads it on demand.

## Required tooling
- `gh` CLI authenticated against the mediaworks repo (read).
- One destination: Slack MCP / Discord MCP / Linear MCP — OR file output to `docs/pr-digests/`.

## Execution
- Host: Anthropic cloud (no need to keep the laptop awake).
- Model: Sonnet 4.6.
- Advisor: Opus 4.7 (called only if a PR description is ambiguous and needs interpretation).
- Permissions: GitHub read-only, write to the chosen output destination only.

## Categories to track
- Merged into `main` yesterday (00:00 → 24:00 KST).
- Opened yesterday.
- Open + no review for ≥1 day.
- Open + CI failing.

## Steps

### 1. Pull data
```bash
YESTERDAY=$(date -d 'yesterday' -u +%Y-%m-%d)

gh pr list --state merged \
  --search "merged:>=$YESTERDAY" \
  --json number,title,author,additions,deletions,mergedAt,labels

gh pr list --state open \
  --search "created:>=$YESTERDAY" \
  --json number,title,author,labels,isDraft

gh pr list --state open \
  --search "updated:<$YESTERDAY review:none -is:draft" \
  --json number,title,author

gh pr list --state open --search "status:failure" \
  --json number,title,author
```

### 2. Summarize
- Bucket merged PRs by inferred type (feature / bugfix / refactor / docs / chore) using the title + labels.
- Highlight any PR with >500 LoC.
- @-mention owner on stale-review and CI-failing PRs.

### 3. Post the digest
Format:
```
📊 mediaworks PR Digest (2026-05-22)

Merged (N)
• #1234 feat: <title> (@author, +320/-12)
• #1235 fix: <title> (@author, +45/-30)
…

Opened (N)
• #1240 (WIP): <title> (@author)
…

⚠ Needs attention
• #1232 — no review for 1 day — @author
• #1238 — CI failing 3× — @author
```

### 4. Self-audit
- Did this run skip any PR that should've been included (draft → merged, force-pushed, etc.)?
- Append findings to `routines/LEARNINGS.md`.

## Failure handling
- GitHub rate-limit → exponential backoff up to 3 attempts, then skip the run with a logged note.
- Post failure → save the digest to `docs/pr-digests/<date>.md` so the next day's run can include yesterday's missed output.
- Token budget exceeded → tighten the per-PR summary, retry once.

## Cost cap
Per run: 30k input + 5k output tokens, hard stop above.

## v2 ideas (not now)
- Median review-response time per author.
- Strategy/Discovery/Broadcasts area split.
- Tie PRs back to `docs/superpowers/plans/` to show plan-to-PR completion rate.
