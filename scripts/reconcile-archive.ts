/**
 * Manual archive reconciliation — same logic the daily cron runs.
 *   npx tsx --env-file=.env.local scripts/reconcile-archive.ts [lookbackDays]
 */
import { reconcileArchiveCoverage } from "../lib/broadcasts/archive-reconciliation";

async function main() {
  const lookbackDays = Number(process.argv[2]) || undefined;
  const r = await reconcileArchiveCoverage({ lookbackDays });
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
