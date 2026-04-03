export interface TVChannel {
	name: string;
	url: string;
	type: "TV通販" | "EC" | "カタログ通販" | "クラウドファンディング" | "その他";
	broadcaster?: string;
	description: string;
}

export const JP_TV_SHOPPING_CHANNELS: TVChannel[] = [
	{ name: "ショップチャンネル", url: "https://www.shopch.jp/", type: "TV通販", broadcaster: "Jupiter Shop Channel", description: "日本最大のTVショッピング専門チャンネル。24時間生放送。" },
	{ name: "QVC Japan", url: "https://qvc.jp/", type: "TV通販", broadcaster: "QVC", description: "米国QVC傘下。ライブ感のある商品紹介が強み。" },
	{ name: "日テレポシュレ", url: "https://shop.ntv.co.jp/s/tvshopping/", type: "TV通販", broadcaster: "日本テレビ", description: "日テレ通販。バラエティ番組連動商品が多い。" },
	{ name: "TBSショッピング", url: "https://www.tbs.co.jp/shopping/", type: "TV通販", broadcaster: "TBS", description: "TBS系列の通販。情報番組との連動。" },
	{ name: "ディノス", url: "https://www.dinos.co.jp/tv/", type: "TV通販", broadcaster: "フジテレビ", description: "フジテレビ系列。カタログ通販からTV通販まで幅広い。" },
	{ name: "ロッピングライフ", url: "https://ropping.tv-asahi.co.jp/", type: "TV通販", broadcaster: "テレビ朝日", description: "テレ朝系通販。じゅん散歩等の番組連動。" },
	{ name: "せのぶら本舗", url: "https://shop.asahi.co.jp/category/SENOBURA/", type: "TV通販", broadcaster: "朝日放送", description: "朝日放送系列の通販番組。" },
	{ name: "いちばん本舗", url: "https://shop.tokai-tv.com/shop/", type: "TV通販", broadcaster: "東海テレビ", description: "東海テレビの通販番組。中部地方メイン。" },
	{ name: "カチモ", url: "https://kachimo.jp/", type: "TV通販", broadcaster: "テレビ東京", description: "テレビ東京の通販サイト。" },
	{ name: "関テレショッピング", url: "https://ktvolm.jp/", type: "TV通販", broadcaster: "関西テレビ", description: "関西テレビ系列。関西圏メイン。" },
];

export const JP_OTHER_SHOPPING_SITES: TVChannel[] = [
	{ name: "梶原産業", url: "https://www.kajihara.co.jp/business/", type: "その他", description: "卸売・流通業者。" },
	{ name: "カタログハウス", url: "http://www.cataloghouse.co.jp/", type: "カタログ通販", description: "老舗カタログ通販。通販生活。" },
	{ name: "ニッセン", url: "https://www.nissen.co.jp/", type: "カタログ通販", description: "大手カタログ通販。" },
	{ name: "Makuake", url: "https://www.makuake.com/", type: "クラウドファンディング", description: "応援購入型クラファン。新商品ローンチに最適。" },
	{ name: "ビックカメラ", url: "https://www.biccamera.com/", type: "EC", description: "大手家電量販店EC。" },
	{ name: "ファミリーライフ", url: "http://family-life.biz/", type: "EC", description: "生活用品EC。" },
	{ name: "通販歳時記", url: "https://www.tsuhan-saijiki.jp/", type: "その他", description: "通販業界情報サイト。" },
];

export function buildChannelReferencePrompt(): string {
	const tvLines = JP_TV_SHOPPING_CHANNELS.map(
		(ch) => `- ${ch.name} (${ch.broadcaster ?? ""}): ${ch.url} — ${ch.description}`,
	).join("\n");

	const otherLines = JP_OTHER_SHOPPING_SITES.map(
		(ch) => `- ${ch.name} [${ch.type}]: ${ch.url} — ${ch.description}`,
	).join("\n");

	return `=== 日本TV通販チャンネル一覧 ===\n${tvLines}\n\n=== その他ショッピングサイト ===\n${otherLines}`;
}
