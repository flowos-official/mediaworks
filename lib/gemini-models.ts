/**
 * Single source of truth for Gemini model IDs.
 *
 * Why this file exists: model IDs were duplicated across ~40 files. Bumping
 * the model used to mean a 40-file sed — easy to miss spots, and easy for
 * stale lib/registry/skills/{name}/v1/meta.ts entries to drift from the
 * `lib/discovery/*` and `lib/md-strategy.ts` callers. Import from here and
 * the rename becomes a one-line change.
 *
 * Current pin (2026-08-27):
 *   - Flash: `gemini-3.7-flash`. Bumped from `gemini-3.5-flash`, which is both
 *     older and twice the price: 3.5-flash bills $1.50/1M input and $9.00/1M
 *     output, 3.7-flash $0.75 and $3.75 (promotional through 2026-12-31, then
 *     $1.50/$7.50). Audio input carries no separate rate on either.
 *   - Pro fallback: `gemini-3.1-pro-preview` — used when the flash model
 *     returns 503/INTERNAL, and pinned deliberately by the screenplay
 *     generator, which pairs it with HIGH thinking. Left alone at the 3.7
 *     bump: changing it would move the screenplay output at the same moment
 *     the competitor-pattern injection is being measured, confounding that
 *     comparison. Revisit once that evaluation is done.
 *
 * Pin, never alias. `gemini-flash-latest` and `gemini-pro-latest` exist, but a
 * moving target means output can change under a running evaluation with no
 * commit to point at.
 */

export const GEMINI_FLASH = "gemini-3.7-flash" as const;

export const GEMINI_PRO_FALLBACK = "gemini-3.1-pro-preview" as const;

/**
 * The flash → pro fallback chain used by md-strategy and live-commerce
 * strategy when the primary model returns a retryable 5xx. Ordered.
 */
export const GEMINI_MODELS_WITH_FALLBACK = [
	GEMINI_FLASH,
	GEMINI_PRO_FALLBACK,
] as const;

export type GeminiModelId =
	| typeof GEMINI_FLASH
	| typeof GEMINI_PRO_FALLBACK;
