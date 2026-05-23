import { getServiceClient } from "../lib/supabase";
import {
	buildDiscoveryPromotionInsert,
	formatPromotionError,
	promoteDiscoveredProductToResearch,
	type DiscoveredProductForPromotion,
} from "../lib/discovery/promote-to-research";

interface Args {
	id?: string;
	apply: boolean;
	triggerSynthesis: boolean;
}

function parseArgs(argv: string[]): Args {
	return {
		id: argv.find((arg) => arg.startsWith("--id="))?.slice("--id=".length),
		apply: argv.includes("--apply"),
		triggerSynthesis: !argv.includes("--no-synthesis"),
	};
}

function printUsage() {
	console.log(
		[
			"Usage:",
			"  npx tsx --env-file=.env.local scripts/promote-discovered-to-research.ts",
			"  npx tsx --env-file=.env.local scripts/promote-discovered-to-research.ts --id=<discovered_product_id>",
			"  npx tsx --env-file=.env.local scripts/promote-discovered-to-research.ts --id=<id> --apply",
			"",
			"Default mode is dry-run. Use --apply to insert a products row and deep_dive feedback.",
			"Use --no-synthesis with --apply to skip the async research synthesis trigger.",
		].join("\n"),
	);
}

async function findCandidate(sb: ReturnType<typeof getServiceClient>) {
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, product_url, thumbnail_url, category, price_jpy, tv_fit_reason, c_package, enrichment_status, created_at")
		.eq("enrichment_status", "completed")
		.order("created_at", { ascending: false })
		.limit(20);
	if (error) throw error;
	const candidates = data ?? [];
	for (const candidate of candidates) {
		const { data: existing, error: existingError } = await sb
			.from("products")
			.select("id")
			.eq("discovered_product_id", candidate.id)
			.maybeSingle();
		if (existingError) throw existingError;
		if (!existing) return candidate;
	}
	return null;
}

async function loadCandidate(sb: ReturnType<typeof getServiceClient>, id: string) {
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, product_url, thumbnail_url, category, price_jpy, tv_fit_reason, c_package, enrichment_status")
		.eq("id", id)
		.maybeSingle();
	if (error) throw error;
	return data;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (process.argv.includes("--help")) {
		printUsage();
		return;
	}

	const sb = getServiceClient();
	const candidate = args.id ? await loadCandidate(sb, args.id) : await findCandidate(sb);
	if (!candidate) {
		console.error("No enrichment-completed discovered product is available for promotion.");
		process.exit(1);
	}

	const dp = {
		...candidate,
		c_package: (candidate.c_package as DiscoveredProductForPromotion["c_package"]) ?? null,
	} as DiscoveredProductForPromotion;

	if (dp.enrichment_status !== "completed") {
		console.error(`Candidate ${dp.id} is not enrichment-completed (${dp.enrichment_status}).`);
		process.exit(1);
	}

	if (!args.apply) {
		const insert = buildDiscoveryPromotionInsert(dp);
		console.log(
			JSON.stringify(
				{
					mode: "dry-run",
					discoveredProductId: dp.id,
					name: dp.name,
					wouldInsert: insert,
					next: `Re-run with --id=${dp.id} --apply to promote this product.`,
				},
				null,
				2,
			),
		);
		return;
	}

	const result = await promoteDiscoveredProductToResearch(sb, dp.id, {
		triggerSynthesis: args.triggerSynthesis,
	});
	console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
}

void main().catch((err) => {
	console.error(formatPromotionError(err));
	process.exit(1);
});
