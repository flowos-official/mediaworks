/**
 * Registry of Japanese TV-shopping channels used as priority signal in discovery.
 * `scraped: true` channels are sourced from the `broadcasts` table (populated by
 * Broadcast Calendar Phase A). `scraped: false` channels are sourced via
 * Brave site:-restricted search.
 *
 * Source: docs/検索参考サイト (2).xlsx rows 1-25.
 */

export interface TvChannel {
	/** Stable identifier persisted in DB. */
	slug: string;
	/** Japanese display name for UI. */
	name: string;
	/** Site identifier used for Brave `site:` queries. May include a path prefix
	 *  when two channels share a host (せのぶら / らくらく茂 both live on
	 *  shop.asahi.co.jp). */
	siteQuery: string;
	/** True when the channel is populated by the broadcasts cron. */
	scraped: boolean;
}

/**
 * The `siteQuery` field goes directly into a Brave `site:` query. For channels
 * whose shopping section is a subdirectory of a larger host (TBS, ディノス,
 * せのぶら, らくらく茂), the value includes a path prefix so unrelated content
 * on the same host is excluded.
 */
export const TV_CHANNELS: readonly TvChannel[] = [
	{ slug: "shopch",    name: "ショップチャンネル",     siteQuery: "shopch.jp",                            scraped: true  },
	{ slug: "qvc",       name: "QVC",                  siteQuery: "qvc.jp",                              scraped: true  },
	{ slug: "ntv",       name: "日テレ",                siteQuery: "shop.ntv.co.jp",                      scraped: false },
	{ slug: "tbs",       name: "TBS",                  siteQuery: "tbs.co.jp/shopping",                  scraped: false },
	{ slug: "dinos",     name: "ディノス",              siteQuery: "dinos.co.jp/tv",                      scraped: false },
	{ slug: "ropping",   name: "ロッピングライフ",       siteQuery: "ropping.tv-asahi.co.jp",              scraped: false },
	{ slug: "senobura",  name: "せのぶら本舗",          siteQuery: "shop.asahi.co.jp/category/SENOBURA",  scraped: false },
	{ slug: "rakurakum", name: "らくらく茂",            siteQuery: "shop.asahi.co.jp/category/RAKURAKU",  scraped: false },
	{ slug: "ichiban",   name: "いちばん本舗",          siteQuery: "shop.tokai-tv.com",                   scraped: false },
	{ slug: "kachimo",   name: "カチモ",                siteQuery: "kachimo.jp",                          scraped: false },
	{ slug: "kaidoki",   name: "買いドキ！マーケット",   siteQuery: "satv.shop",                           scraped: false },
	{ slug: "kantv",     name: "関テレ",                siteQuery: "ktvolm.jp",                           scraped: false },
];

/** Look up a channel by its slug. Returns undefined if not registered. */
export function getChannelBySlug(slug: string): TvChannel | undefined {
	return TV_CHANNELS.find((c) => c.slug === slug);
}

/** Map a Phase A broadcasts.channel value to a TvChannel slug. */
export function broadcastsChannelToSlug(channel: "shopch" | "qvc"): "shopch" | "qvc" {
	return channel;
}

/**
 * Convert a list of slugs to the canonical persisted form:
 * alphabetical sort + comma-join. Returns null when the input is empty.
 * The alphabetical sort is what makes the persisted value deterministic
 * (so "qvc,shopch" never appears as "shopch,qvc" and equality holds).
 */
export function serializeChannelSlugs(slugs: readonly string[]): string | null {
	if (slugs.length === 0) return null;
	const unique = Array.from(new Set(slugs));
	unique.sort();
	return unique.join(",");
}

/** Inverse of serializeChannelSlugs. Returns [] for null/empty. */
export function parseChannelSlugs(value: string | null | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((s) => s.trim()).filter(Boolean);
}
