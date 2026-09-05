/**
 * One entry point, statically enforced.
 *
 * There used to be three ways to produce a screenplay version: the create
 * route, the refine route, and complete-recommendation-flow.ts, which called
 * generateScreenplay directly and inserted the row itself. That third row sat
 * in screenplay_versions next to the others and was not the same thing — no
 * compliance check, no remediation, and now no generation context, no
 * knowledge snapshot and no claim links — with nothing on the row saying so.
 *
 * A static check is the right shape here: the failure is not a crash, it is a
 * row that looks legitimate.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Comments describe the rule; they must not satisfy it. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.tsx?$/.test(path)) out.push(path);
	}
	return out;
}

const files = ["lib", "app", "scripts", "components"].flatMap((dir) => walk(dir));

// --- generateScreenplay has exactly one production caller ------------------
{
	const ALLOWED = new Set([
		"lib/screenplay/generator.ts", // where it is defined
		"lib/workflows/screenplay.workflow.ts", // the only caller
		"scripts/test-screenplay-generator.ts", // exercises the generator itself
		"scripts/test-screenplay-unified-entry.ts", // this file
	]);
	const callers = files.filter((file) => {
		if (ALLOWED.has(file)) return false;
		return /\bgenerateScreenplay\s*\(/.test(stripComments(readFileSync(file, "utf8")));
	});
	assert.deepEqual(
		callers,
		[],
		`generateScreenplay must only be called by the workflow. Callers outside it produce versions with no compliance check, no generation context and no claim links: ${callers.join(", ")}`,
	);
}
console.log("✓ generateScreenplay is called only by the workflow");

// --- every entry point goes through startScreenplayGeneration -------------
{
	const ENTRY_FILES = [
		"app/api/screenplays/route.ts",
		"app/api/screenplays/[id]/refine/route.ts",
		"scripts/complete-recommendation-flow.ts",
	];
	for (const file of ENTRY_FILES) {
		const source = stripComments(readFileSync(file, "utf8"));
		assert.ok(
			/startScreenplayGeneration|startScreenplayImport/.test(source),
			`${file} must start generation through the shared entry`,
		);
		assert.equal(
			/\bstart\s*\(\s*screenplayWorkflow/.test(source),
			false,
			`${file} must not call the workflow directly — the invariants live in startScreenplayGeneration`,
		);
	}
}
console.log("✓ every entry point starts generation through one service");

// --- the workflow builds its context before it drafts ----------------------
{
	const workflow = stripComments(readFileSync("lib/workflows/screenplay.workflow.ts", "utf8"));
	const contextAt = workflow.indexOf("buildContextStep(");
	const generateAt = workflow.indexOf("generateStep(");
	assert.ok(contextAt > 0, "the workflow must build a generation context");
	assert.ok(generateAt > 0);
	assert.ok(
		contextAt < generateAt,
		"the context must be persisted BEFORE drafting — otherwise a failed generation leaves no account of what it was about to write from",
	);
	assert.ok(
		/generation_context_id: generationContextId/.test(workflow),
		"the version must record which context produced it",
	);
	// The old path resolved five different pattern absences to a console line.
	assert.equal(
		/loadPatternStep/.test(workflow),
		false,
		"loadPatternStep is replaced by the context's explicit pattern status",
	);
}
console.log("✓ the workflow persists its context before it drafts");

// --- the run id is minted where replay cannot see it ----------------------
// A workflow body is replayed on retry, so a randomUUID() inside it would
// produce a different id each time and break determinism; a value derived from
// the screenplay would collide on the second refine, since the context and its
// knowledge snapshot are both unique on it.
{
	const workflow = stripComments(readFileSync("lib/workflows/screenplay.workflow.ts", "utf8"));
	assert.equal(
		/randomUUID|Math\.random|Date\.now/.test(workflow.slice(workflow.indexOf('"use workflow"'))),
		false,
		"the workflow body must stay deterministic",
	);
	const entry = stripComments(readFileSync("lib/screenplay/start-generation.ts", "utf8"));
	assert.ok(/randomUUID\(\)/.test(entry), "the entry service mints the run id");
}
console.log("✓ the run id is minted outside the replayed workflow body");

// --- the refine invariants are enforced in one place ----------------------
async function invariants(): Promise<void> {
	const { startScreenplayGeneration, ScreenplayStartError } = await import(
		"../lib/screenplay/start-generation"
	);
	const brief = { name: "x", description: "y" };
	const cases: Array<[string, Record<string, unknown>]> = [
		["missing_base_version", { screenplayId: "s", mode: "refine", productBrief: brief, canonicalProductId: null, feedback: "f" }],
		["missing_feedback", { screenplayId: "s", mode: "refine", productBrief: brief, canonicalProductId: null, baseVersionId: "v" }],
		["unexpected_base_version", { screenplayId: "s", mode: "initial", productBrief: brief, canonicalProductId: null, baseVersionId: "v" }],
		["missing_screenplay", { screenplayId: "", mode: "initial", productBrief: brief, canonicalProductId: null }],
	];
	for (const [code, input] of cases) {
		await assert.rejects(
			startScreenplayGeneration(input as never),
			(error: unknown) => error instanceof ScreenplayStartError && error.code === code,
			`expected ${code}`,
		);
	}
	console.log("\u2713 the refine invariants are checked once, for every caller");
	console.log("PASS: screenplay unified entry");
}

invariants().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
