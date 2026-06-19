import type { ChannelParser } from "../types";
import { politeFetch } from "../fetch";
import { parseAsahiCategory } from "./senobura";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

// ABCらくらく茂 — added 2026-06-19 per ABC operator feedback (replaces the
// off-air ウラのウラまで). Same shop.asahi.co.jp template as SENOBURA/URANADJA,
// so it reuses parseAsahiCategory: each row is dated from its slot's
// `.onair-time` ("MM/DD (曜) HH:MM分放送"); items without one are skipped (never
// blanket-stamped with jstDate). The program airs weekly on Mondays.
//
// VERIFICATION CAVEAT: shop.asahi.co.jp returns a soft-404 to non-Vercel IPs, so
// this page's markup cannot be checked locally — only the deployed cron (from
// Vercel's IP) sees the real page. If RAKURAKU turns out to be a dateless
// product catalog (like URANADJA), parseAsahiCategory will correctly yield 0
// rows; confirm the first post-deploy cron run actually captures rows.
const PAGE_URL = "https://shop.asahi.co.jp/category/RAKURAKU/";

export const rakurakuParser: ChannelParser = {
	slug: "rakuraku",
	name: "ABCらくらく茂",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseAsahiCategory(r.body, jstDate, "rakuraku", PAGE_URL, "live-crawl:rakuraku");
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
