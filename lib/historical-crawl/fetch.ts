import { USER_AGENT } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface FetchResult {
	ok: boolean;
	status?: number;
	body?: string;
	finalUrl?: string;
	error?: string;
}

function decodeBytes(buf: ArrayBuffer, contentType: string | null): string {
	const cs = contentType ? /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase() : null;
	if (cs && (cs === "shift_jis" || cs === "shift-jis" || cs === "x-sjis")) {
		return new TextDecoder("shift-jis", { fatal: false }).decode(buf);
	}
	const utf = new TextDecoder("utf-8", { fatal: false }).decode(buf);
	if (/<meta[^>]+charset=["']?(shift_jis|shift-jis|x-sjis)/i.test(utf.slice(0, 2000))) {
		return new TextDecoder("shift-jis", { fatal: false }).decode(buf);
	}
	return utf;
}

export async function politeFetch(
	url: string,
	opts: {
		timeoutMs?: number;
		retry?: boolean;
		headers?: Record<string, string>;
	} = {},
): Promise<FetchResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retry = opts.retry ?? true;

	const attempt = async (): Promise<FetchResult> => {
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml",
					"Accept-Language": "ja,en;q=0.8",
					...(opts.headers ?? {}),
				},
				signal: ctrl.signal,
				redirect: "follow",
			});
			clearTimeout(timer);
			if (!res.ok) {
				return { ok: false, status: res.status, finalUrl: res.url, error: "HTTP " + res.status };
			}
			const buf = await res.arrayBuffer();
			const body = decodeBytes(buf, res.headers.get("content-type"));
			return { ok: true, status: res.status, body, finalUrl: res.url };
		} catch (e) {
			clearTimeout(timer);
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	};

	const first = await attempt();
	if (first.ok || (first.status && first.status >= 400 && first.status < 500)) {
		return first;
	}
	if (!retry) return first;
	return attempt();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
