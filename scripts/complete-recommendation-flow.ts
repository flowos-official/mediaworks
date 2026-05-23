import { getServiceClient } from "../lib/supabase";
import {
	formatPromotionError,
	promoteDiscoveredProductToResearch,
} from "../lib/discovery/promote-to-research";
import {
	buildOperatorFlowPlan,
	parseOperatorFlowArgs,
	type OperatorFlowState,
} from "../lib/recommendation/operator-flow";
import { generateScreenplay } from "../lib/screenplay/generator";
import { synthesizeProductResearch } from "../lib/research/synthesize-product";
import { loadProductBriefForScreenplay } from "../lib/screenplay/product-brief";
import type { ProductBrief } from "../lib/screenplay/types";

type ServiceClient = ReturnType<typeof getServiceClient>;

function printUsage() {
	console.log(
		[
			"Usage:",
			"  npm run complete:recommendation-flow",
			"  npm run complete:recommendation-flow -- --id=<discovered_product_id>",
			"  npm run complete:recommendation-flow -- --id=<id> --apply",
			"  npm run complete:recommendation-flow -- --id=<id> --apply --run-synthesis",
			"  npm run complete:recommendation-flow -- --id=<id> --apply --create-screenplay --wait",
			"",
			"Default mode is dry-run. Mutating stages require --apply.",
			"--run-synthesis runs the same research synthesis service directly from the CLI.",
			"--create-screenplay starts the screenplay workflow only after research_results exists.",
		].join("\n"),
	);
}

async function findCandidate(sb: ServiceClient) {
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, name, created_at")
		.eq("enrichment_status", "completed")
		.order("created_at", { ascending: false })
		.limit(20);
	if (error) throw error;
	for (const candidate of data ?? []) {
		const { data: existing, error: existingError } = await sb
			.from("products")
			.select("id")
			.eq("discovered_product_id", candidate.id)
			.maybeSingle();
		if (existingError) throw existingError;
		if (!existing) return candidate as { id: string; name: string };
	}
	return data?.[0] ? ({ id: data[0].id, name: data[0].name } as { id: string; name: string }) : null;
}

