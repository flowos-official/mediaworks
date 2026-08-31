import assert from "node:assert/strict";
import {
	analysisBalanceKey,
	chooseBalancedAnalysisSlots,
	type AnalysisCandidate,
} from "../lib/broadcast-intel/priority";
import {
	countDistinctAnalyzedCategories,
	buildEligibleAnalysisScopes,
	createAnalysisQueueRepository,
	seedAnalysisQueue,
	type AnalysisQueueRepository,
	type PendingAnalysisCandidate,
} from "../lib/broadcast-intel/queue";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDrainAnalysisScope, parseDrainCategory } from "../lib/broadcast-intel/drain-scope";
import { broadcastAudioSeedOptions } from "../app/api/cron/analyze-broadcast-audio/route";
import { CATEGORIES_BY_CHANNEL } from "../lib/broadcasts/whitelist-gate";

async function main(): Promise<void> {
function ids(rows: readonly AnalysisCandidate[]): string[] {
	return rows.map((row) => row.id);
}

const sampleRows: AnalysisCandidate[] = [
	{ id: "home-new", channel: "qvc", category: "家電", airDate: "2026-08-29", repeatCount: 4 },
	{ id: "fashion-new", channel: "qvc", category: "ファッション", airDate: "2026-08-28", repeatCount: 1 },
	{ id: "home-old", channel: "qvc", category: "家電", airDate: "2026-08-27", repeatCount: 2 },
];

{
	const picked = chooseBalancedAnalysisSlots(
		sampleRows,
		new Map([[analysisBalanceKey("qvc", "家電"), 45], [analysisBalanceKey("qvc", "ファッション"), 5]]),
		2,
	);
	assert.deepEqual(ids(picked), ["fashion-new", "home-new"]);
	assert.equal(new Set(picked.map((row) => row.category)).size, 2);
	console.log("✓ under-sampled categories lead and round-robin before a second slot");
}

{
	// The two channels are different media, not different lengths of one: QVC
	// archives ~2-minute digest clips, Shop Channel ~1-hour programmes. Keyed on
	// category alone, QVC's higher slot count took every round in a shared
	// category and Shop Channel's rows there were never analysed.
	const shared: AnalysisCandidate[] = [
		{ id: "qvc-1", channel: "qvc", category: "家電", airDate: "2026-08-29", repeatCount: 1 },
		{ id: "qvc-2", channel: "qvc", category: "家電", airDate: "2026-08-28", repeatCount: 1 },
		{ id: "shopch-1", channel: "shopch", category: "家電", airDate: "2026-08-27", repeatCount: 1 },
	];
	const picked = chooseBalancedAnalysisSlots(
		shared,
		new Map([[analysisBalanceKey("qvc", "家電"), 40], [analysisBalanceKey("shopch", "家電"), 0]]),
		2,
	);
	assert.deepEqual(ids(picked), ["shopch-1", "qvc-1"]);
	assert.equal(
		new Set(picked.map((row) => row.channel)).size,
		2,
		"a shared category must not let one channel take the whole batch",
	);
	console.log("✓ balancing is per channel and category, so neither channel starves the other");
}

{
	assert.deepEqual(chooseBalancedAnalysisSlots(sampleRows, new Map(), 0), []);
	assert.deepEqual(chooseBalancedAnalysisSlots(sampleRows, new Map(), -1), []);
	console.log("✓ zero and negative limits select no slots");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "b", channel: "qvc", category: "same", airDate: "2026-08-29", repeatCount: 2 },
		{ id: "a", channel: "qvc", category: "same", airDate: "2026-08-29", repeatCount: 2 },
		{ id: "c", channel: "qvc", category: "same", airDate: "2026-08-28", repeatCount: 9 },
	];
	const counts = new Map([["same", 3]]);
	const expected = ["c", "a", "b"];
	assert.deepEqual(ids(chooseBalancedAnalysisSlots(rows, counts, 99)), expected);
	assert.deepEqual(ids(chooseBalancedAnalysisSlots([...rows].reverse(), counts, 99)), expected);
	console.log("✓ repeat, date, and ID ties are deterministic and input-order independent");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "missing", channel: "qvc", category: "  ", airDate: "2026-08-29", repeatCount: 5 },
		{ id: "known", channel: "qvc", category: "known", airDate: "2026-08-28", repeatCount: 1 },
	];
	const picked = chooseBalancedAnalysisSlots(
		rows,
		new Map([[analysisBalanceKey("qvc", null), 20], [analysisBalanceKey("qvc", "known"), 1]]),
		1,
	);
	assert.deepEqual(ids(picked), ["known"]);
	assert.equal(rows[0]?.category, "  ", "the balancing bucket must not replace the stored category");
	console.log("✓ missing categories share a stored-count bucket without becoming a product category");
}

