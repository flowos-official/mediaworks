/**
 * Fetch a URL and extract basic meta + contact hints from HTML.
 * Used by enrichment agent for manufacturer official-site verification.
 */

export interface UrlMeta {
	url: string;
	title: string | null;
	description: string | null;
	contact_hints: string[];
	fetched: boolean;
}

const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;
const PHONE_RE = /(?:\+?81[-.\s]?)?(?:\(?0\)?[0-9]{1,4}[-.\s]?[0-9]{1,4}[-.\s]?[0-9]{3,4})/g;

export async function fetchUrlMeta(url: string): Promise<UrlMeta> {
	if (!url.startsWith("http")) {
		return { url, title: null, description: null, contact_hints: [], fetched: false };
	}

	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(8000),
			headers: {
				"User-Agent":
					"Mozilla/5.0 (compatible; MediaWorksBot/1.0; +https://mediaworks-six.vercel.app)",
				Accept: "text/html,*/*",
			},
			redirect: "follow",
		});
		if (!res.ok) {
			return { url, title: null, description: null, contact_hints: [], fetched: false };
		}
		const html = (await res.text()).slice(0, 200_000);

		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		const descMatch = html.match(
			/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
		);

		const bodyText = html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " ");

		const emails = Array.from(new Set(bodyText.match(EMAIL_RE) ?? [])).slice(0, 3);
		const phones = Array.from(new Set(bodyText.match(PHONE_RE) ?? []))
			.filter((p) => p.replace(/\D/g, "").length >= 9)
			.slice(0, 3);

		return {
			url,
			title: titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 200) : null,
			description: descMatch ? decodeEntities(descMatch[1].trim()).slice(0, 300) : null,
			contact_hints: [...emails, ...phones],
			fetched: true,
		};
	} catch (err) {
		console.warn(
			`[fetchUrlMeta] ${url} failed:`,
			err instanceof Error ? err.message : String(err),
		);
		return { url, title: null, description: null, contact_hints: [], fetched: false };
	}
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ");
}
