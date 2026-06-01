/**
 * Manual one-shot: clear the ShopCh 'deferred' backlog by re-checking each
 * recent deferred slot's live pgmMovie and queueing any whose video is now
 * available. Same logic the daily cron runs (recoverShopChDeferred), executed
 * locally for immediate catch-up after the PR #84 regression stranded slots.
 *
 *   npx tsx --env-file=.env.local scripts/recover-shopch-deferred.ts [--days=14] [--limit=500]
 *
 * Idempotent (CAS-guarded). After it queues slots, the archive-videos cron (or
 * `npm run drain:archive-queue`) downloads them.
 */
import { recoverShopChDeferred } from "../lib/broadcasts/shopch-deferred-recovery";

function argNum(flag: string, fallback: number): number {
	const raw = process.argv.find((a) => a.startsWith(`--${flag}=`));
	if (!raw) return fallback;
	const n = Number(raw.split("=")[1]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main() {
	const lookbackDays = argNum("days", 14);
	const limit = argNum("limit", 500);
	console.log(`[recover-shopch-deferred] lookback=${lookbackDays}d limit=${limit}`);

	const result = await recoverShopChDeferred({ lookbackDays, limit });
	console.log(JSON.stringify(result, null, 2));
	console.log(
		result.requeued > 0
			? `\nqueued ${result.requeued} slot(s). Run \`npm run drain:archive-queue\` (or wait for the archive cron) to download them.`
			: "\nnothing to queue.",
	);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
