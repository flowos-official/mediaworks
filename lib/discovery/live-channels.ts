/**
 * Registry of Japanese live-commerce platforms used as priority signal in
 * discovery when context === 'live_commerce'.
 *
 * Mirrors `lib/discovery/tv-channels.ts` so the same pool builder
 * (`fetchTvChannelFromBraveSite`) can be reused — only the channel
 * list differs. All entries are `scraped: false` because no Japanese
 * live-commerce platform exposes a schedule page we crawl into the
 * `broadcasts` table.
 *
 * Conservative v2 list. Four platforms from the original v1 registry
 * (rakuten_live, mercari_shops, 17live_shop, pinkoi_live) were removed
 * after verification: 楽天LIVE / メルカリチャンネル shut down years ago,
 * 17.live commerce is SaaS-embedded with no central catalog, and Pinkoi
 * has marginal Japan LC traction. See spec
 * docs/superpowers/specs/2026-05-24-live-commerce-discovery-redesign-design.md §2.
 *
 * Adding new entries: a platform qualifies only if it has a publicly
 * crawlable product-page surface that Brave can site:search.
 */

export interface LiveChannel {
	/** Stable identifier persisted in `discovered_products.tv_channel_source`. */
	slug: string;
	/** Japanese display name for UI. */
	name: string;
	/** Site identifier used for Brave `site:` queries. May include a path prefix. */
	siteQuery: string;
	/** Always false for v2 — no live platform exposes a scrape-friendly schedule. */
	scraped: false;
}

export const LIVE_CHANNELS: readonly LiveChannel[] = [
	{
		slug: "rakuten_room",
		name: "Rakuten ROOM",
		siteQuery: "room.rakuten.co.jp",
		scraped: false,
	},
	{
		slug: "rakuten_shopping_channel",
		name: "楽天市場ショッピングチャンネル",
		siteQuery: "event.rakuten.co.jp/campaign/live-shopping",
		scraped: false,
	},
];

/** Look up a live channel by its slug. */
export function getLiveChannelBySlug(slug: string): LiveChannel | undefined {
	return LIVE_CHANNELS.find((c) => c.slug === slug);
}
