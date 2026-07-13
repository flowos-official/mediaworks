"use client";

import useSWR, { mutate as mutateGlobal, type SWRConfiguration } from "swr";

export class ApiRequestError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiRequestError";
		this.status = status;
	}
}

export async function apiJsonFetcher<T>(url: string): Promise<T> {
	const response = await fetch(url, {
		credentials: "same-origin",
		headers: { Accept: "application/json" },
	});
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const payload = (await response.json()) as { error?: string };
			if (payload.error) message = payload.error;
		} catch {
			// Keep the status-based fallback when the response is not JSON.
		}
		throw new ApiRequestError(message, response.status);
	}
	return response.json() as Promise<T>;
}

type QueryOptions<T> = Pick<
	SWRConfiguration<T, ApiRequestError>,
	| "fallbackData"
	| "keepPreviousData"
	| "revalidateIfStale"
	| "refreshInterval"
	| "refreshWhenHidden"
	| "refreshWhenOffline"
	| "onSuccess"
	| "onError"
>;

/**
 * Shared client query cache. The provider lives in the persistent locale
 * layout, so cached JSON survives page unmount/remount and back navigation.
 */
export function useApiQuery<T>(
	key: string | null,
	options: QueryOptions<T> = {},
) {
	return useSWR<T, ApiRequestError>(key, apiJsonFetcher, options);
}

function matchesPrefix(key: unknown, prefixes: readonly string[]): boolean {
	return typeof key === "string" && prefixes.some((prefix) => key.startsWith(prefix));
}

/** Revalidate active entries matching any API prefix after a mutation. */
export function invalidateApiCache(...prefixes: string[]): Promise<unknown[]> {
	return mutateGlobal((key) => matchesPrefix(key, prefixes));
}

/** Drop all user-scoped browser data before signing out. */
export function clearApiCache(): Promise<unknown[]> {
	return mutateGlobal(() => true, undefined, { revalidate: false });
}
