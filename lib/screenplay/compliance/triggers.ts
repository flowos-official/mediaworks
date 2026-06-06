// lib/screenplay/compliance/triggers.ts
// Pure predicates that drive the auto-remediation loop. Importing this never
// pulls the DB/Gemini chain (only ./types), so it stays unit-testable and cheap.

import type { Finding, ScriptCheckResult } from "./types";

/** A finding worth auto-remediating: any legal/facts finding at "high" severity,
 *  OR any deterministic lexicon NG (rule-certain regardless of severity). Quality
 *  findings (structural advisories) never trigger. */
function isRemediable(f: Finding): boolean {
  return f.severity === "high" || f.source === "lexicon";
}

export function remediableFindings(result: ScriptCheckResult): Finding[] {
  return [...result.legal, ...result.facts];
}

export function hasHighViolation(result: ScriptCheckResult): boolean {
  return remediableFindings(result).some(isRemediable);
}

export function countHigh(result: ScriptCheckResult): number {
  return remediableFindings(result).filter(isRemediable).length;
}
