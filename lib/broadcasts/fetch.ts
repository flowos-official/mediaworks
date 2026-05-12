import { USER_AGENT } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface FetchResult {
	ok: boolean;
	status?: number;
	body?: string;
	error?: string;
}

export async function politeFetch(
	url: string,
	opts: { timeoutMs?: number; retry?: boolean } = {},
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
				},
				signal: ctrl.signal,
				redirect: "follow",
			});
			clearTimeout(timer);
			if (!res.ok) {
				return { ok: false, status: res.status, error: `HTTP ${res.status}` };
			}
			const body = await res.text();
			return { ok: true, status: res.status, body };
		} catch (e) {
			clearTimeout(timer);
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	};

	const first = await attempt();
	// 4xx는 재시도 안 함. 그 외 실패만 1회 재시도
	if (first.ok || (first.status && first.status >= 400 && first.status < 500)) {
		return first;
	}
	if (!retry) return first;
	return attempt();
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
