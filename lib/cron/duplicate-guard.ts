/**
 * Guard against a cron path being invoked twice in quick succession.
 *
 * Since at least 2026-08, every scheduled job here has run twice a day, the two
 * invocations landing 26-47 seconds apart: the calendar and OA sources are
 * scraped twice, every AI and search call is paid for twice, and a night's
 * discovery produces two runs instead of one. The second invocation has also
 * been observed executing an older build, so it can fail on configuration the
 * current build no longer has — which is how a dead API key kept reappearing in
 * the run history hours after it was replaced.
 *
 * The scheduled jobs themselves are far apart (the OA crawl's two daily runs sit
 * eight hours apart), so a short window separates "the same trigger twice" from
 * "the next scheduled run" without ambiguity.
 *
 * NO `import "server-only"` — imported by a tsx unit test.
 */

/** Two invocations closer together than this are the same trigger, not a schedule. */
export const DUPLICATE_WINDOW_MS = 5 * 60_000;

/**
 * True when a run that started at `lastRunAt` is close enough to `now` that this
 * invocation is a repeat of it.
 *
 * An absent or unparseable timestamp means there is nothing to repeat, so the
 * caller proceeds — this guard must never be the reason a job stops running.
 */
export function isDuplicateInvocation(
	lastRunAt: string | Date | null | undefined,
	now: Date = new Date(),
	windowMs: number = DUPLICATE_WINDOW_MS,
): boolean {
	if (!lastRunAt) return false;
	const started = lastRunAt instanceof Date ? lastRunAt : new Date(lastRunAt);
	const ms = started.getTime();
	if (!Number.isFinite(ms)) return false;
	const elapsed = now.getTime() - ms;
	// A future timestamp (clock skew between the app and the database) is not a
	// duplicate of anything that has happened yet.
	if (elapsed < 0) return false;
	return elapsed < windowMs;
}

/** Which build served this invocation, for telling the two apart in logs. */
export function invocationOrigin(): string {
	const id = process.env.VERCEL_DEPLOYMENT_ID ?? "local";
	const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7);
	return sha ? `${id} @${sha}` : id;
}

export type DuplicateAction = "proceed" | "skip" | "wait";

/**
 * What to do when a run already exists inside the window.
 *
 * Skipping on sight looks right and is wrong: the invocation that wins the race
 * on live_commerce is a stale build that fails ~80 s in, so a healthy caller
 * that stands down while that run is still going hands it the night. Only a run
 * that has actually settled without failing earns an immediate skip; one still
 * in flight has to be waited out.
 */
export function decideDuplicateAction(
	lastRun: { run_at: string; status: string } | null | undefined,
	now: Date = new Date(),
	windowMs: number = DUPLICATE_WINDOW_MS,
): DuplicateAction {
	if (!lastRun || !isDuplicateInvocation(lastRun.run_at, now, windowMs)) return "proceed";
	if (lastRun.status === "failed") return "proceed";
	if (lastRun.status === "running") return "wait";
	return "skip";
}

export type BlockingRunOutcome = "failed" | "settled" | "still-running";

/**
 * Wait for the run that is currently holding a context's slot to finish.
 *
 * A stale build wins this race most nights on one context and fails ~80s in on
 * a credential the current build no longer uses. First-one-wins would hand the
 * night to that build and drop the real run, so the healthy caller waits it out
 * and takes over — but only if it actually failed. A run that succeeds keeps
 * the slot, which is the whole point of the guard.
 */
export async function waitForBlockingRun(
	readStatus: () => Promise<{ status: string; run_at: string } | null>,
	options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BlockingRunOutcome> {
	const timeoutMs = options.timeoutMs ?? 150_000;
	const pollMs = options.pollMs ?? 10_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const row = await readStatus();
		if (!row) return "failed"; // the blocking row is gone — nothing holds the slot
		if (row.status === "failed") return "failed";
		if (row.status !== "running") return "settled";
		if (Date.now() >= deadline) return "still-running";
		await sleep(pollMs);
	}
}

/** True when an insert was refused by the duplicate-run trigger. */
export function isDuplicateRunError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err ?? "");
	return /duplicate (crawl|discovery) invocation/i.test(message);
}
