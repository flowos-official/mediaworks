import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWED = new Set([
  "lib/strategy/intent-projection.ts",
  "lib/md-strategy.ts",
  "lib/live-commerce-strategy.ts",
]);

const PATTERNS = [/\brunGoalAnalysis\s*\(/, /\brunLCGoalAnalysis\s*\(/];

function isTestScript(path: string): boolean {
  return path.startsWith("scripts/test-");
}

const files = execSync("git ls-files *.ts *.tsx", { encoding: "utf8" })
  .split(/\r?\n/)
  .filter((p) => p.length > 0)
  .map((p) => p.replace(/\\/g, "/"));

const violators: string[] = [];

for (const path of files) {
  if (ALLOWED.has(path)) continue;
  if (isTestScript(path)) continue;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  if (PATTERNS.some((re) => re.test(content))) {
    violators.push(path);
  }
}

if (violators.length > 0) {
  console.error(
    "ERROR: runGoalAnalysis or runLCGoalAnalysis is called outside the chokepoint:",
  );
  for (const v of violators) console.error("  " + v);
  console.error(
    "\nRoute through projectParsedGoalToIntent() / analyzeGoalToIntent() / analyzeLCGoalToIntent() instead. See spec §9-1.",
  );
  process.exit(1);
}

console.log("✓ runGoalAnalysis chokepoint enforced");
