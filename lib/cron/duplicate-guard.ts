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
