# Runs `npx tsc --noEmit` quickly.
# Intended as a Stop hook so it fires once per task, not on every Edit.
# To enable, add to .claude/settings.json:
#   "hooks": { "Stop": [{ "command": "powershell -File .claude/hooks/typecheck.ps1" }] }

$ErrorActionPreference = "Continue"
$startedAt = Get-Date

Push-Location $PSScriptRoot/../..
try {
    $out = & npx tsc --noEmit 2>&1
    $exit = $LASTEXITCODE
} finally {
    Pop-Location
}

$elapsed = [int]((Get-Date) - $startedAt).TotalSeconds

if ($exit -eq 0) {
    Write-Host "[typecheck hook] tsc passed in ${elapsed}s"
    exit 0
} else {
    Write-Host "[typecheck hook] tsc FAILED in ${elapsed}s"
    Write-Host $out
    # Non-zero exit = surface failure to Claude Code transcript
    exit 1
}
