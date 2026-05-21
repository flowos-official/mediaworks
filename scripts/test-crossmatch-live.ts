/**
 * Live smoke test for findRakutenCrossMatch — calls the real Rakuten API
 * with a few known TV-channel product names and prints the matches found.
 * Use to verify the cross-match logic in production-equivalent mode.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { findRakutenCrossMatch } from "@/lib/discovery/rakuten-crossmatch";

const samples = [
	// Specific product names (with model numbers / specific brand+series)
	"パナソニック ナノケア EH-NA0J ヘアドライヤー",
	"アイリスオーヤマ 布団乾燥機 カラリエ FK-W2",
	"レコルト ハンディブレンダー RHB-2",
	"ティファール 圧力鍋 クリプソミニット 6L",
	// Generic ones to make sure they correctly fail
	"japanet ジャパネット ふとん乾燥機",
	"カチモ 美顔器",
];

async function main() {
	for (const name of samples) {
		console.log(`\n--- input: "${name}" ---`);
		try {
			const match = await findRakutenCrossMatch(name);
			if (match) {
				console.log(`  ✓ MATCH (overlap=${match.similarityScore})`);
				console.log(`    rakuten: ${match.itemName.slice(0, 60)}`);
				console.log(`    review: ★${match.reviewAvg.toFixed(1)} (${match.reviewCount}件)`);
				console.log(`    price:  ¥${match.priceJpy}`);
				console.log(`    url:    ${match.itemUrl}`);
			} else {
				console.log(`  ✗ no match (too generic or no overlap)`);
			}
		} catch (err) {
			console.log(`  ! error: ${err instanceof Error ? err.message : err}`);
		}
		// Respect Rakuten 1 req/sec rate limit
		await new Promise((r) => setTimeout(r, 1100));
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
