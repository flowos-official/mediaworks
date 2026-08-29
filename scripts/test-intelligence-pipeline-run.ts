import assert from "node:assert/strict";
import { startPipelineRun, type PipelineRunRepository } from "../lib/intelligence/pipeline-run";

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
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