{
	const rows: AnalysisCandidate[] = [
		{ id: "only-2", channel: "qvc", category: "only", airDate: "2026-08-28", repeatCount: 1 },
		{ id: "only-1", channel: "qvc", category: "only", airDate: "2026-08-29", repeatCount: 1 },
	];
	assert.deepEqual(ids(chooseBalancedAnalysisSlots(rows, new Map([[analysisBalanceKey("qvc", "only"), 0]]), 9)), ["only-1", "only-2"]);
	console.log("✓ one-category pools fall back to their deterministic in-category priority");
}

function memoryRepository(
	candidates: PendingAnalysisCandidate[],
	analyzed: Array<{ broadcastId: string; category: string | null; channel?: "qvc" | "shopch"; analyzedAt?: string }>,
): AnalysisQueueRepository & { candidateCalls: Array<Record<string, unknown>>; promotionCalls: string[][]; countCalls: Array<Record<string, unknown>> } {
	const pending = new Map(candidates.map((row) => [row.id, row]));
	const candidateCalls: Array<Record<string, unknown>> = [];
	const promotionCalls: string[][] = [];
	const countCalls: Array<Record<string, unknown>> = [];
	return {
		candidateCalls,
		promotionCalls,
		countCalls,
		async findPendingCandidates(input) {
			candidateCalls.push(input);
			const eligible = [...pending.values()].filter((row) => input.scopes.some((scope) =>
				scope.channel === row.channel && scope.categories.includes(row.category ?? ""),
			));
			eligible.sort((left, right) => (input.oldestFirst === true
				? left.airDate.localeCompare(right.airDate)
				: right.airDate.localeCompare(left.airDate)) || left.id.localeCompare(right.id));
			return eligible.slice(0, input.limit);
		},
		async findCompletedAnalysisIds(input) {
			countCalls.push(input);
			// The window is the production filter, so the fake honours it too.
			const inWindow = analyzed.filter((row) => (row.analyzedAt ?? "9999-12-31") >= input.since);
			return inWindow.slice(input.offset, input.offset + input.limit).map((row) => row.broadcastId);
		},
		async findCurrentBroadcastCategories(input) {
			const rows = new Map(analyzed.map((row) => [row.broadcastId, row]));
			return input.ids.flatMap((id) => {
				const row = rows.get(id);
				return row === undefined
					? []
					: [{ id, channel: row.channel ?? ("qvc" as const), category: row.category }];
			});
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
	assert.equal(await seedAnalysisQueue({ limit: 4 }, repository), 3);
	assert.deepEqual(repository.promotionCalls[0], ["fashion", "home-a", "home-b"]);
	// The pool is drawn from both ends of the backlog. Newest-first alone kept the
	// window pinned to the last few days once daily arrivals outpaced the promote
	// rate, so anything older was unreachable by the cron no matter how low its
	// analysed count.
	assert.equal(repository.candidateCalls.length, 2, "the balanced pool is drawn from both ends of the queue");
	assert.equal(repository.candidateCalls[0]?.limit, 100);
	assert.equal(repository.candidateCalls[0]?.oldestFirst, undefined);
	assert.equal(repository.candidateCalls[1]?.limit, 100);
	assert.equal(repository.candidateCalls[1]?.oldestFirst, true);
	assert.equal(await seedAnalysisQueue({ limit: 4 }, repository), 0, "a second seed must not promote an already queued row");
	assert.deepEqual(repository.promotionCalls, [["fashion", "home-a", "home-b"]]);
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
	const pooled = repository.candidateCalls.reduce((total, call) => total + Number(call.limit), 0);
	assert.equal(pooled, 200, "the two halves together still respect the pool bound");
	console.log("✓ a large balanced request still bounds its database candidate pool");
}

{
	const repository = memoryRepository(
		[
			...Array.from({ length: 10 }, (_, index) => ({
				id: `home-${index}`,
				channel: "qvc" as const,
				category: "家電",
				airDate: `2026-08-${String(29 - index).padStart(2, "0")}`,
				productIds: [`home-${index}`],
				programTitle: "home",
			})),
			{ id: "fashion-11", channel: "shopch", category: "ファッション", airDate: "2026-08-01", productIds: ["fashion"], programTitle: "fashion" },
		],
		[
			...Array.from({ length: 20 }, (_, index) => ({ broadcastId: `completed-home-${index}`, category: "家電" })),
		],
	);
	await seedAnalysisQueue({ limit: 10 }, repository);
	assert.ok(repository.promotionCalls[0]?.includes("fashion-11"), "an alternative just beyond the requested output size must enter the balanced batch");
	assert.equal(
		repository.candidateCalls.reduce((total, call) => total + Number(call.limit), 0),
		200,
	);
	console.log("✓ balanced selection sees its full bounded pool before taking the requested output size");
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
	assert.deepEqual(repository.candidateCalls, [{
		limit: 1,
		scopes: [{ channel: "shopch", categories: ["ファッション"] }],
	}]);
	assert.deepEqual(repository.promotionCalls, [["fashion"]]);
	console.log("✓ an explicit drain category remains an exact operator scope");
}

{
	assert.deepEqual(buildEligibleAnalysisScopes(undefined, undefined), [
		{ channel: "qvc", categories: [...CATEGORIES_BY_CHANNEL.qvc] },
		{ channel: "shopch", categories: [...CATEGORIES_BY_CHANNEL.shopch] },
	]);
	assert.deepEqual(buildEligibleAnalysisScopes("グルメ・お酒", undefined), [
		{ channel: "shopch", categories: ["グルメ・お酒"] },
	]);
	assert.deepEqual(buildEligibleAnalysisScopes("   ", undefined), []);
	assert.deepEqual(buildEligibleAnalysisScopes("not-a-whitelist-category", "qvc"), []);
	assert.throws(
		() => buildEligibleAnalysisScopes(undefined, undefined, null),
		/whitelist unavailable/,
	);
	console.log("✓ whitelist scopes stay channel-specific, reject invalid categories, and surface unavailable configuration");
}

{
	const repository = memoryRepository(
		[
			...Array.from({ length: 199 }, (_, index) => ({
				id: `invalid-${index}`,
				channel: "qvc" as const,
				category: index === 0 ? " " : "not-a-whitelist-category",
				airDate: `2026-08-${String(29 - (index % 20)).padStart(2, "0")}`,
				productIds: [`invalid-${index}`],
				programTitle: "invalid",
			})),
			{ id: "valid-qvc", channel: "qvc", category: "家電", airDate: "2026-07-01", productIds: ["qvc"], programTitle: "qvc" },
			{ id: "valid-shopch", channel: "shopch", category: "グルメ・お酒", airDate: "2026-07-01", productIds: ["shopch"], programTitle: "shopch" },
		],
		[],
	);
	await seedAnalysisQueue({ limit: 2 }, repository);
	const expectedScopes = [
		{ channel: "qvc", categories: [...CATEGORIES_BY_CHANNEL.qvc] },
		{ channel: "shopch", categories: [...CATEGORIES_BY_CHANNEL.shopch] },
	];
	assert.deepEqual(repository.candidateCalls, [
		{ limit: 100, scopes: expectedScopes },
		{ limit: 100, scopes: expectedScopes, oldestFirst: true },
	], "both halves of the pool carry the same whitelist scopes");
	assert.deepEqual(repository.promotionCalls, [["valid-qvc", "valid-shopch"]]);
	console.log("✓ whitelist eligibility is applied before the bounded balanced candidate pool");
}

{
	const repository = memoryRepository(
		[
			{ id: "race-home", channel: "qvc", category: "家電", airDate: "2026-08-29", productIds: ["home"], programTitle: "home" },
			{ id: "race-fashion", channel: "shopch", category: "ファッション", airDate: "2026-08-29", productIds: ["fashion"], programTitle: "fashion" },
		],
		[],
	);
	repository.promotePending = async (idsToPromote) => {
		repository.promotionCalls.push([...idsToPromote]);
		return idsToPromote.slice(0, 1);
	};
	assert.equal(await seedAnalysisQueue({ limit: 2 }, repository), 1);
	assert.equal(repository.promotionCalls[0]?.length, 2);
	console.log("✓ a partial concurrent promotion race reports only rows actually queued");
}

{
	const analyzed = [
		...Array.from({ length: 999 }, (_, index) => ({ broadcastId: `home-${index}`, category: "家電" })),
		{ broadcastId: "home-0", category: "家電" },
		{ broadcastId: "fashion-0", category: "ファッション" },
	];
	const repository = memoryRepository([], analyzed);
	const counts = await countDistinctAnalyzedCategories(repository);
	assert.deepEqual(
		[...counts.entries()].sort(),
		[[analysisBalanceKey("qvc", "ファッション"), 1], [analysisBalanceKey("qvc", "家電"), 999]].sort(),
	);
	assert.deepEqual(
		repository.countCalls.map((call) => ({ offset: call.offset, limit: call.limit })),
		[{ offset: 0, limit: 1000 }, { offset: 1000, limit: 1000 }],
	);
	// A lifetime scan grew without bound and made a category's backlog permanent;
	// the window makes the preamble cost constant and lets a category come due again.
	const since = String(repository.countCalls[0]?.since);
	assert.ok(Number.isFinite(Date.parse(since)), "the completed-analysis scan is bounded by a lookback window");
	assert.ok(Date.parse(since) < Date.now(), "the window looks backwards");
	console.log("✓ completed analysis counts paginate, deduplicate, and stay inside a lookback window");
}

{
	const firstPage = [
		{ broadcastId: "duplicate", category: "stale" },
		...Array.from({ length: 998 }, (_, index) => ({ broadcastId: `current-${index}`, category: "stale" })),
		{ broadcastId: "blank-current", category: "stale" },
	];
	const secondPage = [
		{ broadcastId: "duplicate", category: "stale" },
		{ broadcastId: "missing-current", category: "stale" },
	];
	const categoryCalls: string[][] = [];
	const repository = {
		async findAnalyzedCategories(input: { offset: number }) {
			return input.offset === 0 ? firstPage : secondPage;
		},
		async findCompletedAnalysisIds(input: { offset: number }) {
			return (input.offset === 0 ? firstPage : secondPage).map((row) => row.broadcastId);
		},
		async findCurrentBroadcastCategories(input: { ids: string[] }) {
			categoryCalls.push(input.ids);
			return input.ids.flatMap((id) => {
				if (id === "duplicate") return [{ id, channel: "qvc", category: "corrected" }];
				if (id.startsWith("current-")) return [{ id, channel: "qvc", category: "current" }];
				if (id === "blank-current") return [{ id, channel: "shopch", category: " " }];
				return [];
			});
		},
	} as unknown as AnalysisQueueRepository;
	const counts = await countDistinctAnalyzedCategories(repository);
	// `missing-current` has an analysis but no broadcast row, so its channel is
	// unknowable and it contributes to nothing. Attributing it to a bucket would
	// weight some channel's balance with a row nobody can act on.
	assert.deepEqual([...counts.entries()].sort(), [
		[analysisBalanceKey("qvc", "corrected"), 1],
		[analysisBalanceKey("qvc", "current"), 998],
		[analysisBalanceKey("shopch", " "), 1],
	].sort());
	assert.equal(categoryCalls.flat().length, 1001, "each completed broadcast ID is resolved once after deduplication");
	assert.ok(categoryCalls.every((ids) => ids.length <= 200), "current-category resolution stays in bounded ID chunks");
	await assert.rejects(
		() => countDistinctAnalyzedCategories({
			findCompletedAnalysisIds: async () => { throw new Error("speech page unavailable"); },
		} as unknown as AnalysisQueueRepository),
		/speech page unavailable/,
	);
	await assert.rejects(
		() => countDistinctAnalyzedCategories({
			findCompletedAnalysisIds: async () => ["id-1"],
			findCurrentBroadcastCategories: async () => { throw new Error("current category chunk unavailable"); },
		} as unknown as AnalysisQueueRepository),
		/current category chunk unavailable/,
	);
	console.log("✓ current categories replace stale analysis snapshots with bounded, failure-visible resolution");
}

{
	const candidateFilters: Array<[string, unknown]> = [];
	const candidateNotFilters: Array<[string, string, unknown]> = [];
	const candidateOrFilters: string[] = [];
	const updateFilters: Array<[string, unknown]> = [];
	let candidateLimit: number | undefined;
	const candidateQuery = {
		select() { return this; },
		eq(column: string, value: unknown) { candidateFilters.push([column, value]); return this; },
		in(column: string, value: unknown) { candidateFilters.push([column, value]); return this; },
		or(filter: string) { candidateOrFilters.push(filter); return this; },
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
	await repository.findPendingCandidates({
		limit: 12,
		scopes: [
			{ channel: "qvc", categories: ["家電"] },
			{ channel: "shopch", categories: ["グルメ・お酒"] },
		],
	});
	await repository.promotePending(["candidate-1"]);
	assert.deepEqual(candidateFilters, [
		["analysis_status", "pending"],
	]);
	assert.deepEqual(candidateOrFilters, [
		'and(channel.eq.qvc,category.in.("家電")),and(channel.eq.shopch,category.in.("グルメ・お酒"))',
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
	assert.equal(parseDrainCategory(undefined), undefined);
	assert.equal(parseDrainCategory(" 家電 "), "家電");
	assert.throws(() => parseDrainCategory(""), /--category must be a nonblank value/);
	assert.throws(() => parseDrainCategory(" \t "), /--category must be a nonblank value/);
	console.log("✓ drain parser rejects blank operator categories before scope construction");
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
