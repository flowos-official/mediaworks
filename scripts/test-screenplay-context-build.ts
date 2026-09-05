/**
 * One context per run: what was read, in what order it was written.
 *
 * The orchestration questions are all about a refine. Re-reading the world for
 * a rewrite would mean the second version rests on evidence the first never
 * saw while presenting itself as an edit of it — the knowledge snapshot would
 * describe a state that never produced anything. But inheriting blindly is
 * just as wrong: swap the linked product and the inherited snapshot describes
 * a different item entirely.
 */
import assert from "node:assert/strict";
import {
	buildScreenplayGenerationContext,
	briefMatchesPack,
	rowToContext,
	type ContextInsert,
	type ScreenplayContextRepository,
	type ScreenplayGenerationContext,
} from "../lib/screenplay/context/build";
import { briefEvidenceDrafts } from "../lib/screenplay/context/product-facts";
import type { KnowledgeSnapshotDraft } from "../lib/intelligence/types";
import type { ProductFactPack } from "../lib/screenplay/context/types";
import type { ProductBrief } from "../lib/screenplay/types";

const SCREENPLAY_ID = "55555555-5555-4555-8555-555555555555";
const CANONICAL_ID = "66666666-6666-4666-8666-666666666666";

const BRIEF: ProductBrief = {
	name: "静音ブレンダー Pro",
	category: "家電",
	description: "氷も砕ける静音ミキサー",
	price: { saleJpy: 14800 },
};

function packFor(brief: ProductBrief, canonicalProductId: string | null): ProductFactPack {
	const builtAt = "2026-09-05T00:00:00.000Z";
	return {
		subjectId: SCREENPLAY_ID,
		canonicalProductId,
		facts: briefEvidenceDrafts(SCREENPLAY_ID, brief, builtAt).map((draft, i) => ({
			key: draft.predicate,
			label: draft.predicate,
			value: draft.value,
			evidenceClass: "internal_input" as const,
			usage: "direct" as const,
			evidenceItemIds: [`ev-${i}`],
			sourceLabel: "screenplay_brief",
			observedAt: builtAt,
		})),
		missing: ["guarantee"],
		forbiddenClaims: ["保証に言及しない"],
		builtAt,
	};
}

const VALID_PLAN = JSON.stringify({
	runtimeMinutes: 25,
	sections: [
		{ id: "opening", title: "導入", purpose: "つかむ", runtimeShare: 0.2, keyMessages: [], factKeys: ["name"], patternBasis: [] },
		{ id: "demo", title: "実演", purpose: "見せる", runtimeShare: 0.5, keyMessages: [], factKeys: [], patternBasis: [] },
		{ id: "offer", title: "オファー", purpose: "売る", runtimeShare: 0.3, keyMessages: [], factKeys: ["price_sale_jpy"], patternBasis: [] },
	],
	demos: [],
});

interface Calls {
	factPack: number;
	references: number;
	pattern: number;
	snapshot: number;
	insert: number;
	plan: number;
	snapshots: KnowledgeSnapshotDraft[];
	inserts: ContextInsert[];
}

function repo(
	over: Partial<ScreenplayContextRepository> = {},
): { repo: ScreenplayContextRepository; calls: Calls } {
	const calls: Calls = {
		factPack: 0, references: 0, pattern: 0, snapshot: 0, insert: 0, plan: 0,
		snapshots: [], inserts: [],
	};
	const base: ScreenplayContextRepository = {
		async loadFactPack(input) {
			calls.factPack++;
			return packFor(input.brief, input.canonicalProductId);
		},
		async loadReferences() {
			calls.references++;
			return [
				{ broadcastId: "b1", channel: "shopch", airDate: "2026-08-01", category: "家電", programTitle: "", similarity: 0.8, matchedOn: ["category"], analysisId: "b1" },
			];
		},
		async loadPattern() {
			calls.pattern++;
			return { status: "under_sampled", pattern: null, detail: "too few analyzed broadcasts" };
		},
		async loadBroadcastEvidence(ids) {
			return ids.map((id, i) => ({ subjectId: id, evidenceItemId: `bev-${i}` }));
		},
		async createSnapshot(draft) {
			calls.snapshot++;
			calls.snapshots.push(draft);
			return `snap-${calls.snapshot}`;
		},
		async insertContext(row) {
			calls.insert++;
			calls.inserts.push(row);
			return { id: `ctx-${calls.insert}`, createdAt: "2026-09-05T00:00:00.000Z" };
		},
		async loadBaseContext() {
			return null;
		},
		generateStructurePlan: async () => {
			calls.plan++;
			return VALID_PLAN;
		},
		...over,
	};
	return { repo: base, calls };
}

