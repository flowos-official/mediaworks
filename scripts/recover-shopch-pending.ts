/**
 * One-shot: sweep ShopCh slots stranded in video_status='pending' (whitelist +
 * already-aired) back to 'queued' so the archive cron/drain picks up their video.
 * Same logic the archive-videos cron now runs (recoverShopChPending), executed
 * locally with a configurable lookback for the initial backlog.
 *
 *   npx tsx --env-file=.env.local scripts/recover-shopch-pending.ts [lookbackDays] [limit]
 *   (defaults: lookbackDays=400, limit=1000 — covers the full historical backlog)
 */
import { recoverShopChPending } from "../lib/broadcasts/shopch-pending-recovery";

async function main() {
	const lookbackDays = Number(process.argv[2]) || 400;
	const limit = Number(process.argv[3]) || 1000;
	console.log(`recoverShopChPending: lookbackDays=${lookbackDays} limit=${limit}`);
	const result = await recoverShopChPending({ lookbackDays, limit });
	console.log("result:", JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
