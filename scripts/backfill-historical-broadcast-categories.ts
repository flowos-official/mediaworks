import { backfillHistoricalBroadcastCategories } from "../lib/historical-crawl/category-backfill";
import { getServiceClient } from "../lib/supabase";

function readNumberFlag(name: string, defaultValue: number): number {
	const prefix = `--${name}=`;
	const envName = `npm_config_${name.replace(/-/g, "_")}`;
	const raw =
		process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ??
		process.env[envName];
	if (!raw) return defaultValue;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`--${name} must be a positive number`);
	}
	return Math.floor(parsed);
}

async function main() {
	const apply = process.argv.includes("--apply");
	const rowLimit = readNumberFlag("row-limit", 500);
	const maxProductNames = readNumberFlag("max-products", 50);

	const result = await backfillHistoricalBroadcastCategories({
		sb: getServiceClient(),
		rowLimit,
		maxProductNames,
		apply,
	});

	console.log(JSON.stringify({
		event: "historical_broadcasts.category_backfill.summary",
		...result.summary,
		assignments: result.assignments.slice(0, 20),
	}, null, 2));

	if (!apply) {
		console.log(
			"Dry run only. Re-run with --apply to update historical_broadcasts.category.",
		);
	}
}

main().catch((err) => {
	console.error("FATAL:", err instanceof Error ? err.message : err);
	process.exit(1);
});
