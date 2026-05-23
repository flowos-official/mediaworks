import { backfillOperatorFitCategories } from "../lib/competitor-fit/category-backfill";
import { getServiceClient } from "../lib/supabase";

function readLimit(): number {
	const raw = process.argv.find((arg) => arg.startsWith("--limit="))?.slice("--limit=".length) ??
		process.env.npm_config_limit ??
		"100";
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("--limit must be a positive number");
	}
	return Math.floor(parsed);
}

async function main() {
	const apply = process.argv.includes("--apply");
	const result = await backfillOperatorFitCategories({
		sb: getServiceClient(),
		limit: readLimit(),
		apply,
	});

	console.log(JSON.stringify({
		event: "operator_fit.category_backfill.summary",
		...result,
	}, null, 2));

	if (!apply) {
		console.log("Dry run only. Re-run with --apply to update competitor_fit_analyses.category.");
	}
}

main().catch((err) => {
	console.error("FATAL:", err instanceof Error ? err.message : err);
	process.exit(1);
});
