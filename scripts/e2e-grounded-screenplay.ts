/**
 * End-to-end gate for grounded screenplay generation.
 *
 * Four entry paths, against the live database: a product-finder canonical
 * product, an existing Research product, a manually entered brief, and a
 * category the corpus holds nothing for. Each one builds a real generation
 * context — real evidence, real reference broadcasts, a real pattern lookup, a
 * real structure-plan model call — persists it, writes a version, and grounds
 * that version's claims with the real classifier.
 *
 * WHAT IT DOES NOT DO: generate prose. `start()` only works inside the
 * Workflow DevKit's compiled runtime, so a script cannot run the workflow —
 * verified, a bare tsx process gets "received an invalid workflow function".
 * Drafting is also the one expensive step (Pro with HIGH thinking), and every
 * property this gate asserts is a property of the context and the grounding,
 * not of the prose. Each case therefore uses a fixed sample script chosen to
 * contain a supportable price claim, an attributable seller claim, and an
 * efficacy claim nothing supports.
 *
 * Read-mostly: it creates one screenplay per case and deletes everything it
 * created, in dependency order.
 */
import assert from "node:assert/strict";
import { getServiceClient } from "@/lib/supabase";
import { MIN_SAMPLES } from "@/lib/broadcast-intel/category-pattern";
import {
	buildScreenplayGenerationContext,
	createScreenplayContextRepository,
} from "@/lib/screenplay/context/build";
import { geminiStructurePlanGenerator } from "@/lib/screenplay/context/structure-plan-gemini";
import { buildClaimLinks, detectMajorClaimLines, numberScriptLines } from "@/lib/screenplay/grounding/claim-links";
import { geminiClaimClassifier } from "@/lib/screenplay/grounding/claim-classifier-gemini";
import { findReferencePhraseOverlap, loadReferencePhrases } from "@/lib/screenplay/grounding/copy-guard";
import { loadProductBriefForScreenplay } from "@/lib/screenplay/product-brief";
import type { ProductBrief } from "@/lib/screenplay/types";

const PATTERN_STATUSES = new Set([
	"disabled",
	"no_category",
	"off_whitelist",
	"under_sampled",
	"timed_out",
	"failed",
	"applied",
]);

interface Created {
	screenplayId: string;
	knowledgeSnapshotId: string;
}

const created: Created[] = [];

function sampleScript(brief: ProductBrief): string {
	const price = brief.price?.saleJpy ?? brief.price?.listJpy;
	return [
		`# ${brief.name} — テレビショッピング 台本`,
		"",
		"## 導入",
		"MC: 本日ご紹介するのはこちらの商品です。",
		"",
		"## オファー",
		price ? `MC: 本日の特別価格は${price.toLocaleString("ja-JP")}円です。` : "MC: 本日の特別価格をご案内します。",
		"MC: メーカーによると累計10万台を突破しているそうです。",
		"",
		"## 効果",
		"MC: この商品を使えば3週間でシミが消えます。",
	].join("\n");
}

