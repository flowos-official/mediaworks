/**
 * Fetch a page named by a search result, without letting a search result point
 * us at ourselves.
 *
 * This is the only place in the codebase that fetches a URL chosen by a third
 * party. Everything else talks to a fixed provider endpoint. That makes it the
 * one place SSRF is possible: a Brave result — or a page that redirects — can
 * name `http://169.254.169.254/`, `http://localhost:54321/`, or an internal
 * host, and a naive fetch would return cloud credentials or the Supabase
 * admin API to whoever arranged for the result to appear.
 *
 * So: resolve every hostname before every hop, refuse any address that is not
 * publicly routable, follow redirects manually, and cap what comes back.
 *
 * HONEST LIMIT: resolving a hostname and then fetching by that hostname leaves
 * a DNS-rebinding window — the second lookup, made by fetch itself, can return
 * a different address. Closing it properly means pinning the resolved IP while
 * keeping the original Host and SNI, which Node's fetch does not expose. The
 * checks here stop every accidental case and every redirect-based one; they do
 * not stop a determined rebinding attack. Treat what comes back as untrusted
 * text either way — it is only ever parsed for values, never executed.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

const ACCEPTED_CONTENT = [/^text\/html/i, /^application\/xhtml\+xml/i, /^text\/plain/i];

export class UnsafeUrlError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeUrlError";
	}
}

/** Publicly routable, or not. Written out rather than pulled from a package so
 *  the ranges are reviewable here. */
export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 0) return true; // not an IP at all — refuse rather than guess

	if (family === 4) {
		const parts = address.split(".").map(Number);
		if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
		const [a, b] = parts;
		if (a === 0) return true; // 0.0.0.0/8 "this network"
		if (a === 10) return true; // private
		if (a === 127) return true; // loopback
		if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true; // private
		if (a === 192 && b === 168) return true; // private
		if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
		if (a === 192 && b === 0) return true; // IETF protocol assignments
		if (a >= 224) return true; // multicast + reserved
		return false;
	}

	const lower = address.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	// IPv4-mapped (::ffff:169.254.169.254) must be judged as its IPv4 address.
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return isPrivateAddress(mapped[1]);
	if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
	if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
	if (lower.startsWith("ff")) return true; // multicast
	return false;
}

async function assertPubliclyRoutable(hostname: string): Promise<void> {
	// A literal IP never reaches DNS, so check it directly.
	if (isIP(hostname) !== 0) {
		if (isPrivateAddress(hostname)) {
			throw new UnsafeUrlError(`refusing to fetch a non-public address: ${hostname}`);
		}
		return;
	}
	let addresses: Array<{ address: string }>;
	try {
		addresses = await lookup(hostname, { all: true });
	} catch {
		throw new UnsafeUrlError(`could not resolve ${hostname}`);
	}
	if (addresses.length === 0) throw new UnsafeUrlError(`no address for ${hostname}`);
	// EVERY address, not the first: a host that resolves to both a public and a
	// private address is a rebinding setup, not a coincidence.
	for (const { address } of addresses) {
		if (isPrivateAddress(address)) {
			throw new UnsafeUrlError(`${hostname} resolves to a non-public address (${address})`);
		}
	}
}

function parseSafeUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new UnsafeUrlError(`not a URL: ${raw.slice(0, 120)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new UnsafeUrlError(`unsupported scheme: ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new UnsafeUrlError("credentials in a URL are never legitimate here");
	}
	return url;
}

/** True for a URL we are willing to follow at all. Exported so the provider
 *  can drop a bad search result without paying for a request. */
export function isFetchableUrl(raw: string): boolean {
	try {
		parseSafeUrl(raw);
		return true;
	} catch {
		return false;
	}
}

export async function safeFetchSourcePage(
	rawUrl: string,
	options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<{ finalUrl: string; contentType: string; text: string }> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

	let url = parseSafeUrl(rawUrl);
	const deadline = Date.now() + timeoutMs;

	for (let hop = 0; hop <= maxRedirects; hop++) {
		await assertPubliclyRoutable(url.hostname);
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new UnsafeUrlError("timed out before the request completed");

		const response = await fetch(url.toString(), {
			// Manual, so every hop is checked. `redirect: "follow"` would let the
			// second hop go anywhere.
			redirect: "manual",
			headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
			signal: AbortSignal.timeout(remaining),
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw new UnsafeUrlError(`redirect with no location from ${url.hostname}`);
			url = parseSafeUrl(new URL(location, url).toString());
			continue;
		}
		if (!response.ok) throw new UnsafeUrlError(`${response.status} from ${url.hostname}`);

		const contentType = response.headers.get("content-type") ?? "";
		if (!ACCEPTED_CONTENT.some((pattern) => pattern.test(contentType))) {
			throw new UnsafeUrlError(`unsupported content type: ${contentType || "(none)"}`);
		}

		// Capped as it arrives. Content-Length is a claim by the server; a
		// streaming read is the only cap that actually holds.
		const reader = response.body?.getReader();
		if (!reader) return { finalUrl: url.toString(), contentType, text: "" };
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new UnsafeUrlError(`response exceeded ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
		const body = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return {
			finalUrl: url.toString(),
			contentType,
			text: new TextDecoder("utf-8", { fatal: false }).decode(body),
		};
	}

	throw new UnsafeUrlError(`more than ${maxRedirects} redirects`);
}
