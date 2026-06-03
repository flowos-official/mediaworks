import type { ChannelParser } from "../types";
import { politeFetch } from "../fetch";
import { parseAsahiCategory } from "./senobura";
import { ogImageExtractor } from "../image-extractors/og-image";
import { mapWithConcurrency } from "../image-extractors/types";

const PAGE_URL = "https://shop.asahi.co.jp/category/URANADJA/";

export const uranouraParser: ChannelParser = {
	slug: "uranoura",
	name: "ABCウラのウラまで",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) throw new Error(`fetch failed: HTTP ${r.status ?? "?"}${r.error ? ` ${r.error}` : ""}`);
		const rows = parseAsahiCategory(r.body, jstDate, "uranoura", PAGE_URL, "live-crawl:uranoura");
		await mapWithConcurrency(rows, 5, async (row) => {
			if (!row.source_url) return;
			row.image_url = await ogImageExtractor.extract(row.source_url).catch(() => null);
		});
		return rows;
	},
};
