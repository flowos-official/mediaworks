import type { ChannelParser } from "../types";
import { politeFetch } from "../fetch";
import { parseAsahiCategory } from "./senobura";

const PAGE_URL = "https://shop.asahi.co.jp/category/URANADJA/";

export const uranouraParser: ChannelParser = {
	slug: "uranoura",
	name: "ABCウラのウラまで",
	fetchToday: async (jstDate) => {
		const r = await politeFetch(PAGE_URL);
		if (!r.ok || !r.body) return [];
		return parseAsahiCategory(r.body, jstDate, "uranoura", PAGE_URL, "live-crawl:uranoura");
	},
};
