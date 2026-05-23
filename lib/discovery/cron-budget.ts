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

export interface RunOptionalStageInput<T> extends OptionalStageTimeoutInput {
	label: string;
	fallback: T;
	task: () => Promise<T>;
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
	const timeoutMs = getOptionalStageTimeoutMs(input);
	if (timeoutMs <= 0) {
		console.warn(
			`[discovery:${input.label}] skipped to preserve save/finalize budget`,
		);
		return input.fallback;
	}

	let timeout: ReturnType<typeof setTimeout> | null = null;
	const task = input.task().catch((err) => {
		console.warn(
			`[discovery:${input.label}] failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return input.fallback;
	});
	const deadline = new Promise<T>((resolve) => {
		timeout = setTimeout(() => {
			console.warn(
				`[discovery:${input.label}] timed out after ${timeoutMs}ms; continuing without optional result`,
			);
			resolve(input.fallback);
		}, timeoutMs);
	});

	try {
		return await Promise.race([task, deadline]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
