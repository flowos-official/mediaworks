---
description: Build 3 prototype branches in parallel git worktrees for the same feature, then compare. Use when there's a real design fork — not for trivial work.
---

# /plan-prototype

Build the same feature 3 different ways across 3 git worktrees, in parallel. Compare them, then the user picks one. SF 2026 pattern: prefer working prototypes over design docs.

## Usage
```
/plan-prototype <feature description>
```

Example:
```
/plan-prototype QVC m3u8 video archive PoC: ffmpeg direct copy vs HLS-to-MP4 transmux vs serverless lambda
```

## When this is worth the overhead
- Architectural fork the team can't decide on paper.
- "Buy vs build" — external lib vs hand-roll.
- New abstraction whose shape is ambiguous.
- Cross-cutting change that could land in several layers (e.g., discovery scoring rewrite, strategy pool join refactor).

## When NOT to use
- Sub-30-minute tasks (overhead > value).
- One obviously-correct answer.
- Security / migration work (prototypes are misleading here).

## Steps

### 1. Enter plan mode (read-only)
Spawn `explorer` to map the relevant area first:
- existing patterns it would touch
- existing helpers that could be reused or bypassed
- known constraints (RLS, registry split, etc.)

Then sketch 3 *meaningfully different* approaches. If two are barely different, you only have 2 prototypes — say so and stop.

### 2. Create 3 worktrees under `.claude/worktrees/`
```bash
git worktree add .claude/worktrees/proto-A -b proto/<feature>-A
git worktree add .claude/worktrees/proto-B -b proto/<feature>-B
git worktree add .claude/worktrees/proto-C -b proto/<feature>-C
```

(mediaworks already uses `.claude/worktrees/` — keep prototypes there too.)

### 3. Dispatch 3 subagents in parallel
- Subagent A (Opus 4.7): the "canonical" approach — most consistent with existing patterns.
- Subagent B (Sonnet 4.6): external-library or platform-feature approach.
- Subagent C (Sonnet 4.6): minimal / "what's the smallest possible version" approach.

Give each subagent:
- The feature spec (one paragraph).
- The constraint list from step 1 (RLS, registry split, soft-penalty rule, etc.).
- A budget: "≤2 hours / ≤30k output tokens. Happy path + 1-2 tests + a README with 5-bullet tradeoff. Skip production polish."

### 4. Each prototype must include
- Happy path runs locally (`npm run dev` + a manual click-through or a test).
- One or two core tests.
- A `README.md` at the worktree root with:
  - Approach summary (3 lines)
  - 5-bullet tradeoff list
  - LoC added / dependencies added / files touched
- Open as a **draft** PR.

### 5. Compare
Print a comparison table:

```
| Axis              | A          | B          | C          |
|-------------------|------------|------------|------------|
| LoC               | 320        | 80         | 60         |
| New deps          | 0          | 1 (bullmq) | 0          |
| Tests             | passing    | passing    | partial    |
| Ops complexity    | medium     | low        | high       |
| Reversibility     | easy       | hard       | trivial    |
| Tradeoff (1-line) | …          | …          | …          |
```

### 6. Hand off to user
- Don't pick a winner — let the user pick.
- Suggest a default ("I lean toward B because …") but make it clear it's a recommendation.

### 7. Cleanup (after user decides)
```bash
git worktree remove .claude/worktrees/proto-A  # losing branches
gh pr close <number-of-rejected> --delete-branch
# winning branch: keep the worktree, polish it, open a real PR
```

## Hard rules
- Don't make all 3 prototypes secretly look the same. Meaningful variance is the whole point.
- Don't grade your own favorite higher. Score on axes, not vibes.
- Don't polish all 3 to production quality. That defeats the speed argument.
