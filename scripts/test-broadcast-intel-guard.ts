/**
 * broadcast_transcripts holds verbatim competitor broadcast text. It exists for
 * verification and re-analysis, and must never be wired into a prompt, an API
 * response or the UI. This test fails if the table name appears anywhere
 * outside the allowlist, so that wiring has to be a deliberate, reviewed edit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const ALLOWED = [
	"supabase/migrations/20260825090000_broadcast_speech_analyses.sql",
	"lib/broadcast-intel/persist.ts",
	"scripts/test-broadcast-intel-guard.ts",
	"scripts/test-broadcast-intel-live.ts",
	// Names the table only to say what must NOT cross into evidence_items: it
	// pins the evidence predicate whitelist so the verbatim half stays here.
	"scripts/test-intelligence-evidence-predicates.ts",
	"scripts/check-migrations.ts",
	// Reads the verbatim table to ask ONE local question: does our own output
	// contain a 30+ character run of a competitor's? Nothing read here reaches
	// a prompt, an API response or the UI — what is reported is the offending
	// passage OF OUR SCRIPT, which the operator is already looking at.
	"lib/screenplay/grounding/copy-guard.ts",
	// Documentation, like the two spec/plan entries below: names the table to
	// state the rule about it. The design docs were already allowlisted for the
	// same reason.
	"CLAUDE.md",
	"docs/superpowers/specs/2026-08-24-broadcast-selling-language-design.md",
	"docs/superpowers/plans/2026-08-24-broadcast-selling-language.md",
];

async function main(): Promise<void> {
	let out = "";
	try {
		out = execFileSync("git", ["grep", "-l", "broadcast_transcripts", "--", ".", ":!node_modules"], {
			encoding: "utf-8",
		});
	} catch (err) {
		// git grep exits 1 when there are no matches; treat only that as zero hits.
		// Any other error (not a git repo, binary missing, etc.) should fail loud.
		if (err instanceof Error && "status" in err && err.status === 1) {
			out = "";
		} else {
			throw err;
		}
	}

	const hits = out.split("\n").map((s) => s.trim()).filter(Boolean);
	const unexpected = hits.filter((f) => !ALLOWED.includes(f));
	assert.deepEqual(
		unexpected,
		[],
		`broadcast_transcripts referenced outside the allowlist:\n  ${unexpected.join("\n  ")}\n` +
			"If this is intentional, add the file to ALLOWED and say why in the commit message.",
	);

	console.log(`PASS: broadcast-intel guard (${hits.length} allowed reference(s))`);
}

main();
