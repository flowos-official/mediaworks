# PreToolUse hook for `git commit`. Reminds you to review CLAUDE.md when
# anything under lib/auth, lib/strategy, lib/discovery, lib/broadcasts,
# or supabase/migrations was touched in the staged set — those areas have
# project memory commitments documented in CLAUDE.md.
#
# To enable, add to .claude/settings.json:
#   "hooks": {
#     "PreToolUse": [
#       { "matcher": "Bash(git:commit:*)", "command": "powershell -File .claude/hooks/check-claude-md.ps1" }
#     ]
#   }

$ErrorActionPreference = "Continue"

Push-Location $PSScriptRoot/../..
try {
    $staged = & git diff --cached --name-only 2>$null
} finally {
    Pop-Location
}

if (-not $staged) { exit 0 }

$sensitivePrefixes = @(
    "lib/auth/",
    "lib/strategy/",
    "lib/discovery/",
    "lib/broadcasts/",
    "lib/selections/",
    "lib/workflows/",
    "lib/supabase/",
    "supabase/migrations/",
    "app/api/cron/"
)

$touched = $staged | Where-Object {
    $f = $_
    $sensitivePrefixes | Where-Object { $f.StartsWith($_) }
}

if ($touched) {
    Write-Host "[check-claude-md] Sensitive areas touched. Verify CLAUDE.md is still accurate:"
    $touched | ForEach-Object { Write-Host "  - $_" }
    Write-Host ""
    Write-Host "Hit Enter in Claude Code to continue if CLAUDE.md is up to date."
    # Exit 0 = informational warning only, doesn't block the commit.
    # Change to exit 2 to block until acknowledged.
}

exit 0
