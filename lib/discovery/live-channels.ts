/**
 * Registry of Japanese live-commerce platforms used as priority signal in
 * discovery when context === 'live_commerce'.
 *
 * Mirrors `lib/discovery/tv-channels.ts` so the same pool builder
 * (`fetchTvChannelFromBraveSite`) can be reused — only the channel
 * list differs. All entries are `scraped: false` because none of these
 * platforms publish a schedule page we crawl into the `broadcasts` table.
 *
 * NOT the TV-channel registry. Live commerce is a parallel sourcing
 * universe — these platforms host short-form streams and creator-led
 * commerce rather than scheduled TV-style broadcasts.
 */

export interface LiveChannel {
	/** Stable identifier persisted in `discovered_products.tv_channel_source`. */
	slug: string;
	/** Japanese display name for UI. */
	name: string;
	/** Site identifier used for Brave `site:` queries. */
	siteQuery: string;
	/** Always false for v1 — no live platform exposes a scrape-friendly schedule. */
	scraped: false;
}

/**
 * Live commerce platforms ranked by Japanese market relevance + Brave
 * indexability. Conservative v1 list — expand as new platforms gain
 * traction (TikTok Shop JP launched 2025-Q4, separate sandbox required).
 */
export const LIVE_CHANNELS: readonly LiveChannel[] = [
	{ slug: "rakuten_live",  name: "楽天ライブ",        siteQuery: "live.rakuten.co.jp",  scraped: false },
	{ slug: "rakuten_room",  name: "Rakuten ROOM",     siteQuery: "room.rakuten.co.jp",  scraped: false },
	{ slug: "mercari_shops", name: "メルカリShops",     siteQuery: "mercari-shops.com",   scraped: false },
	{ slug: "17live_shop",   name: "17LIVE Shopping",  siteQuery: "17.live",              scraped: false },
	{ slug: "pinkoi_live",   name: "Pinkoi Live",      siteQuery: "pinkoi.com",           scraped: false },
];

/** Look up a live channel by its slug. */
export function getLiveChannelBySlug(slug: string): LiveChannel | undefined {
	return LIVE_CHANNELS.find((c) => c.slug === slug);
}
