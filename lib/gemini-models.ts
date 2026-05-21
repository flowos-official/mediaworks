/**
 * Single source of truth for Gemini model IDs.
 *
 * Why this file exists: model IDs were duplicated across ~40 files. Bumping
 * the model used to mean a 40-file sed — easy to miss spots, and easy for
 * stale lib/registry/skills/{name}/v1/meta.ts entries to drift from the
 * `lib/discovery/*` and `lib/md-strategy.ts` callers. Import from here and
 * the rename becomes a one-line change.
 *
 * Current pin (2026-05-21):
 *   - Flash: `gemini-3.5-flash` (GA on 2026-05-19, replaces the
 *     `gemini-3-flash-preview` identifier from the preview window).
 *   - Pro fallback: `gemini-3.1-pro-preview` — used when the flash model
 *     returns 503/INTERNAL. `gemini-3.5-pro` is not yet GA (announced for
 *     June 2026); swap this constant when it ships.
 */

export const GEMINI_FLASH = "gemini-3.5-flash" as const;

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
