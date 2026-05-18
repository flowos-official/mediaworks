// Shared channel metadata + badge palette for the broadcasts calendar UI.
// Single source of truth so DayDetailPanel and HistoricalBroadcasts stay
// consistent.
//
// Scope: 9 channels (qvc + shopch + 7 OA channels with scrapeable schedule
// pages). Discovery uses a different, larger registry —
// `lib/discovery/tv-channels.ts` (15 channels) — that adds Brave site:-only
// channels with no schedule pages. Don't unify the two: this list is the
// "what can we draw on a calendar" set, the other is the "what can we
// search products from" set.
//
// History: btops was removed 2026-05-17 after the site closed.

export type BroadcastChannelSlug =
	| "qvc"
	| "shopch"
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura";

export const OA_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "japanet", name: "ジャパネット" },
	{ slug: "junsanpo", name: "テレ朝じゅん散歩" },
	{ slug: "ntv", name: "日テレポシュレ" },
	{ slug: "tbs", name: "TBSキニナル" },
	{ slug: "dinos", name: "フジDinos" },
	{ slug: "senobura", name: "ABCせのぶら" },
	{ slug: "uranoura", name: "ABCウラのウラまで" },
];

export const ALL_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "qvc", name: "QVC" },
	{ slug: "shopch", name: "Shop CH" },
	...OA_CHANNELS,
];

export const CHANNEL_BADGE: Record<BroadcastChannelSlug, string> = {
	qvc: "bg-purple-100 text-purple-800 border-purple-200",
	shopch: "bg-red-100 text-red-800 border-red-200",
	japanet: "bg-red-100 text-red-800 border-red-200",
	junsanpo: "bg-cyan-100 text-cyan-800 border-cyan-200",
	ntv: "bg-amber-100 text-amber-800 border-amber-200",
	tbs: "bg-sky-100 text-sky-800 border-sky-200",
	dinos: "bg-rose-100 text-rose-800 border-rose-200",
	senobura: "bg-indigo-100 text-indigo-800 border-indigo-200",
	uranoura: "bg-purple-100 text-purple-800 border-purple-200",
};

export function channelDisplayName(slug: string): string {
	const found = ALL_CHANNELS.find((c) => c.slug === slug);
	return found?.name ?? slug;
}

export function isOAChannel(slug: string): boolean {
	return OA_CHANNELS.some((c) => c.slug === slug);
}
