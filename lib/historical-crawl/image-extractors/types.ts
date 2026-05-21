/**
 * Image extractor interface for OA channels.
 *
 * Pure-function over a source URL; returns the resolved image URL (always
 * absolute HTTPS) or null when extraction failed for any reason (HTTP error,
 * missing meta tag, parse failure, timeout). Extractors MUST NOT throw —
 * caller relies on null-on-failure semantics.
 *
 * Spec: docs/superpowers/specs/2026-05-21-oa-channel-images-design.md §5
 */
export interface ImageExtractor {
	extract(sourceUrl: string): Promise<string | null>;
}

/**
 * Run `fn` over `items` with at most `concurrency` simultaneous invocations.
 * Preserves input order in the output. Used by parsers to cap how many
 * upstream requests we fire at any one host.
 */
export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const out: R[] = new Array(items.length);
	let cursor = 0;
	const workerCount = Math.min(concurrency, items.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (true) {
				const i = cursor++;
				if (i >= items.length) return;
				out[i] = await fn(items[i]);
			}
		}),
	);
	return out;
}