function storedContext(over: Partial<ScreenplayGenerationContext> = {}): ScreenplayGenerationContext {
	return {
		id: "ctx-base",
		screenplayId: SCREENPLAY_ID,
		runId: "run-1",
		knowledgeSnapshotId: "snap-base",
		productFactPack: packFor(BRIEF, CANONICAL_ID),
		referenceBroadcasts: [
			{ broadcastId: "b0", channel: "qvc", airDate: "2026-07-01", category: "家電", programTitle: "", similarity: 0.5, matchedOn: ["category"], analysisId: "b0" },
		],
		patternResult: { status: "applied", pattern: null, detail: "12 analyzed broadcasts" },
		structurePlan: {
			basis: "competitor_pattern",
			runtimeMinutes: 25,
			sections: [{ id: "base", title: "既存構成", purpose: "x", runtimeShare: 1, keyMessages: [], factKeys: [], patternBasis: [] }],
			demos: [],
		},
		createdAt: "2026-09-01T00:00:00.000Z",
		...over,
	};
}

async function main(): Promise<void> {
	// --- an initial run reads each source exactly once ----------------------
	{
		const { repo: r, calls } = repo();
		const ctx = await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-1",
			canonicalProductId: CANONICAL_ID,
			brief: BRIEF,
			mode: "initial",
		});
		assert.deepEqual(
			{ factPack: calls.factPack, references: calls.references, pattern: calls.pattern, plan: calls.plan },
			{ factPack: 1, references: 1, pattern: 1, plan: 1 },
			"each source is read once per run",
		);
		assert.equal(calls.snapshot, 1);
		assert.equal(calls.insert, 1);
		assert.equal(ctx.id, "ctx-1");
		assert.equal(ctx.knowledgeSnapshotId, "snap-1");
	}
	console.log("✓ an initial run reads each source once and persists one context");

	// --- the snapshot names the product facts AND the reference evidence ----
	{
		const { repo: r, calls } = repo();
		await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-1",
			canonicalProductId: CANONICAL_ID,
			brief: BRIEF,
			mode: "initial",
		});
		const draft = calls.snapshots[0];
		assert.equal(draft.consumerType, "screenplay");
		assert.equal(draft.consumerRunId, "run-1");
		assert.equal(draft.mode, "stored_only", "the screenplay path reads stored evidence only");
		const roles = new Set(draft.items.map((i) => i.usageRole));
		assert.ok(roles.has("product_fact"), "every fact's evidence is recorded");
		assert.ok(roles.has("reference_broadcast"), "the broadcasts that shaped the structure are recorded");
		for (const item of draft.items) {
			assert.ok(item.evidenceItemId, "a snapshot item without an evidence id records nothing");
		}
		assert.equal(
			new Set(draft.items.map((i) => `${i.evidenceItemId}:${i.resultLocator}`)).size,
			draft.items.length,
			"no duplicate snapshot items",
		);
	}
	console.log("✓ the snapshot names both the product facts and the reference broadcasts");

	// --- a non-applied pattern is persisted, not dropped --------------------
	// This is the whole reason the status column exists: the old path logged
	// "under-sampled" to the console and stored null.
	{
		const { repo: r, calls } = repo();
		await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-1",
			canonicalProductId: null,
			brief: BRIEF,
			mode: "initial",
		});
		const row = calls.inserts[0];
		assert.equal(row.patternResult.status, "under_sampled");
		assert.equal(row.patternResult.detail, "too few analyzed broadcasts");
		assert.equal(row.patternResult.pattern, null);
		assert.equal(row.structurePlan.basis, "generic", "no pattern means the plan says so");
	}
	console.log("✓ a pattern that did not apply is persisted with its reason");

	// --- a refine inherits its base's evidence ------------------------------
	{
		const stored = storedContext();
		const { repo: r, calls } = repo({ loadBaseContext: async () => stored });
		const ctx = await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-2",
			canonicalProductId: CANONICAL_ID,
			brief: BRIEF,
			mode: "refine",
			baseVersionId: "v1",
		});
		assert.equal(calls.factPack, 0, "a refine does not re-read the ledger");
		assert.equal(calls.references, 0);
		assert.equal(calls.pattern, 0);
		assert.equal(calls.snapshot, 0, "a refine reuses the snapshot its base rests on");
		assert.equal(ctx.knowledgeSnapshotId, "snap-base");
		assert.equal(ctx.patternResult.status, "applied", "the inherited pattern state comes with it");
		assert.equal(calls.plan, 1, "the structure plan IS regenerated — feedback may move it");
		assert.equal(calls.insert, 1, "a refine still gets its own context row");
		assert.equal(calls.inserts[0].runId, "run-2");
	}
	console.log("✓ a refine inherits evidence and snapshot but gets its own context row");

	// --- a refine whose product changed does not inherit --------------------
	{
		const stored = storedContext();
		const { repo: r, calls } = repo({ loadBaseContext: async () => stored });
		await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-3",
			canonicalProductId: "77777777-7777-4777-8777-777777777777",
			brief: BRIEF,
			mode: "refine",
			baseVersionId: "v1",
		});
		assert.equal(calls.factPack, 1, "a different product must be read afresh");
		assert.equal(calls.snapshot, 1, "and gets its own snapshot");
	}
	{
		const stored = storedContext();
		const { repo: r, calls } = repo({ loadBaseContext: async () => stored });
		await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-4",
			canonicalProductId: CANONICAL_ID,
			brief: { ...BRIEF, price: { saleJpy: 9800 } },
			mode: "refine",
			baseVersionId: "v1",
		});
		assert.equal(calls.factPack, 1, "an edited price is a different product fact");
		assert.equal(calls.snapshot, 1);
	}
	console.log("✓ a changed product or brief breaks inheritance");

	// --- a legacy base version simply builds a fresh context ----------------
	{
		const { repo: r, calls } = repo({ loadBaseContext: async () => null });
		await buildScreenplayGenerationContext(r, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-5",
			canonicalProductId: CANONICAL_ID,
			brief: BRIEF,
			mode: "refine",
			baseVersionId: "legacy-v1",
		});
		assert.equal(calls.factPack, 1, "a version predating the context table is a state, not an error");
		assert.equal(calls.snapshot, 1);
	}
	console.log("✓ refining a legacy version builds a fresh context instead of failing");

	// --- an unusable plan fails an initial run and is survivable on refine --
	{
		const { repo: r } = repo({ generateStructurePlan: async () => "not json" });
		await assert.rejects(
			buildScreenplayGenerationContext(r, {
				screenplayId: SCREENPLAY_ID,
				runId: "run-6",
				canonicalProductId: null,
				brief: BRIEF,
				mode: "initial",
			}),
			"an initial run has nothing to fall back to",
		);

		const stored = storedContext();
		const { repo: r2, calls } = repo({
			loadBaseContext: async () => stored,
			generateStructurePlan: async () => "not json",
		});
		const ctx = await buildScreenplayGenerationContext(r2, {
			screenplayId: SCREENPLAY_ID,
			runId: "run-7",
			canonicalProductId: CANONICAL_ID,
			brief: BRIEF,
			mode: "refine",
			baseVersionId: "v1",
		});
		assert.deepEqual(ctx.structurePlan, stored.structurePlan, "a refine keeps the plan that already worked");
		assert.equal(calls.insert, 1);
	}
	console.log("✓ an unusable plan fails an initial run and falls back on a refine");

	// --- brief comparison ignores nothing and invents nothing ---------------
	{
		const pack = packFor(BRIEF, CANONICAL_ID);
		assert.equal(briefMatchesPack(BRIEF, pack), true);
		assert.equal(briefMatchesPack({ ...BRIEF, name: "別商品" }, pack), false);
		assert.equal(briefMatchesPack({ ...BRIEF, guarantee: "1年保証" }, pack), false, "an added field is a change");
		assert.equal(briefMatchesPack({ ...BRIEF, category: undefined }, pack), false, "a removed field is a change");
	}
	console.log("✓ inheritance is decided on the brief's values, not a timestamp");

	// --- a stored row round-trips ------------------------------------------
	{
		const ctx = rowToContext({
			id: "ctx-x",
			screenplay_id: SCREENPLAY_ID,
			run_id: "run-x",
			knowledge_snapshot_id: "snap-x",
			product_fact_pack: packFor(BRIEF, null),
			reference_broadcasts: [],
			pattern_status: "off_whitelist",
			pattern_detail: 'category "美容家電" is not on the broadcast whitelist',
			pattern_snapshot: null,
			outline: { basis: "generic", runtimeMinutes: 30, sections: [] },
			demo_plan: [],
			created_at: "2026-09-05T00:00:00.000Z",
		});
		assert.equal(ctx.patternResult.status, "off_whitelist");
		assert.equal(ctx.structurePlan.runtimeMinutes, 30);
		// A legacy row with no outline must not read as an applied empty plan.
		const legacy = rowToContext({
			id: "c", screenplay_id: SCREENPLAY_ID, run_id: "r", knowledge_snapshot_id: "s",
			product_fact_pack: packFor(BRIEF, null), pattern_status: "disabled",
			created_at: "2026-09-05T00:00:00.000Z",
		});
		assert.equal(legacy.structurePlan.basis, "generic");
		assert.deepEqual(legacy.structurePlan.sections, []);
	}
	console.log("✓ a stored context row round-trips with its pattern reason intact");

	console.log("PASS: screenplay context build");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
