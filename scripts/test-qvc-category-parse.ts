import { parseQvcProductHTML } from "../lib/qvc-products/fetcher";

async function main() {
	const ids = ["742487", "740596", "749000", "745000", "750000"];
	for (const id of ids) {
		try {
			const res = await fetch(`https://qvc.jp/product.${id}.html`, {
				headers: { "User-Agent": "Mozilla/5.0" },
			});
			if (!res.ok) {
				console.log(id, "http", res.status);
				continue;
			}
			const html = await res.text();
			const detail = parseQvcProductHTML(html, id);
			console.log(
				id,
				"->",
				JSON.stringify(detail.category),
				"|",
				(detail.name ?? "").slice(0, 40),
			);
		} catch (e) {
			console.log(id, "err", (e as Error).message);
		}
	}
}

void main();
