# .claude/hooks/

Optional automation hooks for Claude Code. **Nothing here is wired in by default** — opt in by adding the relevant entry to `.claude/settings.json` `hooks` section.

## Available

### `typecheck.ps1`
Runs `npx tsc --noEmit` and surfaces failures to the transcript. Intended as a `Stop` hook (fires once per task) — running it on every `Edit` is too slow.

Enable:
```json
"hooks": {
  "Stop": [
    { "command": "powershell -File .claude/hooks/typecheck.ps1" }
  ]
}
```

### `check-claude-md.ps1`
Pre-commit warning when sensitive areas (auth, strategy, discovery, broadcasts, supabase/migrations, cron) are staged. Reminds you to re-read CLAUDE.md before committing because those areas have project-memory commitments.

Enable:
```json
"hooks": {
  "PreToolUse": [
    {
      "matcher": "Bash(git:commit:*)",
      "command": "powershell -File .claude/hooks/check-claude-md.ps1"
    }
  ]
}
```

Default exits 0 (warning only). Change to `exit 2` inside the script to make it blocking.

## Notes on Windows
These hooks are PowerShell because the project runs on Windows + PowerShell as the primary shell. Git Bash also works — adapt to `.sh` if you prefer.
