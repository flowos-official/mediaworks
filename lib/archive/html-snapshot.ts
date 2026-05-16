import * as cheerio from "cheerio";
import { politeFetch } from "@/lib/broadcasts/fetch";
import { uploadTextGzipped, type UploadResult } from "./upload";

export interface HtmlSnapshotResult {
	upload: UploadResult;
	extractedText: string;
	title: string | null;
}

/**
 * Fetch a product detail page, save the raw HTML as gzip in `archives` bucket,
 * and return an extracted-text version for full-text search / Gemini analysis.
 *
 * Key convention: `{channel}/{productId}/{yyyymmdd}.html.gz`.
 */
export async function snapshotHtml(
	url: string,
	key: string,
): Promise<HtmlSnapshotResult | null> {
	const fetched = await politeFetch(url, { timeoutMs: 20_000 });
	if (!fetched.ok || !fetched.body) return null;

	const upload = await uploadTextGzipped(
		"archives",
		key,
		fetched.body,
		"text/html; charset=utf-8",
	);

	const $ = cheerio.load(fetched.body);
	$("script, style, noscript, nav, header, footer, iframe").remove();
	const title = $("title").first().text().trim() || null;
	const extractedText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);

	return { upload, extractedText, title };
}
