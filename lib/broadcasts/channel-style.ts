// Shared channel metadata + badge palette for broadcasts UI. Single source
// of truth so DayDetailPanel and HistoricalBroadcasts stay consistent.

export type BroadcastChannelSlug =
	| "qvc"
	| "shopch"
	| "japanet"
	| "junsanpo"
	| "ntv"
	| "tbs"
	| "dinos"
	| "senobura"
	| "uranoura"
	| "btops";

export const OA_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "japanet", name: "ジャパネット" },
	{ slug: "junsanpo", name: "テレ朝じゅん散歩" },
	{ slug: "ntv", name: "日テレポシュレ" },
	{ slug: "tbs", name: "TBSキニナル" },
	{ slug: "dinos", name: "フジDinos" },
	{ slug: "senobura", name: "ABCせのぶら" },
	{ slug: "uranoura", name: "ABCウラのウラまで" },
	{ slug: "btops", name: "読売B-tops" },
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
	btops: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export function channelDisplayName(slug: string): string {
	const found = ALL_CHANNELS.find((c) => c.slug === slug);
	return found?.name ?? slug;
}

export function isOAChannel(slug: string): boolean {
	return OA_CHANNELS.some((c) => c.slug === slug);
}
