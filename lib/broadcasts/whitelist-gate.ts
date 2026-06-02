/**
 * Display-time category whitelist gate for QVC / ShopCh calendar slots.
 * Extracted from UnifiedDayDetailPanel so it is unit-testable without React.
 *
 * Policy (2026-06-03, fail-open): a slot with NO category (null / "") is
 * UNCLASSIFIED, not non-whitelist — show it. Only hide a QVC/ShopCh slot whose
 * category is KNOWN and not on the whitelist. OA channels have no whitelist.
 * See CLAUDE.md "Broadcast Calendar".
 */
export const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
	qvc: [
		"ビューティ",
		"ファッション",
		"健康・ダイエット",
		"ホーム・キッチン",
		"レジャー・ホビー",
		"家電",
	],
	shopch: [
		"コスメ",
		"グルメ・お酒",
		"美容・ダイエット・フィットネス",
		"靴・バッグ・小物・インナー",
		"ファッション",
		"ミックス",
		"ホーム・インテリア",
		"家電",
		"ジュエリー",
		"旅・趣味・暮らし・コレクターズ",
	],
};

const QVC_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.qvc);
const SHOPCH_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.shopch);

/**
 * Fail-open: unclassified (null/empty) QVC/ShopCh slots are shown; only a
 * known-and-non-whitelist category is hidden. Non-QVC/ShopCh channels pass.
 */
export function isWhitelistedSlot(channel: string, category: string | null): boolean {
	if (channel === "qvc") return !category || QVC_WHITELIST.has(category);
	if (channel === "shopch") return !category || SHOPCH_WHITELIST.has(category);
	return true;
}
