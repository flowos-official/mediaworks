import assert from "node:assert/strict";
import {
	createPipelineRunRepository,
	startPipelineRun,
	type PipelineRunRepository,
} from "../lib/intelligence/pipeline-run";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
	audioPipelineOutcome,
	archivePipelineOutcome,
	discoveryPipelineCounts,
} from "../lib/intelligence/pipeline-run-mapping";

type Patch = Record<string, unknown>;

class FakeRepository implements PipelineRunRepository {
	readonly states: string[] = [];
	readonly inserts: Array<Record<string, unknown>> = [];
	readonly updates: Array<{ id: string; patch: Patch }> = [];
	insertError: Error | null = null;
	updateError: Error | null = null;

	async insert(input: {
		sourceType: string;
		jobType: string;
		externalRunId: string;
		targetScope: Record<string, unknown>;
	}): Promise<{ id: string }> {
		if (this.insertError) throw this.insertError;
		this.inserts.push(input);
		this.states.push("running");
		return { id: "pipeline-run-1" };
	}

	async update(id: string, patch: Patch): Promise<void> {
		if (this.updateError) throw this.updateError;
		this.updates.push({ id, patch });
		if (typeof patch.status === "string") this.states.push(patch.status);
	}
}

const input = {
	sourceType: "qvc_shopch",
	jobType: "broadcast_schedule",
	externalRunId: "test-run",
	targetScope: { date: "2026-08-29" },
};

async function expectRejects(fn: () => Promise<unknown>, message: string) {
	await assert.rejects(fn, /terminal|repository/);
	console.log(`✓ ${message}`);
}

async function main() {
	{
		assert.deepEqual(discoveryPipelineCounts(5, 2), {
			new: 2,
			updated: 0,
			duplicate: 3,
			failed: 0,
			processed: 5,
		});
		assert.deepEqual(discoveryPipelineCounts(2, 5), {
			new: 2,
			updated: 0,
			duplicate: 0,
			failed: 0,
			processed: 2,
		});
		console.log("✓ discovery mapping records attempted rows and only safe duplicate counts");
	}

	{
		assert.deepEqual(
			archivePipelineOutcome({
				processed: 2,
				archived: 1,
				queued: 0,
				abandoned: 0,
				deferred: 1,
				failed_unsupported: 0,
				stale_requeued: 1,
				stale_abandoned: 2,
			}, 0),
			{
				status: "partial",
				counts: { new: 1, updated: 2, duplicate: 0, failed: 2, processed: 5 },
			},
		);
		console.log("✓ archive mapping treats deferred and stale abandoned work as partial observed outcomes");
	}

	{
		assert.deepEqual(
			audioPipelineOutcome({
				recovered: 1,
				seeded: 3,
				processed: 2,
				done: 1,
				queued: 0,
				failed: 0,
				skipped: 1,
			}, 0),
			{
				status: "succeeded",
				counts: { new: 4, updated: 1, duplicate: 1, failed: 0, processed: 6 },
			},
		);
		console.log("✓ audio mapping includes seeded queue work in nonzero normalized counts");
	}

	{
		let inserted: Record<string, unknown> | undefined;
		let updated: Record<string, unknown> | undefined;
		const supabase = {
			from() {
				return {
					insert(payload: Record<string, unknown>) {
						inserted = payload;
						return {
							select() {
								return { single: async () => ({ data: { id: "adapter-run-1" }, error: null }) };
							},
						};
					},
					update(payload: Record<string, unknown>) {
						updated = payload;
						return { eq: async () => ({ error: null }) };
					},
				};
			},
		};
		const handle = await startPipelineRun(
			createPipelineRunRepository(supabase as unknown as SupabaseClient),
			input,
		);
		assert.deepEqual(inserted?.counts, {});
		await handle.fail("before_work", "failed before observing work");
		assert.deepEqual(updated?.counts, {});
		console.log("✓ adapter inserts and preserves empty observed counts on immediate failure");
	}

	{
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		await handle.heartbeat({ processed: 3 });
		await handle.succeed({ new: 2, updated: 1, duplicate: 0, failed: 0 });

		assert.equal(handle.id, "pipeline-run-1");
		assert.deepEqual(repository.states, ["running", "running", "succeeded"]);
		assert.deepEqual(repository.updates[0]?.patch.counts, { processed: 3 });
		assert.deepEqual(repository.updates[1]?.patch.counts, {
			new: 2,
			updated: 1,
			duplicate: 0,
			failed: 0,
			processed: 3,
		});
		await expectRejects(
			() => handle.fail("late_failure", "cannot fail a terminal run"),
			"successful runs reject a second terminal transition",
		);
		await expectRejects(
			() => handle.heartbeat({ processed: 4 }),
			"terminal runs reject later heartbeats",
		);
	}

	{
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		await handle.heartbeat({ processed: 3 });
		await handle.heartbeat({ updated: 1 });
		assert.deepEqual(repository.updates[1]?.patch.counts, { processed: 3, updated: 1 });
		console.log("✓ heartbeats retain known counts without inventing missing zeroes");
	}

	for (const terminal of ["partial", "failed"] as const) {
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		if (terminal === "partial") {
			await handle.partial(
				{ new: 0, updated: 2, duplicate: 1, failed: 1 },
				"source_timeout",
				"one source timed out",
			);
		} else {
			await handle.fail("source_error", "source failed");
		}
		assert.equal(repository.updates[0]?.patch.status, terminal);
		await expectRejects(
			() => handle.succeed({ new: 0, updated: 0, duplicate: 0, failed: 0 }),
			`${terminal} runs reject a second terminal transition`,
		);
		console.log(`✓ ${terminal} terminal state is persisted once`);
	}

	{
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		const longSummary = "x".repeat(1_001);
		await handle.fail("source_error", longSummary);
		assert.equal((repository.updates[0]?.patch.error_summary as string).length, 1_000);
		console.log("✓ failure summaries are capped at 1,000 characters");
	}

	{
		const repository = new FakeRepository();
		repository.insertError = new Error("repository insert failure");
		await assert.rejects(() => startPipelineRun(repository, input), /repository insert failure/);
		console.log("✓ insert repository errors propagate to the caller");
	}

	{
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		repository.updateError = new Error("repository update failure");
		await assert.rejects(() => handle.heartbeat({ processed: 1 }), /repository update failure/);
		assert.deepEqual(repository.updates, []);
		console.log("✓ update repository errors propagate without recording a false heartbeat");
	}

	{
		const repository = new FakeRepository();
		const handle = await startPipelineRun(repository, input);
		await handle.heartbeat({ processed: 4, duplicate: 1 });
		await handle.fail("source_failed", "all sources failed");
		assert.deepEqual(repository.updates[1]?.patch.counts, { processed: 4, duplicate: 1 });
		console.log("✓ failures retain counts observed before the terminal transition");
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
