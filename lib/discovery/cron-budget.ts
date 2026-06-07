export interface CronBudgetInput {
	startedAtMs: number;
	deadlineMs: number;
	minBudgetMs: number;
	nowMs?: number;
}

export interface OptionalStageTimeoutInput {
	startedAtMs: number;
	deadlineMs: number;
	minSaveBudgetMs: number;
	nowMs?: number;
}

/**
 * Why an optional stage produced its fallback instead of a real result.
 * `ok` = the task ran to completion. The other three mean the candidate
 * scoring boost/penalty for this stage was NOT applied this run.
 */
export type OptionalStageOutcome =
	| "ok"
	| "skipped_no_budget"
	| "timeout"
	| "error";

export interface StageOutcome {
	label: string;
	outcome: OptionalStageOutcome;
}

export interface RunOptionalStageInput<T> extends OptionalStageTimeoutInput {
	label: string;
	fallback: T;
	task: () => Promise<T>;
	/** Reports how the stage resolved (ok / skipped / timeout / error) for cron observability. */
	onOutcome?: (result: StageOutcome) => void;
}

/**
 * Collects optional-stage outcomes across a cron run so the route can surface
 * which boost/penalty stages did NOT run (budget exhausted, timed out, errored).
 * `record` is an arrow property so it can be passed directly as `onOutcome`.
 */
export class OptionalStageTracker {
	private readonly results: StageOutcome[] = [];

	readonly record = (result: StageOutcome): void => {
		this.results.push(result);
	};

	/** Stages that did not run to completion — the cron observability payload. */
	skipped(): StageOutcome[] {
		return this.results.filter((r) => r.outcome !== "ok");
	}

	all(): StageOutcome[] {
		return [...this.results];
	}
}

export function hasCronBudget(input: CronBudgetInput): boolean {
	const nowMs = input.nowMs ?? Date.now();
	return nowMs + input.minBudgetMs <= input.startedAtMs + input.deadlineMs;
}

export function getOptionalStageTimeoutMs(
	input: OptionalStageTimeoutInput,
): number {
	const nowMs = input.nowMs ?? Date.now();
	const remainingMs =
		input.startedAtMs + input.deadlineMs - input.minSaveBudgetMs - nowMs;
	return Math.max(0, remainingMs);
}

export async function runOptionalStage<T>(
	input: RunOptionalStageInput<T>,
): Promise<T> {
	const report = (outcome: OptionalStageOutcome) =>
		input.onOutcome?.({ label: input.label, outcome });

	const timeoutMs = getOptionalStageTimeoutMs(input);
	if (timeoutMs <= 0) {
		console.warn(
			`[discovery:${input.label}] skipped to preserve save/finalize budget`,
		);
		report("skipped_no_budget");
		return input.fallback;
	}

	let timeout: ReturnType<typeof setTimeout> | null = null;
	const task = input
		.task()
		.then((value) => ({ kind: "task" as const, value, errored: false }))
		.catch((err) => {
			console.warn(
				`[discovery:${input.label}] failed:`,
				err instanceof Error ? err.message : String(err),
			);
			return { kind: "task" as const, value: input.fallback, errored: true };
		});
	const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
		timeout = setTimeout(() => {
			console.warn(
				`[discovery:${input.label}] timed out after ${timeoutMs}ms; continuing without optional result`,
			);
			resolve({ kind: "deadline" });
		}, timeoutMs);
	});

	try {
		const winner = await Promise.race([task, deadline]);
		if (winner.kind === "deadline") {
			report("timeout");
			return input.fallback;
		}
		report(winner.errored ? "error" : "ok");
		return winner.value;
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
