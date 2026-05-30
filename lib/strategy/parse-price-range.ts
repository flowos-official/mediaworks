/**
 * Shared operator price-range parser. Used by the final MD discovery
 * (lib/md-strategy.ts), the preliminary preview (preliminary-discovery.ts), and
 * the fast preview (fast-preview-search.ts) so preview and final agree on the
 * price band. Pure (no I/O, no server-only) → tsx-importable.
 *
 * Accepts: "¥3,000-8,000", "3000〜8000", "5000前後" (±20%), "5000円以下"/"未満",
 * "3000以上"/"超", "〜10000", "5000-", and a bare single value (±20%).
 * The earlier min-max-only parser returned null on the UI's own seeded
 * "¥N前後" default and every single-value/以下/以上 input, so price was silently
 * never applied.
 */
export function parsePriceRange(
	priceRange: string,
): { min: number; max: number } | null {
	const cleaned = priceRange.replace(/[¥￥,、\s円]/g, "").replace(/[〜～]/g, "-");
	const range = cleaned.match(/(\d+)\s*[-–]\s*(\d+)/);
	if (range) {
		const a = parseInt(range[1], 10);
		const b = parseInt(range[2], 10);
		return { min: Math.min(a, b), max: Math.max(a, b) };
	}
	const around = cleaned.match(/(\d+)前後/);
	if (around) {
		const v = parseInt(around[1], 10);
		return { min: Math.round(v * 0.8), max: Math.round(v * 1.2) };
	}
	const below = cleaned.match(/(\d+)(以下|未満)/);
	if (below) return { min: 0, max: parseInt(below[1], 10) };
	const above = cleaned.match(/(\d+)(以上|超)/);
	if (above) return { min: parseInt(above[1], 10), max: Number.MAX_SAFE_INTEGER };
	const leadMax = cleaned.match(/^-(\d+)$/);
	if (leadMax) return { min: 0, max: parseInt(leadMax[1], 10) };
	const trailMin = cleaned.match(/^(\d+)-$/);
	if (trailMin) return { min: parseInt(trailMin[1], 10), max: Number.MAX_SAFE_INTEGER };
	const single = cleaned.match(/^(\d+)$/);
	if (single) {
		const v = parseInt(single[1], 10);
		return { min: Math.round(v * 0.8), max: Math.round(v * 1.2) };
	}
	return null;
}
