import { getServiceClient } from "../lib/supabase";

async function main(): Promise<void> {
	const sb = getServiceClient();
	const { data } = await sb
		.from("channel_categories")
		.select("channel, category")
		.order("channel", { ascending: true });
	console.log("channel_categories whitelist:");
	const byChannel = new Map<string, string[]>();
	for (const r of (data ?? []) as Array<{ channel: string; category: string }>) {
		const arr = byChannel.get(r.channel) ?? [];
		arr.push(r.category);
		byChannel.set(r.channel, arr);
	}
	for (const [ch, cats] of byChannel) {
		console.log(`\n${ch} (${cats.length}):`);
		for (const c of cats) console.log(`  - ${c}`);
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
