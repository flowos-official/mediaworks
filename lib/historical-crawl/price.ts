/**
 * Parse a JP price string (mirrors the OA xlsx import logic).
 *
 * Examples:
 *   "9 ,980円(税込)"       → 9980 incl
 *   "税込 7,980円"          → 7980 incl
 *   "￥69,800 (税込)"       → 69800 incl
 *   "6300円(税抜)"          → 6300 excl
 *   "本体価格 \\6,800 (税込 \\7,480)" → 7480 incl (prefer tax-incl)
 *   ""                      → { price: null, incl: null }
 */
export function parsePrice(raw: string | null | undefined): {
	price: number | null;
	incl: boolean | null;
} {
	if (!raw) return { price: null, incl: null };
	const s = String(raw);

	const nums = Array.from(s.matchAll(/([0-9][0-9, ]{1,})/g))
		.map((m) => parseInt(m[1].replace(/[, ]/g, ""), 10))
		.filter((n) => Number.isFinite(n) && n >= 100 && n < 10_000_000);

	if (nums.length === 0) return { price: null, incl: null };

	const hasIncl = /税込/.test(s);
	const hasExcl = /税抜|＋消費税|\+消費税/.test(s);

	if (hasIncl && hasExcl) return { price: Math.max(...nums), incl: true };
	if (hasIncl) return { price: Math.max(...nums), incl: true };
	if (hasExcl) return { price: Math.max(...nums), incl: false };
	return { price: Math.max(...nums), incl: null };
}
