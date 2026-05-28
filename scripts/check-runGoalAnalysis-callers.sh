#!/usr/bin/env bash
set -euo pipefail

# Single chokepoint enforcement — runGoalAnalysis may only be called from
# lib/strategy/intent-projection.ts (which then projects the result to
# DiscoverIntent under the feature flag). Any other usage = leaked flag.
#
# Exemptions:
#   - lib/strategy/intent-projection.ts  → the chokepoint itself
#   - lib/md-strategy.ts                 → defines runGoalAnalysis
#   - lib/live-commerce-strategy.ts      → defines runLCGoalAnalysis
#   - scripts/test-*.ts                  → test scripts may call directly
#     to verify the underlying function's behavior (e.g. prompt flag gating).
#     Behavioral integration tests should go through the helper instead.

ALLOWED_FILE="lib/strategy/intent-projection.ts"
DEFINING_FILE_MD="lib/md-strategy.ts"
DEFINING_FILE_LC="lib/live-commerce-strategy.ts"

# Use git ls-files to scope the search to tracked files
VIOLATORS=$(git ls-files '*.ts' '*.tsx' \
  | grep -v "^$ALLOWED_FILE\$" \
  | grep -v "^$DEFINING_FILE_MD\$" \
  | grep -v "^$DEFINING_FILE_LC\$" \
  | grep -v "^scripts/test-" \
  | xargs grep -l "runGoalAnalysis(\|runLCGoalAnalysis(" 2>/dev/null || true)

if [[ -n "$VIOLATORS" ]]; then
  echo "ERROR: runGoalAnalysis or runLCGoalAnalysis is called outside lib/strategy/intent-projection.ts:"
  echo "$VIOLATORS"
  echo ""
  echo "Route through projectParsedGoalToIntent() / analyzeGoalToIntent() / analyzeLCGoalToIntent() instead. See spec §9-1."
  exit 1
fi

echo "✓ runGoalAnalysis chokepoint enforced"
