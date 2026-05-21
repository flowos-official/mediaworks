/**
 * Reconnaissance: for the 6 discovery channels NOT yet in
 * historical_broadcasts (ropping, rakurakum, ichiban, kachimo, kaidoki,
 * kantv), check (a) what's currently in the DB and (b) whether their
 * sites expose anything that looks like a broadcast schedule we could
 * parse. Lightweight — just fetches index pages and reports keywords +
 * structural hints. Manual follow-up will design each scraper.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { getServiceClient } from "@/lib/supabase";

const CHANNELS = [
	{ slug: "ropping", name: "ロッピングライフ", probeUrls: ["https://ropping.tv-asahi.co.jp/", "https://ropping.tv-asahi.co.jp/onair/"] },
	{ slug: "rakurakum", name: "らくらく茂", probeUrls: ["https://shop.asahi.co.jp/category/RAKURAKU/"] },
	{ slug: "ichiban", name: "いちばん本舗", probeUrls: ["https://shop.tokai-tv.com/", "https://shop.tokai-tv.com/onair/"] },
	{ slug: "kachimo", name: "カチモ", probeUrls: ["https://kachimo.jp/", "https://kachimo.jp/pages/onair"] },
	{ slug: "kaidoki", name: "買いドキ！マーケット", probeUrls: ["https://satv.shop/", "https://satv.shop/onair"] },
	{ slug: "kantv", name: "関テレ", probeUrls: ["https://ktvolm.jp/", "https://ktvolm.jp/onair"] },
] as const;

async function probe(url: string): Promise<{ ok: boolean; status: number; hasScheduleHints: boolean; hints: string[] }> {
	try {
		const res = await fetch(url, {
			redirect: "follow",
			headers: { "User-Agent": "Mozilla/5.0 (compatible; mediaworks-recon/1.0)" },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) return { ok: false, status: res.status, hasScheduleHints: false, hints: [] };
		const html = await res.text();
		const lower = html.toLowerCase();
		const hints: string[] = [];
		const schedulePatterns = [
			"放送スケジュール", "放送予定", "放送時間", "オンエア", "onair", "on-air",
			"番組表", "本日の放送", "今週の放送", "放送日", "schedule",
		];
		for (const pat of schedulePatterns) {
			if (lower.includes(pat.toLowerCase())) hints.push(pat);
		}
		return { ok: true, status: res.status, hasScheduleHints: hints.length > 0, hints };
	} catch (err) {
		return { ok: false, status: 0, hasScheduleHints: false, hints: [(err instanceof Error ? err.message : String(err)).slice(0, 80)] };
	}
}

async function main() {
	const sb = getServiceClient();

	console.log("=== Current historical_broadcasts channel coverage ===");
	const { data: channelRows } = await sb
		.from("historical_broadcasts")
		.select("channel")
		.gte("air_date", new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
	const channelCounts = new Map<string, number>();
	for (const r of channelRows ?? []) {
		channelCounts.set(r.channel, (channelCounts.get(r.channel) ?? 0) + 1);
	}
	for (const [ch, n] of [...channelCounts.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${ch}: ${n} rows (last 30d)`);
	}

	console.log("\n=== Probing remaining 6 channel sites for schedule pages ===");
	for (const c of CHANNELS) {
		console.log(`\n[${c.slug}] ${c.name}`);
		for (const url of c.probeUrls) {
			const r = await probe(url);
			const tag = !r.ok
				? `HTTP ${r.status} ${r.hints[0] ?? ""}`
				: r.hasScheduleHints
					? `✓ has hints: ${r.hints.slice(0, 5).join(", ")}`
					: `(no schedule keywords found)`;
			console.log(`  ${url} → ${tag}`);
			await new Promise((r) => setTimeout(r, 500));
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
