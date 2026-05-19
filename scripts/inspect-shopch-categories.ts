/**
 * One-off diagnostic: explore shopch.jp endpoints to find whether category
 * info is exposed without JS rendering. Checks: program list, product detail,
 * /pc/category/ landing.
 */
import * as cheerio from "cheerio";

const UA = "Mozilla/5.0";

async function main() {
	// 1) Program list page
	const programListUrl =
		"https://www.shopch.jp/pc/tv/programlist?onAirDay=20260518";
	const res1 = await fetch(programListUrl, { headers: { "User-Agent": UA } });
	const html1 = await res1.text();
	const $1 = cheerio.load(html1);

	console.log("=== Program list — first article ===");
	const first = $1("article.pg-program-item").first();
	const attribs = (first.get(0) as { attribs?: Record<string, string> })
		?.attribs ?? {};
	console.log("data-* attrs:");
	for (const [k, v] of Object.entries(attribs)) {
		if (k.startsWith("data-")) console.log(" ", k, "=", v);
	}

	console.log("\n--- Classes / attributes inside article ---");
	const seen = new Set<string>();
	first.find("*").each((_, el) => {
		const c = $1(el).attr("class") ?? "";
		if (c && !seen.has(c)) seen.add(c);
	});
	for (const c of [...seen].slice(0, 30)) console.log(" ", c);

	console.log("\n--- href values pointing to category endpoints ---");
	const catHrefs = new Set<string>();
	first.find("a[href]").each((_, el) => {
		const href = $1(el).attr("href") ?? "";
		const txt = $1(el).text().trim();
		if (/categ|genre|kbn|tag/i.test(href) && !catHrefs.has(href)) {
			catHrefs.add(href);
			console.log(" ", txt.padEnd(20), "|", href);
		}
	});

	// 2) Category landing page
	console.log("\n=== /pc/category/ landing page ===");
	const catLanding = await fetch("https://www.shopch.jp/pc/category/index", {
		headers: { "User-Agent": UA },
	});
	console.log("Status:", catLanding.status, "URL:", catLanding.url);
	if (catLanding.ok) {
		const catHtml = await catLanding.text();
		const $2 = cheerio.load(catHtml);
		const links = new Map<string, string>();
		$2('a[href*="category"]').each((_, el) => {
			const href = $2(el).attr("href") ?? "";
			const txt = $2(el)
				.text()
				.replace(/\s+/g, " ")
				.trim();
			if (txt && txt.length < 40 && !links.has(href)) links.set(href, txt);
		});
		console.log(`Found ${links.size} unique category links:`);
		for (const [href, txt] of [...links].slice(0, 25)) {
			console.log(" ", txt.padEnd(30), "|", href);
		}
	}

	// 3) Inspect what's inside articles for any data-genre / data-category
	console.log("\n=== Searching raw HTML for category markers ===");
	for (const pat of [
		"data-genre",
		"data-category",
		"data-kbn",
		"genre_cd",
		"category_cd",
		"categoryId",
	]) {
		const re = new RegExp(`${pat}\\s*[=:]\\s*['"]([^'"]+)['"]`, "g");
		const matches = [...html1.matchAll(re)].slice(0, 5);
		if (matches.length) {
			console.log(" ", pat, "->", matches.map((m) => m[1]).join(", "));
		}
	}

	// 4) Try the product detail page (one we know exists)
	console.log("\n=== Product detail JSON-LD / hidden category ===");
	const prodUrl =
		"https://www.shopch.jp/pc/product/proddetail?reqprno=816577";
	const prodRes = await fetch(prodUrl, { headers: { "User-Agent": UA } });
	const prodHtml = await prodRes.text();
	const $3 = cheerio.load(prodHtml);
	console.log("page bytes:", prodHtml.length);
	console.log("title:", $3("title").first().text().trim());
	console.log("og:title:", $3('meta[property="og:title"]').attr("content"));
	console.log("og:type:", $3('meta[property="og:type"]').attr("content"));
	console.log(
		"og:description:",
		($3('meta[property="og:description"]').attr("content") ?? "").slice(0, 100),
	);
	// look for embedded JSON
	const scripts = $3("script:not([src])");
	console.log("\nInline scripts:", scripts.length);
	const interesting: string[] = [];
	scripts.each((_, el) => {
		const t = $3(el).text();
		if (/category|genre|kbn|breadcrumb/i.test(t)) {
			interesting.push(t.slice(0, 200));
		}
	});
	for (const s of interesting.slice(0, 3)) {
		console.log("  ...script excerpt:", s);
	}
}

void main().catch((e) => {
	console.error(e);
	process.exit(1);
});
