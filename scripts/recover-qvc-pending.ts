/**
 * Recovery for QVC slots stuck in `video_status='pending'` despite being in
 * the whitelist with a usable lead `qvc_products.video_url`.
 *
 * The same logic also runs automatically at the end of the daily-broadcasts
 * cron — this script is a manual/CLI surface for the same operation, useful
 * for one-off recoveries (e.g. after a backfill).
 *
 * Usage: npm run recover:qvc-pending
 */
import { recoverQvcPending } from "../lib/broadcasts/qvc-pending-recovery";

async function main(): Promise<void> {
	const result = await recoverQvcPending();
	console.log("[recover] DONE");
	console.log(`  scanned                : ${result.scanned}`);
	console.log(`  → queued               : ${result.queued}`);
	console.log(`  → deferred             : ${result.deferred}`);
	console.log(`  skipped (out-of-whitelist): ${result.skippedOutOfWhitelist}`);
	console.log(`  skipped (no qvc_products) : ${result.skippedNoProduct}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
