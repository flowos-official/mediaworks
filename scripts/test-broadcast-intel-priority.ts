import assert from "node:assert/strict";
import {
	chooseBalancedAnalysisSlots,
	UNCLASSIFIED_ANALYSIS_CATEGORY,
	type AnalysisCandidate,
} from "../lib/broadcast-intel/priority";
import {
	countDistinctAnalyzedCategories,
	createAnalysisQueueRepository,
	seedAnalysisQueue,
	type AnalysisQueueRepository,
	type PendingAnalysisCandidate,
} from "../lib/broadcast-intel/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDrainAnalysisScope } from "../lib/broadcast-intel/drain-scope";
import { broadcastAudioSeedOptions } from "../app/api/cron/analyze-broadcast-audio/route";

async function main(): Promise<void> {
function ids(rows: readonly AnalysisCandidate[]): string[] {
	return rows.map((row) => row.id);
}

const sampleRows: AnalysisCandidate[] = [
	{ id: "home-new", category: "家電", airDate: "2026-08-29", repeatCount: 4 },
	{ id: "fashion-new", category: "ファッション", airDate: "2026-08-28", repeatCount: 1 },
	{ id: "home-old", category: "家電", airDate: "2026-08-27", repeatCount: 2 },
];

{
	const picked = chooseBalancedAnalysisSlots(
		sampleRows,
		new Map([["家電", 45], ["ファッション", 5]]),
		2,
	);
	assert.deepEqual(ids(picked), ["fashion-new", "home-new"]);
	assert.equal(new Set(picked.map((row) => row.category)).size, 2);
	console.log("✓ under-sampled categories lead and round-robin before a second slot");
}

{
	assert.deepEqual(chooseBalancedAnalysisSlots(sampleRows, new Map(), 0), []);
	assert.deepEqual(chooseBalancedAnalysisSlots(sampleRows, new Map(), -1), []);
	console.log("✓ zero and negative limits select no slots");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "b", category: "same", airDate: "2026-08-29", repeatCount: 2 },
		{ id: "a", category: "same", airDate: "2026-08-29", repeatCount: 2 },
		{ id: "c", category: "same", airDate: "2026-08-28", repeatCount: 9 },
	];
	const counts = new Map([["same", 3]]);
	const expected = ["c", "a", "b"];
	assert.deepEqual(ids(chooseBalancedAnalysisSlots(rows, counts, 99)), expected);
	assert.deepEqual(ids(chooseBalancedAnalysisSlots([...rows].reverse(), counts, 99)), expected);
	console.log("✓ repeat, date, and ID ties are deterministic and input-order independent");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "missing", category: "  ", airDate: "2026-08-29", repeatCount: 5 },
		{ id: "known", category: "known", airDate: "2026-08-28", repeatCount: 1 },
	];
	const picked = chooseBalancedAnalysisSlots(
		rows,
		new Map([[UNCLASSIFIED_ANALYSIS_CATEGORY, 20], ["known", 1]]),
		1,
	);
	assert.deepEqual(ids(picked), ["known"]);
	assert.equal(rows[0]?.category, "  ", "the balancing bucket must not replace the stored category");
	console.log("✓ missing categories share a stored-count bucket without becoming a product category");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "only-2", category: "only", airDate: "2026-08-28", repeatCount: 1 },
		{ id: "only-1", category: "only", airDate: "2026-08-29", repeatCount: 1 },
	];
	assert.deepEqual(ids(chooseBalancedAnalysisSlots(rows, new Map([["only", 0]]), 9)), ["only-1", "only-2"]);
	console.log("✓ one-category pools fall back to their deterministic in-category priority");
}

function memoryRepository(
	candidates: PendingAnalysisCandidate[],
	analyzed: Array<{ broadcastId: string; category: string | null }>,
): AnalysisQueueRepository & { candidateCalls: Array<Record<string, unknown>>; promotionCalls: string[][]; countCalls: Array<Record<string, number>> } {
	const pending = new Map(candidates.map((row) => [row.id, row]));
	const candidateCalls: Array<Record<string, unknown>> = [];
	const promotionCalls: string[][] = [];
	const countCalls: Array<Record<string, number>> = [];
	return {
		candidateCalls,
		promotionCalls,
		countCalls,
		async findPendingCandidates(input) {
			candidateCalls.push(input);
			return [...pending.values()]
				.filter((row) => !input.category || row.category === input.category)
				.filter((row) => !input.channel || row.channel === input.channel)
				.slice(0, input.limit);
		},
		async findAnalyzedCategories(input) {
			countCalls.push(input);
			return analyzed.slice(input.offset, input.offset + input.limit);
		},
		async promotePending(idsToPromote) {
			promotionCalls.push([...idsToPromote]);
			const promoted = idsToPromote.filter((id) => pending.delete(id));
			return promoted;
		},
	};
}

{
	const repository = memoryRepository(
		[
			{ id: "home-a", channel: "qvc", category: "家電", airDate: "2026-08-29", productIds: ["h-1"], programTitle: "home" },
			{ id: "home-b", channel: "qvc", category: "家電", airDate: "2026-08-28", productIds: ["h-1"], programTitle: "home" },
			{ id: "fashion", channel: "shopch", category: "ファッション", airDate: "2026-08-27", productIds: ["f-1"], programTitle: "fashion" },
			{ id: "unclassified", channel: "shopch", category: null, airDate: "2026-08-26", productIds: null, programTitle: "unclassified programme" },
		],
		[
			{ broadcastId: "home-1", category: "家電" },
			{ broadcastId: "home-2", category: "家電" },
			{ broadcastId: "home-3", category: "家電" },
			{ broadcastId: "fashion-1", category: "ファッション" },
			{ broadcastId: "blank-1", category: null },
			{ broadcastId: "blank-2", category: " " },
		],
	);
	assert.equal(await seedAnalysisQueue({ limit: 4 }, repository), 4);
	assert.deepEqual(repository.promotionCalls[0], ["fashion", "unclassified", "home-a", "home-b"]);
	assert.deepEqual(repository.candidateCalls[0], { limit: 4 });
	assert.equal(await seedAnalysisQueue({ limit: 4 }, repository), 0, "a second seed must not promote an already queued row");
	assert.deepEqual(repository.promotionCalls, [["fashion", "unclassified", "home-a", "home-b"]]);
	console.log("✓ balanced seeding is bounded and idempotently promotes only pending rows");
}