async function runCase(
	label: string,
	input: { brief: ProductBrief; canonicalProductId: string | null },
): Promise<void> {
	const sb = getServiceClient();
	const runId = `e2e-${label}-${Date.now()}`;

	const { data: screenplay, error: insErr } = await sb
		.from("screenplays")
		.insert({
			title: `[e2e] ${input.brief.name}`.slice(0, 200),
			product_info_snapshot: input.brief,
			status: "generating",
		})
		.select("id")
		.single();
	if (insErr || !screenplay) throw new Error(`screenplay insert failed: ${insErr?.message}`);
	const screenplayId = String(screenplay.id);

	const repo = createScreenplayContextRepository(sb);
	repo.generateStructurePlan = geminiStructurePlanGenerator(screenplayId);
	const context = await buildScreenplayGenerationContext(repo, {
		screenplayId,
		runId,
		canonicalProductId: input.canonicalProductId,
		brief: input.brief,
		mode: "initial",
	});
	created.push({ screenplayId, knowledgeSnapshotId: context.knowledgeSnapshotId });

	// --- the context is complete and honest about what it is ---------------
	assert.ok(PATTERN_STATUSES.has(context.patternResult.status), `[${label}] pattern status must be a known value`);
	assert.ok(context.patternResult.detail.length > 0, `[${label}] a pattern status must carry its reason`);
	if (context.patternResult.status === "applied") {
		assert.ok(
			(context.patternResult.pattern?.sampleSize ?? 0) >= MIN_SAMPLES,
			`[${label}] an applied pattern must rest on at least MIN_SAMPLES broadcasts`,
		);
	} else {
		assert.equal(context.patternResult.pattern, null, `[${label}] a non-applied pattern carries no snapshot`);
	}
	assert.ok(context.structurePlan.sections.length >= 3, `[${label}] a plan needs a running order`);
	const shareSum = context.structurePlan.sections.reduce((acc, s) => acc + s.runtimeShare, 0);
	assert.ok(Math.abs(shareSum - 1) < 0.02, `[${label}] runtime shares must sum to 1, got ${shareSum}`);
	assert.equal(
		context.structurePlan.basis,
		context.patternResult.status === "applied" ? "competitor_pattern" : "generic",
		`[${label}] basis must follow the pattern status`,
	);

	const { data: snapshot } = await sb
		.from("knowledge_snapshots")
		.select("mode, consumer_type, consumer_run_id")
		.eq("id", context.knowledgeSnapshotId)
		.single();
	assert.equal(snapshot?.mode, "stored_only", `[${label}] the screenplay path reads stored evidence only`);
	assert.equal(snapshot?.consumer_type, "screenplay");
	assert.equal(snapshot?.consumer_run_id, runId);

	const { data: contextRow } = await sb
		.from("screenplay_generation_contexts")
		.select("pattern_status, outline, demo_plan")
		.eq("id", context.id)
		.single();
	assert.equal(contextRow?.pattern_status, context.patternResult.status, `[${label}] the status is persisted`);
	assert.ok(contextRow?.outline, `[${label}] the outline is persisted`);
	assert.ok(contextRow?.demo_plan !== null, `[${label}] the demo plan is persisted`);

	// --- a version, grounded -----------------------------------------------
	const markdown = sampleScript(input.brief);
	const { data: version, error: vErr } = await sb
		.from("screenplay_versions")
		.insert({
			screenplay_id: screenplayId,
			version_number: 1,
			markdown,
			model: "e2e",
			thinking_level: "none",
			generation_context_id: context.id,
		})
		.select("id")
		.single();
	if (vErr || !version) throw new Error(`version insert failed: ${vErr?.message}`);

	const drafts = await buildClaimLinks(markdown, context.productFactPack, geminiClaimClassifier(screenplayId));
	if (drafts.length > 0) {
		const { error } = await sb.from("screenplay_claim_links").insert(
			drafts.map((d) => ({
				version_id: version.id,
				line_start: d.lineStart,
				line_end: d.lineEnd,
				claim_text: d.claimText,
				status: d.status,
				evidence_item_id: d.evidenceItemId,
				reason: d.reason,
			})),
		);
		if (error) throw new Error(`[${label}] claim link insert failed: ${error.message}`);
	}

	// Every major claim in the script is accounted for. This is the assertion
	// the whole plan exists for: an ungrounded number must not be able to reach
	// a broadcast without a person having been told about it.
	const detected = detectMajorClaimLines(numberScriptLines(markdown));
	const coveredLines = new Set<number>();
	for (const d of drafts) for (let l = d.lineStart; l <= d.lineEnd; l++) coveredLines.add(l);
	const uncovered = detected.filter((c) => !coveredLines.has(c.line));
	assert.deepEqual(
		uncovered.map((c) => c.text),
		[],
		`[${label}] every detected major claim must have a link`,
	);
	// The efficacy line has nothing behind it in any of the four cases.
	assert.ok(
		drafts.some((d) => d.status === "needs_review"),
		`[${label}] an unsupported efficacy claim must be flagged`,
	);
	for (const d of drafts) {
		assert.equal(
			d.status === "needs_review",
			d.evidenceItemId === null,
			`[${label}] only a needs_review claim may lack evidence, and it must lack it`,
		);
	}

	// --- the copy guard runs on the same references ------------------------
	const phrases = await loadReferencePhrases(sb, context.referenceBroadcasts.map((r) => r.analysisId));
	const overlaps = findReferencePhraseOverlap(markdown, phrases, [input.brief.name]);

	const needsReview = drafts.filter((d) => d.status === "needs_review").length;
	console.log(
		`  [${label}] snapshot=${context.knowledgeSnapshotId.slice(0, 8)} pattern=${context.patternResult.status}` +
			` refs=${context.referenceBroadcasts.length} sections=${context.structurePlan.sections.length}` +
			` demos=${context.structurePlan.demos.length} claims=${drafts.length} needs_review=${needsReview}` +
			` copy_overlaps=${overlaps.length}`,
	);
}

