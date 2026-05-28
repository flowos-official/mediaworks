import { loadChannelTasteProfile } from "@/lib/discovery/channel-taste";

async function main() {
	// Tier 1 — QVC should have category data
	const qvc = await loadChannelTasteProfile("qvc", 30);
	if (qvc.source_tier !== 1) throw new Error(`expected QVC source_tier=1, got ${qvc.source_tier}`);
	if (qvc.sample_size === 0) throw new Error(`QVC should have broadcasts.category populated`);

	// Tier 4 — unknown channel
	const unknown = await loadChannelTasteProfile("zzz_unknown", 30);
	if (unknown.source_tier !== 4) throw new Error(`unknown channel should be tier 4`);
	if (unknown.sample_size !== 0) throw new Error(`unknown channel sample_size should be 0`);

	console.log(`✓ channel-taste: qvc tier=${qvc.source_tier} samples=${qvc.sample_size}, unknown tier=${unknown.source_tier}`);
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