async function loadOperatorState(
	sb: ServiceClient,
	discoveredProductId: string,
): Promise<OperatorFlowState> {
	const { data: promoted, error: promotedError } = await sb
		.from("products")
		.select("id")
		.eq("discovered_product_id", discoveredProductId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (promotedError) throw promotedError;

	const promotedProductId = promoted?.id as string | undefined;
	const { data: research, error: researchError } = promotedProductId
		? await sb
				.from("research_results")
				.select("product_id")
				.eq("product_id", promotedProductId)
				.maybeSingle()
		: { data: null, error: null };
	if (researchError) throw researchError;

	const { data: screenplay, error: screenplayError } = promotedProductId
		? await sb
				.from("screenplays")
				.select("id, status")
				.eq("product_id", promotedProductId)
				.order("created_at", { ascending: false })
				.limit(1)
				.maybeSingle()
		: { data: null, error: null };
	if (screenplayError) throw screenplayError;

	return {
		discoveredProductId,
		promotedProductId: promotedProductId ?? null,
		hasResearchResult: !!research,
		promotedScreenplayId: (screenplay?.id as string | undefined) ?? null,
		promotedScreenplayStatus: (screenplay?.status as string | undefined) ?? null,
	};
}

function printPlan(state: OperatorFlowState, argv: string[]) {
	const args = parseOperatorFlowArgs(argv);
	const plan = buildOperatorFlowPlan(state, args);
	console.log(JSON.stringify({ mode: plan.mode, state, steps: plan.steps }, null, 2));
}

async function createScreenplayFromProduct(
	sb: ServiceClient,
	productId: string,
): Promise<{ screenplayId: string; runId: string }> {
	const briefResult = await loadProductBriefForScreenplay(sb, productId);
	if (!briefResult.ok) {
		throw new Error(`failed to build screenplay brief: ${briefResult.error}`);
	}
	const productBrief: ProductBrief = briefResult.brief;

	const { data: existing, error: existingError } = await sb
		.from("screenplays")
		.select("id, status")
		.eq("product_id", productId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (existingError) throw existingError;

	let screenplayId = existing?.id as string | undefined;
	if (screenplayId) {
		const { error: updateError } = await sb
			.from("screenplays")
			.update({
				title: productBrief.name,
				product_info_snapshot: productBrief,
				status: "generating",
				updated_at: new Date().toISOString(),
			})
			.eq("id", screenplayId);
		if (updateError) throw new Error(`screenplay update failed: ${updateError.message}`);
	} else {
		const { data: inserted, error: insertError } = await sb
			.from("screenplays")
			.insert({
				product_id: productId,
				title: productBrief.name,
				product_info_snapshot: productBrief,
				status: "generating",
			})
			.select("id")
			.single();
		if (insertError || !inserted) {
			throw new Error(`screenplay insert failed: ${insertError?.message ?? "no row"}`);
		}
		screenplayId = inserted.id as string;
	}

	try {
		const generated = await generateScreenplay({
			mode: "initial",
			productBrief,
		});
		const { data: existingVersions, error: versionLookupError } = await sb
			.from("screenplay_versions")
			.select("version_number")
			.eq("screenplay_id", screenplayId)
			.order("version_number", { ascending: false })
			.limit(1);
		if (versionLookupError) throw versionLookupError;
		const nextVersion = ((existingVersions?.[0]?.version_number as number | undefined) ?? 0) + 1;

		const { data: version, error: versionError } = await sb
			.from("screenplay_versions")
			.insert({
				screenplay_id: screenplayId,
				version_number: nextVersion,
				markdown: generated.markdown,
				feedback: null,
				base_version_id: null,
				model: generated.model,
				thinking_level: generated.thinkingLevel,
			})
			.select("id")
			.single();
		if (versionError || !version) {
			throw new Error(`screenplay version insert failed: ${versionError?.message ?? "no row"}`);
		}

		const runId = `cli-sync:${version.id}`;
		const { error: readyError } = await sb
			.from("screenplays")
			.update({
				current_version_id: version.id,
				status: "ready",
				last_run_id: runId,
				updated_at: new Date().toISOString(),
			})
			.eq("id", screenplayId);
		if (readyError) throw new Error(`screenplay ready update failed: ${readyError.message}`);
		return { screenplayId, runId };
	} catch (error) {
		await sb
			.from("screenplays")
			.update({ status: "failed", updated_at: new Date().toISOString() })
			.eq("id", screenplayId);
		throw error;
	}
}

async function waitForScreenplay(
	sb: ServiceClient,
	screenplayId: string,
	timeoutMs: number,
): Promise<string> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const { data, error } = await sb
			.from("screenplays")
			.select("status")
			.eq("id", screenplayId)
			.maybeSingle();
		if (error) throw error;
		const status = (data?.status as string | undefined) ?? "unknown";
		if (status === "ready" || status === "failed") return status;
		await new Promise((resolve) => setTimeout(resolve, 3000));
	}
	return "timeout";
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes("--help")) {
		printUsage();
		return;
	}

	const args = parseOperatorFlowArgs(argv);
	const sb = getServiceClient();
	const candidate = args.id ? { id: args.id, name: args.id } : await findCandidate(sb);
	if (!candidate) {
		throw new Error("No enrichment-completed discovered product is available.");
	}

	let state = await loadOperatorState(sb, candidate.id);
	if (!args.apply) {
		printPlan(state, argv);
		return;
	}

	if (!state.promotedProductId) {
		const promoted = await promoteDiscoveredProductToResearch(sb, candidate.id, {
			triggerSynthesis: false,
		});
		console.log(JSON.stringify({ stage: "promote", ...promoted }, null, 2));
		state = await loadOperatorState(sb, candidate.id);
	}

	if (args.runSynthesis && state.promotedProductId && !state.hasResearchResult) {
		await synthesizeProductResearch(state.promotedProductId, sb);
		console.log(JSON.stringify({ stage: "synthesis", productId: state.promotedProductId }, null, 2));
		state = await loadOperatorState(sb, candidate.id);
	}

	const needsScreenplay =
		!state.promotedScreenplayId || state.promotedScreenplayStatus !== "ready";
	if (args.createScreenplay && state.promotedProductId && needsScreenplay) {
		if (!state.hasResearchResult) {
			throw new Error("Cannot create screenplay before promoted product has research_results.");
		}
		const created = await createScreenplayFromProduct(sb, state.promotedProductId);
		console.log(JSON.stringify({ stage: "screenplay", ...created }, null, 2));
		if (args.wait) {
			const status = await waitForScreenplay(sb, created.screenplayId, 10 * 60 * 1000);
			console.log(JSON.stringify({ stage: "screenplay_wait", status }, null, 2));
		}
		state = await loadOperatorState(sb, candidate.id);
	}

	printPlan(state, argv);
	console.log("Next: npm run smoke:recommendation-flow:strict");
}

void main().catch((err) => {
	console.error(formatPromotionError(err));
	process.exit(1);
});
