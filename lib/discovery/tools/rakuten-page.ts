/**
 * Fetch a Rakuten item page and extract seller/shop info.
 * Rakuten shop pages carry 店舗名 (shop), 会社名 (company), 所在地 (address)
 * in predictable locations when present. We use lightweight regex — pages
 * vary, so fields are best-effort.
 */

export interface RakutenShopInfo {
	productUrl: string;
	shopName: string | null;
	companyName: string | null;
	address: string | null;
	shopUrl: string | null;
	manufacturerHint: string | null;
	fetched: boolean;
}

const SHOP_URL_RE = /https?:\/\/www\.rakuten\.co\.jp\/[a-z0-9-]+\//i;

export async function fetchRakutenPage(productUrl: string): Promise<RakutenShopInfo> {
	if (!productUrl.includes("rakuten.co.jp")) {
		return {
			productUrl,
			shopName: null,
			companyName: null,
			address: null,
			shopUrl: null,
			manufacturerHint: null,
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
				fetched: false,
			};
		}
		const html = (await res.text()).slice(0, 500_000);

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

		return {
			productUrl,
			shopName,
			companyName,
			address,
			shopUrl: shopUrlMatch ? shopUrlMatch[0] : null,
			manufacturerHint,
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
			fetched: false,
		};
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