{
	const repository = memoryRepository(
		[
			{ id: "repeated-a", channel: "qvc", category: "家電", airDate: "2026-08-29", productIds: ["same-product"], programTitle: "home" },
			{ id: "repeated-b", channel: "qvc", category: "家電", airDate: "2026-08-28", productIds: ["same-product"], programTitle: "home" },
			{ id: "single", channel: "shopch", category: "ファッション", airDate: "2026-08-30", productIds: ["different-product"], programTitle: "fashion" },
		],
		[],
	);
	await seedAnalysisQueue({ limit: 1 }, repository);
	assert.deepEqual(repository.promotionCalls, [["repeated-a"]]);
	console.log("✓ queue derives repeat priority from the bounded pool's stored product identities");
}

{
	const repository = memoryRepository([], []);
	assert.equal(await seedAnalysisQueue({ limit: 500 }, repository), 0);
	assert.deepEqual(repository.candidateCalls, [{ limit: 200 }]);
	console.log("✓ a large balanced request still bounds its database candidate pool");
}

{
	const repository = memoryRepository(
		[
			{ id: "home", channel: "qvc", category: "家電", airDate: "2026-08-29", productIds: ["h"], programTitle: "home" },
			{ id: "fashion", channel: "shopch", category: "ファッション", airDate: "2026-08-29", productIds: ["f"], programTitle: "fashion" },
		],
		[],
	);
	await seedAnalysisQueue({ limit: 1, category: "ファッション", channel: "shopch" }, repository);
	assert.deepEqual(repository.candidateCalls, [{ limit: 1, category: "ファッション", channel: "shopch" }]);
	assert.deepEqual(repository.promotionCalls, [["fashion"]]);
	console.log("✓ an explicit drain category remains an exact operator scope");
}

{
	const analyzed = [
		...Array.from({ length: 999 }, (_, index) => ({ broadcastId: `home-${index}`, category: "家電" })),
		{ broadcastId: "home-0", category: "家電" },
		{ broadcastId: "fashion-0", category: "ファッション" },
	];
	const repository = memoryRepository([], analyzed);
	const counts = await countDistinctAnalyzedCategories(repository);
	assert.deepEqual([...counts.entries()].sort(), [["ファッション", 1], ["家電", 999]].sort());
	assert.deepEqual(repository.countCalls, [{ offset: 0, limit: 1000 }, { offset: 1000, limit: 1000 }]);
	console.log("✓ completed analysis counts paginate past 1,000 rows and suppress duplicate broadcasts");
}

{
	const candidateFilters: Array<[string, unknown]> = [];
	const candidateNotFilters: Array<[string, string, unknown]> = [];
	const updateFilters: Array<[string, unknown]> = [];
	let candidateLimit: number | undefined;
	const candidateQuery = {
		select() { return this; },
		eq(column: string, value: unknown) { candidateFilters.push([column, value]); return this; },
		in(column: string, value: unknown) { candidateFilters.push([column, value]); return this; },
		not(column: string, operator: string, value: unknown) { candidateNotFilters.push([column, operator, value]); return this; },
		order() { return this; },
		async limit(limit: number) { candidateLimit = limit; return { data: [], error: null }; },
	};
	const analysisQuery = {
		select() { return this; },
		order() { return this; },
		async range() { return { data: [], error: null }; },
	};
	const supabase = {
		from(table: string) {
			if (table === "broadcasts") {
				return {
					...candidateQuery,
					update() {
						return {
							in(column: string, value: unknown) {
								updateFilters.push([column, value]);
								return {
									eq(nextColumn: string, nextValue: unknown) {
										updateFilters.push([nextColumn, nextValue]);
										return { select: async () => ({ data: [], error: null }) };
									},
								};
							},
						};
					},
				};
			}
			return analysisQuery;
		},
	};
	const repository = createAnalysisQueueRepository(supabase as unknown as SupabaseClient);
	await repository.findPendingCandidates({ limit: 12 });
	await repository.promotePending(["candidate-1"]);
	assert.deepEqual(candidateFilters, [
		["analysis_status", "pending"],
		["channel", ["qvc", "shopch"]],
	]);
	assert.deepEqual(candidateNotFilters, [["archived_video_s3", "is", null]]);
	assert.equal(candidateLimit, 12);
	assert.deepEqual(updateFilters, [["id", ["candidate-1"]], ["analysis_status", "pending"]]);
	console.log("✓ production queue adapter bounds candidates and keeps the pending-status promotion guard");
}

{
	assert.deepEqual(buildDrainAnalysisScope(undefined, undefined), {});
	assert.deepEqual(
		buildDrainAnalysisScope("家電", "shopch"),
		{ category: "家電", channel: "shopch" },
	);
	console.log("✓ drain scope keeps an explicit category and omits it for balanced seeding");
}

{
	assert.deepEqual(broadcastAudioSeedOptions(), { limit: 10 });
	console.log("✓ cron uses the balanced seed path without a category default");
}

console.log("PASS: broadcast-intel priority");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