async function cleanup(): Promise<void> {
	const sb = getServiceClient();
	for (const { screenplayId, knowledgeSnapshotId } of created) {
		// Order matters: contexts reference the snapshot with RESTRICT, and
		// snapshot items reference the brief evidence with RESTRICT.
		await sb.from("screenplays").delete().eq("id", screenplayId);
		await sb.from("knowledge_snapshots").delete().eq("id", knowledgeSnapshotId);
		await sb
			.from("evidence_items")
			.delete()
			.eq("subject_type", "internal_product")
			.eq("subject_id", screenplayId);
	}
	console.log(`  cleaned up ${created.length} screenplay(s)`);
}

async function main(): Promise<void> {
	const sb = getServiceClient();

	// A canonical product with the most known evidence, in a category the
	// corpus is well sampled for — the case where a pattern should apply.
	const { data: canonicalRows } = await sb
		.from("canonical_products")
		.select("id, display_name, normalized_category")
		.eq("normalized_category", "家電")
		.order("id", { ascending: true })
		.limit(1);
	const canonical = canonicalRows?.[0];
	if (!canonical) throw new Error("no canonical product to run the product-finder case against");

	const { data: researchRows } = await sb
		.from("research_results")
		.select("product_id")
		.order("created_at", { ascending: false })
		.limit(1);
	const researchProductId = researchRows?.[0]?.product_id as string | undefined;

	try {
		await runCase("product-finder", {
			canonicalProductId: String(canonical.id),
			brief: {
				name: String(canonical.display_name).slice(0, 200),
				description: String(canonical.display_name).slice(0, 200),
				category: (canonical.normalized_category as string | null) ?? undefined,
			},
		});

		if (researchProductId) {
			const loaded = await loadProductBriefForScreenplay(sb, researchProductId);
			if (!loaded.ok) throw new Error(`research brief load failed: ${loaded.error}`);
			await runCase("research-product", { canonicalProductId: null, brief: loaded.brief });
		} else {
			console.log("  [research-product] SKIPPED: no research_results row exists");
		}

		await runCase("manual-brief", {
			canonicalProductId: null,
			brief: {
				name: "[e2e] 静音ブレンダー",
				description: "氷も砕ける静音設計のミキサー。お手入れも簡単。",
				category: "家電",
				price: { saleJpy: 14800 },
				guarantee: "1年保証",
				customization: { runtimeMinutes: 25, mustDemos: ["氷を砕く実演"] },
			},
		});

		// Nothing in the corpus for this category. The pattern must say so
		// rather than quietly producing a generic plan that looks informed.
		await runCase("sparse-category", {
			canonicalProductId: null,
			brief: {
				name: "[e2e] 未知カテゴリ商品",
				description: "蓄積データを持たないカテゴリの商品。",
				category: "存在しないカテゴリ",
			},
		});
	} finally {
		await cleanup();
	}

	console.log("PASS: grounded screenplay e2e");
}

main().catch((error) => {
	console.error("FAIL:", error);
	void cleanup().finally(() => process.exit(1));
});
