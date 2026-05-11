/**
 * Fetch a Rakuten item page and extract seller/shop info.
 * Rakuten shop pages carry 店舗名 (shop), 会社名 (company), 所在地 (address)
 * in predictable locations when present. Product pages also expose a
 * BreadcrumbList JSON-LD that we can use for real category recovery.
 * We use lightweight regex — pages vary, so fields are best-effort.
 */

export interface RakutenShopInfo {
	productUrl: string;
	shopName: string | null;
	companyName: string | null;
	address: string | null;
	shopUrl: string | null;
	manufacturerHint: string | null;
	categoryName: string | null;
	categoryPath: string[];
	fetched: boolean;
}

const SHOP_URL_RE = /https?:\/\/www\.rakuten\.co\.jp\/[a-z0-9-]+\//i;
const CHARSET_RE = /charset\s*=\s*["']?([a-z0-9._-]+)/i;
const BREADCRUMB_SCRIPT_RE =
	/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const BREADCRUMB_ITEM_RE =
	/"item"\s*:\s*\{[\s\S]*?"@id"\s*:\s*"([^"]+)"[\s\S]*?"name"\s*:\s*"([^"]+)"/gi;

export async function fetchRakutenPage(productUrl: string): Promise<RakutenShopInfo> {
	if (!productUrl.includes("rakuten.co.jp")) {
		return {
			productUrl,
			shopName: null,
			companyName: null,
			address: null,
			shopUrl: null,
			manufacturerHint: null,
			categoryName: null,
			categoryPath: [],
			fetched: false,
		};
	}

	try {
		const res = await fetch(productUrl, {
			signal: AbortSignal.timeout(8000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; MediaWorksBot/1.0)",
				Accept: "text/html,*/*",
				"Accept-Language": "ja,en;q=0.9",
			},
			redirect: "follow",
		});
		if (!res.ok) {
			return {
				productUrl,
				shopName: null,
				companyName: null,
				address: null,
				shopUrl: null,
				manufacturerHint: null,
				categoryName: null,
				categoryPath: [],
				fetched: false,
			};
		}
		const html = decodeRakutenHtml(
			await res.arrayBuffer(),
			res.headers.get("content-type"),
		).slice(0, 500_000);

		const shopUrlMatch = html.match(SHOP_URL_RE);
		const shopName = extractFieldAfterLabel(html, [
			"店舗名",
			"ショップ名",
			"運営会社",
		]);
		const companyName = extractFieldAfterLabel(html, ["会社名", "法人名"]);
		const address = extractFieldAfterLabel(html, ["所在地", "住所"]);
		const manufacturerHint = extractFieldAfterLabel(html, [
			"メーカー",
			"製造元",
			"製造販売元",
			"製造国",
		]);
		const categoryPath = extractRakutenCategoryPath(html);

		return {
			productUrl,
			shopName,
			companyName,
			address,
			shopUrl: shopUrlMatch ? shopUrlMatch[0] : null,
			manufacturerHint,
			categoryName: categoryPath.at(-1) ?? null,
			categoryPath,
			fetched: true,
		};
	} catch (err) {
		console.warn(
			`[fetchRakutenPage] ${productUrl} failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return {
			productUrl,
			shopName: null,
			companyName: null,
			address: null,
			shopUrl: null,
			manufacturerHint: null,
			categoryName: null,
			categoryPath: [],
			fetched: false,
		};
	}
}

function decodeRakutenHtml(
	payload: ArrayBuffer,
	contentType?: string | null,
): string {
	const raw = new Uint8Array(payload);
	const head = Buffer.from(raw.slice(0, 4096)).toString("latin1");
	const declaredCharset =
		normalizeCharset(extractCharset(contentType)) ??
		normalizeCharset(extractCharset(head));
	const charsets = Array.from(
		new Set([declaredCharset, "utf-8"].filter((v): v is string => Boolean(v))),
	);

	for (const charset of charsets) {
		try {
			return new TextDecoder(charset).decode(payload);
		} catch {
			continue;
		}
	}

	return Buffer.from(raw).toString("utf8");
}

function extractCharset(value?: string | null): string | null {
	if (!value) return null;
	const match = value.match(CHARSET_RE);
	return match?.[1] ?? null;
}

function normalizeCharset(value?: string | null): string | null {
	if (!value) return null;
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "utf8":
		case "utf-8":
			return "utf-8";
		case "euc-jp":
		case "eucjp":
			return "euc-jp";
		case "shift_jis":
		case "shift-jis":
		case "sjis":
		case "windows-31j":
		case "ms932":
		case "cp932":
			return "shift_jis";
		default:
			return null;
	}
}

function extractRakutenCategoryPath(html: string): string[] {
	for (const match of html.matchAll(BREADCRUMB_SCRIPT_RE)) {
		const script = match[1];
		if (!script.includes("BreadcrumbList")) continue;

		const path = Array.from(script.matchAll(BREADCRUMB_ITEM_RE))
			.map(([, id, name]) => ({
				id: decodeJsonString(id),
				name: decodeJsonString(name),
			}))
			.filter((item) => item.id.includes("/category/"))
			.map((item) => stripTags(item.name).trim())
			.filter(Boolean)
			.filter((name) => name !== "楽天市場");

		if (path.length > 0) {
			return path;
		}
	}

	return [];
}

function formatRakutenCategory(path: string[]): string | null {
	if (path.length === 0) return null;
	return path.join(" > ");
}

function decodeJsonString(value: string): string {
	try {
		return JSON.parse(`"${value}"`) as string;
	} catch {
		return value;
	}
}

/**
 * Lightweight label-based extractor: finds `<label>...` in table rows or
 * definition lists. Returns plaintext up to 120 chars.
 */
function extractFieldAfterLabel(html: string, labels: string[]): string | null {
	for (const label of labels) {
		// Pattern: <th>label</th><td>value</td>
		const tableRe = new RegExp(
			`<(th|dt)[^>]*>\\s*${escapeRe(label)}[\\s　:：]*<\\/(?:th|dt)>\\s*<(?:td|dd)[^>]*>([\\s\\S]{1,400}?)<\\/(?:td|dd)>`,
			"i",
		);
		const m = html.match(tableRe);
		if (m) {
			const plain = stripTags(m[2]).trim();
			if (plain) return plain.slice(0, 120);
		}
		// Pattern: "label：value" or "label:value" in plain text
		const plainRe = new RegExp(
			`${escapeRe(label)}[\\s　]*[:：][\\s　]*([^\\n<]{1,120})`,
			"i",
		);
		const m2 = html.match(plainRe);
		if (m2) {
			const plain = stripTags(m2[1]).trim();
			if (plain) return plain.slice(0, 120);
		}
	}
	return null;
}

function stripTags(s: string): string {
	return s
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&nbsp;/g, " ")
		.trim();
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const __test = {
	decodeRakutenHtml,
	extractRakutenCategoryPath,
	formatRakutenCategory,
};
