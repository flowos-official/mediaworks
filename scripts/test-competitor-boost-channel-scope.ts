import { loadHotCompetitorCategories, loadCategoryFitWeights } from "@/lib/discovery/competitor-trend-boost";

async function main() {
	const global = await loadHotCompetitorCategories();
	const scoped = await loadHotCompetitorCategories(["qvc"]);
	if (scoped.length > global.length) throw new Error("scoped should be ≤ global");

	const fitGlobal = await loadCategoryFitWeights();
	const fitScoped = await loadCategoryFitWeights(["qvc"]);
	if (fitScoped.size > fitGlobal.size) throw new Error("scoped fit map should be ≤ global");

	console.log(`✓ competitor-boost-channel-scope: global=${global.length}, scoped=${scoped.length}`);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
