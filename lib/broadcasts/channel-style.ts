// Shared channel metadata + badge palette for the broadcasts calendar UI.
// Single source of truth so DayDetailPanel and HistoricalBroadcasts stay
// consistent.
//
// Scope: 12 channels (qvc + shopch + 10 OA channels with scrapeable schedule
// pages). Discovery uses a different, larger registry —
// `lib/discovery/tv-channels.ts` (15 channels) — that adds Brave site:-only
// channels with no schedule pages. Don't unify the two: this list is the
// "what can we draw on a calendar" set, the other is the "what can we
// search products from" set.
//
// History: btops was removed 2026-05-17 after the site closed.
// ropping + kantv added 2026-05-21 (PR #69 broadcast parsers).
// ropping DELISTED from the calendar 2026-06-18: its on-air list (ropping.jp)
// duplicates テレ朝じゅん散歩 (junsanpo — same TV-Asahi Ropping source, ~82% of
// products shared). Removed from OA_CHANNELS so it no longer renders on the
// calendar; the slug is retained in the type + badge/dot/short maps below so
// preserved historical_broadcasts rows still render gracefully if surfaced.
// roppingParser is also unregistered in lib/historical-crawl/index.ts (no new
// rows) and excluded from the historical-broadcasts search API. Discovery
// sourcing (lib/discovery/*) is intentionally untouched.
// uranoura DELISTED + らくらく茂 (rakuraku) ADDED 2026-06-19 per ABC operator
// feedback: ウラのウラまで is off-air, replaced by らくらく茂 (weekly Mon,
// shop.asahi.co.jp/category/RAKURAKU). uranoura slug retained in the maps below
// for preserved rows; uranouraParser unregistered. Net OA count unchanged (9).
// (discovery already lists らくらく茂 under the separate slug `rakurakum`; the
// two registries stay independent by design.)
// いちばん本舗 (ichiban, 東海テレビ shop.tokai-tv.com) ADDED 2026-06-19 per
// operator feedback — OA count is now 10. Its calendar slug `ichiban` matches
// the existing discovery slug (no rename needed, unlike rakuraku).

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
	| "txd"
	| "ropping"
	| "kantv"
	| "rakuraku"
	| "ichiban";

export const OA_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "japanet", name: "ジャパネット" },
	{ slug: "junsanpo", name: "テレ朝じゅん散歩" },
	{ slug: "ntv", name: "日テレポシュレ" },
	{ slug: "tbs", name: "TBSキニナル" },
	{ slug: "dinos", name: "フジDinos" },
	{ slug: "senobura", name: "ABCせのぶら" },
	{ slug: "txd", name: "テレ東マート" },
	{ slug: "kantv", name: "カンテレSHOPPING" },
	{ slug: "rakuraku", name: "ABCらくらく茂" },
	{ slug: "ichiban", name: "いちばん本舗" },
];

// Channels delisted from the calendar whose historical_broadcasts rows are kept
// in the DB (history preserved). EVERY calendar read/aggregate path over
// historical_broadcasts must exclude these so retained rows never resurface in
// counts, lists, or search — apply via `.neq("channel", ch)`. ropping delisted
// 2026-06-18 (duplicate of junsanpo); uranoura delisted 2026-06-19 (off-air,
// replaced by rakuraku). Discovery sourcing is NOT affected.
export const DELISTED_CALENDAR_CHANNELS = ["ropping", "uranoura"] as const;

export const ALL_CHANNELS: { slug: BroadcastChannelSlug; name: string }[] = [
	{ slug: "qvc", name: "QVC" },
	{ slug: "shopch", name: "Shop CH" },
	...OA_CHANNELS,
];

export const CHANNEL_BADGE: Record<BroadcastChannelSlug, string> = {
	qvc: "bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-500/15 dark:text-purple-200 dark:border-purple-500/30",
	shopch: "bg-red-100 text-red-800 border-red-200 dark:bg-red-500/15 dark:text-red-200 dark:border-red-500/30",
	japanet: "bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-500/15 dark:text-pink-200 dark:border-pink-500/30",
	junsanpo: "bg-cyan-100 text-cyan-800 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-200 dark:border-cyan-500/30",
	ntv: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30",
	tbs: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30",
	dinos: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-500/15 dark:text-rose-200 dark:border-rose-500/30",
	senobura: "bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-200 dark:border-indigo-500/30",
	uranoura: "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/30",
	txd: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/30",
	ropping: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-500/15 dark:text-orange-200 dark:border-orange-500/30",
	kantv: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-500/15 dark:text-teal-200 dark:border-teal-500/30",
	rakuraku: "bg-lime-100 text-lime-800 border-lime-200 dark:bg-lime-500/15 dark:text-lime-200 dark:border-lime-500/30",
	ichiban: "bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-200 dark:border-fuchsia-500/30",
};

// Solid dots for compact calendar-cell rendering. Mirror the badge palette
// at -500 weight so dots stay legible on white and on the selected blue cell.
export const CHANNEL_DOT: Record<BroadcastChannelSlug, string> = {
	qvc: "bg-purple-500",
	shopch: "bg-red-500",
	japanet: "bg-pink-500",
	junsanpo: "bg-cyan-500",
	ntv: "bg-amber-500",
	tbs: "bg-sky-500",
	dinos: "bg-rose-500",
	senobura: "bg-indigo-500",
	uranoura: "bg-violet-500",
	txd: "bg-emerald-500",
	ropping: "bg-orange-500",
	kantv: "bg-teal-500",
	rakuraku: "bg-lime-500",
	ichiban: "bg-fuchsia-500",
};

// One-character abbreviation used on the calendar cell when a tooltip alone
// isn't enough (compact icon mode). Uses the most evocative Japanese
// character from the channel name so distinct channels with similar colors
// remain identifiable. ASCII fallback for qvc/shopch.
export const CHANNEL_SHORT: Record<BroadcastChannelSlug, string> = {
	qvc: "Q",
	shopch: "S",
	japanet: "ジ",
	junsanpo: "散",
	ntv: "ポ",
	tbs: "キ",
	dinos: "デ",
	senobura: "せ",
	uranoura: "ウ",
	txd: "東",
	ropping: "ロ",
	kantv: "関",
	rakuraku: "茂",
	ichiban: "本",
};

export function channelDisplayName(slug: string): string {
	const found = ALL_CHANNELS.find((c) => c.slug === slug);
	return found?.name ?? slug;
}

export function isOAChannel(slug: string): boolean {
	return OA_CHANNELS.some((c) => c.slug === slug);
}
