---
name: report-platform-friction
description: When you hit environment / platform / dependency friction in mediaworks (same error twice, dep conflict, docs-vs-reality mismatch), file a structured report instead of silently working around it. SF 2026 "wtf" pattern.
---

# Report Platform Friction (mediaworks)

Use the moment you notice:
- Same error twice in the same session
- Dependency conflict, build failure, flaky test
- External-API response doesn't match docs (Gemini, Brave, Rakuten, Supabase, QVC scrape, ShopCh scrape)
- Local works, deploy doesn't (or vice versa)
- A tool with side effects you didn't ask for (e.g., lint auto-modified an unrelated file)

The point is not to escalate — it's to **leave a paper trail** so the next agent or human can act on it.

## Steps

### 1. Reproduction
```
1. cd E:/Github/mediaworks
2. <exact command>
→ <exact error / stderr>
```

### 2. Expected vs Actual
- Expected: (one line)
- Actual: (concrete output, paste error)

### 3. Impact scope
- Files: concrete paths
- Who's affected: me only / anyone on the team / cron in prod / Vercel build
- Workaround: yes / no — if yes, the workaround

### 4. Hypothesis (with confidence)
- Most likely cause: ... (confidence: high / medium / low)
- How to verify the hypothesis (grep, log, repro variant)

### 5. File the report
Pick the most appropriate destination (don't multi-post):
- **mediaworks bug** → `gh issue create --label "platform-friction"` against `mediaworks` repo
- **Vercel / Supabase / external API issue** → write to `docs/platform-friction/<YYYY-MM-DD>-<slug>.md` so it's captured even if no one is on call to triage
- **One-off recoverable error** → no issue needed; note it in your verification report so the user sees it once

Then tell the main agent in one line:
> "Filed friction report: `<location>`. Workaround applied / Blocked — see report."

## Workaround policy
- Workaround exists → apply it, file the report, mention the workaround in the verification result.
- No workaround → stop the task, surface to user with the hypothesis + repro.
- Never repeat the same error 3+ times hoping it'll resolve itself.

## Output format
```
## Platform friction report

**Title**: [one line]
**Severity**: blocker / major / minor

### Reproduction
1. ...
2. ...

### Expected vs Actual
- Expected: ...
- Actual: ...

### Impact
- Files: ...
- Scope: me / team / cron / build
- Workaround: yes/no (details)

### Hypothesis
- Most likely cause: ... (confidence)
- Verification: ...

### Filed to
- <location>
```

## Hard rules
- No vague "feels weird" reports — always concrete reproduction.
- Don't ping the user 3 times in a row for the same friction. File once, work around, surface in the final report.
- Don't silently swallow friction. The cost of one extra report is small; the cost of a hidden flake compounding for a week is large.
