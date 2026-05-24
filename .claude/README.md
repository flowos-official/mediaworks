# Claude Code Harness — mediaworks

This directory configures Claude Code for the mediaworks repo. Adapted from the SF 2026 / London 2026 conference patterns (`E:/Github/claude_video_summaries/templates/`) and customized for our stack (Next.js 16 + Supabase + Gemini + next-intl + chrome-devtools MCP).

## Layout

```
.claude/
├── README.md                    ← this file
├── settings.json                ← team-shared (committed)
├── settings.local.json          ← personal overrides (gitignored)
├── agents/                      ← subagents — explicit invocation
│   ├── code-reviewer.md         (Opus 4.7, xhigh)  — pre-commit review
│   ├── architect-advisor.md     (Opus 4.7, max)    — design forks / schema / RLS
│   └── explorer.md              (Sonnet 4.6, high) — codebase mapping, isolated context
├── skills/                      ← protocols followed by the main agent
│   ├── verify-feature.md        — post-feature self-check (uses chrome-devtools MCP)
│   └── report-platform-friction.md  — log environment/dep/external-API issues
├── commands/                    ← slash commands
│   ├── security-review.md       — /security-review, Opus 4.7 max
│   └── plan-prototype.md        — /plan-prototype, 3 parallel worktree prototypes
├── hooks/                       ← optional automation (not wired by default)
│   ├── README.md
│   ├── typecheck.ps1
│   └── check-claude-md.ps1
└── worktrees/                   ← active feature worktrees (gitignored or ephemeral)

../routines/                     ← cloud-hosted Routines (registered via /schedule)
├── daily-pr-digest.md
└── ci-autofix.md
```

## How to use each piece

### Subagents — spawn explicitly
Trigger phrases from the main session:
- "Spawn the **code-reviewer** subagent on `git diff main...HEAD`"
- "Get an **architect-advisor** critique on this approach"
- "Use the **explorer** subagent to map the discovery → strategy data flow"

Why split them out? Two reasons:
1. Heavy grep/read goes into the subagent's isolated context, so the main context stays clean (per SF 2026 "expanding toolkit" pattern).
2. Opus advisor on demand only — the executor stays on Sonnet by default. ~1/5 the cost of always-on Opus, comparable quality (SF 2026 GitHub session).

### Skills — automatically followed
- `verify-feature` fires when the user says "확인 좀 해줘" / "test it" / "verify" or right before a commit, and uses **chrome-devtools MCP** (per user preference) for any browser-level check.
- `report-platform-friction` fires the moment you see the same error twice or external-API drift.

### Slash commands
- `/security-review` — run before any merge that touches `app/api/**`, `lib/auth/**`, RLS, or external APIs. Max-effort Opus pass.
- `/plan-prototype <feature>` — when there's a real design fork. Spins up 3 worktrees in `.claude/worktrees/`, dispatches 3 subagents in parallel, prints a comparison table.

### Hooks
Off by default. See `hooks/README.md` to enable typecheck-on-Stop or commit-time CLAUDE.md reminder.

### Routines (cloud-hosted)
Register via the `/schedule` command in Claude Code:
```
/schedule "Every weekday 09:00 KST, follow routines/daily-pr-digest.md"
/schedule webhook:github-check-failed "Follow routines/ci-autofix.md"
```
Both have safety rails: no push to `main`, no force push, hard cost caps per run, and explicit skip lists (auth / migrations / cron files stay manual).

## What was deliberately NOT adopted from the templates

| Template piece | Why skipped |
|---|---|
| Week 2 prompt caching audit | The product uses Gemini for LLM features, not the Anthropic API. Caching audit doesn't apply at the product layer. |
| Week 3 Sonnet executor + Opus advisor at runtime | Same reason — no Anthropic agent loop inside the product. Adopted at the **dev tooling** layer instead (architect-advisor agent). |
| `[auth.email]` config workaround | Already in project memory: top-level `[auth].enable_signup` is the correct key. |
| Playwright MCP for verification | User preference is chrome-devtools MCP. `verify-feature.md` is wired accordingly. |

## Maintenance
- Add new anti-patterns to `CLAUDE.md` as they recur (rule: twice = document).
- Update agent definitions when a recurring code-reviewer comment becomes a stable rule.
- Routines self-improve by appending to `routines/LEARNINGS-*.md`.
- Reread this `README.md` every ~3 months — model capability / pricing shifts may invalidate some choices.

## Reference docs
- Full conference notes & roadmap: `E:/Github/claude_video_summaries/templates/docs/`
- Original templates source: `E:/Github/claude_video_summaries/templates/`
