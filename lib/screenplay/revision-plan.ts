// lib/screenplay/revision-plan.ts
// Analysis-driven revision plan. PURE w.r.t. the LLM: the synthesis model call
// is injected as `callLLM`, so this module is unit-testable with a fake. The
// route passes the real Gemini caller. Deterministic fallback keeps the plan
// step working even when the LLM is unavailable (e.g. zero-quota local key).
//
// Do NOT `import "server-only"` here — a tsx smoke imports this module directly.

import type { ProductBrief } from "./types";
import type { Finding, ScriptCheckResult } from "./compliance/types";

export type LlmCall = (prompt: string) => Promise<string>;

export interface RevisionPlanItem {
	axis: "legal" | "facts" | "quality";
	severity: "high" | "med" | "low";
	target: string;       // verbatim JP quote when possible; a location description for structural items.
	instruction: string;  // JP: 何を・なぜ・どう直すか. NO axis prefix (compose owns the label).
}
export interface RevisionPlan { items: RevisionPlanItem[] }

const MARKDOWN_SLICE = 12000;
const AXES: RevisionPlanItem["axis"][] = ["legal", "facts", "quality"];
const SEVS: RevisionPlanItem["severity"][] = ["high", "med", "low"];

// Tolerant JSON extraction — mirror of check.ts::parseJSON (code-fence / prose
// wrapping tolerated, balanced-brace scan).
function parseJSON<T>(raw: string): T {
	let c = raw.trim();
	const fence = c.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fence) c = fence[1].trim();
	const start = c.indexOf("{");
	if (start === -1) throw new Error("No JSON object found");
	let depth = 0, inStr = false, esc = false, end = -1;
	for (let i = start; i < c.length; i++) {
		const ch = c[i];
		if (esc) { esc = false; continue; }
		if (ch === "\\") { esc = true; continue; }
		if (ch === '"') { inStr = !inStr; continue; }
		if (inStr) continue;
		if (ch === "{") depth++;
		else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
	}
	if (end === -1) throw new Error("Unbalanced JSON");
	return JSON.parse(c.slice(start, end + 1)) as T;
}

function coerceItem(raw: unknown): RevisionPlanItem | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const axis = AXES.includes(r.axis as RevisionPlanItem["axis"]) ? (r.axis as RevisionPlanItem["axis"]) : null;
	if (!axis) return null;
	const severity = SEVS.includes(r.severity as RevisionPlanItem["severity"]) ? (r.severity as RevisionPlanItem["severity"]) : "med";
	const target = String(r.target ?? "").trim().slice(0, 300);
	const instruction = String(r.instruction ?? "").trim().slice(0, 300);
	if (!instruction && !target) return null;
	return { axis, severity, target, instruction };
}

// Deterministic fallback: build straight from findings. NO axis prefix on
// instruction — the compose step (composeRefineFeedback) owns the label, so a
// prefix here would double-label.
export function fallbackPlan(check: ScriptCheckResult): RevisionPlan {
	const all: Finding[] = [...check.legal, ...check.facts, ...check.quality];
	const items: RevisionPlanItem[] = [];
	for (const f of all) {
		const target = (f.quote || "").trim().slice(0, 300);
		const instruction = (f.suggestedRewrite || f.reason || "").trim().slice(0, 300);
		if (!target && !instruction) continue;
		items.push({ axis: f.axis, severity: f.severity, target, instruction });
	}
	return { items };
}

function buildPrompt(markdown: string, brief: ProductBrief, check: ScriptCheckResult): string {
	const line = (f: Finding) =>
		`- [${f.axis}/${f.severity}] quote: ${JSON.stringify(f.quote)} | reason: ${f.reason} | suggestedRewrite: ${f.suggestedRewrite}`;
	const findings = [...check.legal, ...check.facts, ...check.quality].map(line).join("\n") || "(none)";
	return `You are a Japanese TV-shopping ("考査") reviewer. Synthesize the compliance findings below into a concise, DE-DUPLICATED, prioritized revision plan for the script. Merge near-duplicate findings across axes. For quality-axis findings, turn them into concrete structural directives (e.g. move a section). Output PURE JSON only — no markdown, no prose.

The plan drives a JAPANESE script regeneration, so every "instruction" and "target" MUST be written in Japanese. Do NOT prefix "instruction" with the axis. Keep each item short and actionable. Use a verbatim quote from the script for "target" when the finding points at specific text; for a structural change, put a brief location description in "target".

Product: ${brief.name} / category: ${brief.category ?? "(unknown)"}
Score: ${check.overallScore}/100
Findings:
${findings}

Script (truncated):
${markdown.slice(0, MARKDOWN_SLICE)}

Output exactly this shape:
{"items":[{"axis":"legal|facts|quality","severity":"high|med|low","target":"...","instruction":"..."}]}`;
}

export async function buildRevisionPlan(
	markdown: string,
	brief: ProductBrief,
	check: ScriptCheckResult,
	callLLM: LlmCall,
): Promise<RevisionPlan> {
	const findingCount = check.legal.length + check.facts.length + check.quality.length;
	if (findingCount === 0) return { items: [] };
	try {
		const raw = await callLLM(buildPrompt(markdown, brief, check));
		const parsed = parseJSON<{ items?: unknown[] }>(raw);
		const items = (parsed.items ?? []).map(coerceItem).filter((x): x is RevisionPlanItem => x !== null);
		if (items.length === 0) return fallbackPlan(check);
		return { items };
	} catch (err) {
		console.warn("[revision-plan] LLM synthesis failed, using deterministic fallback:", err instanceof Error ? err.message : String(err));
		return fallbackPlan(check);
	}
}
