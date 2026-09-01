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

/**
 * Flash-Lite tiers, for high-volume work that does not need Flash's reasoning.
 *
 * Priced (checked 2026-09-01):
 *   - `gemini-3.5-flash-lite` — $0.30/1M in, $2.50/1M out. Released 2026-07-21.
 *   - `gemini-2.5-flash-lite` — $0.10/1M in, $0.40/1M out. A generation older.
 *
 * Against 3.7-flash's $0.75/$3.75 that is a 40% and an 89% saving. Both accept
 * audio and both allow more output tokens than MAX_OUTPUT_TOKENS asks for, so
 * the only open question for a given job is output quality — measure it before
 * switching. There is no 3.7-flash-lite.
 */
export const GEMINI_FLASH_LITE = "gemini-3.5-flash-lite" as const;
export const GEMINI_FLASH_LITE_CHEAP = "gemini-2.5-flash-lite" as const;

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
	| typeof GEMINI_FLASH_LITE
	| typeof GEMINI_FLASH_LITE_CHEAP
	| typeof GEMINI_PRO_FALLBACK;

/**
 * Which model each stage runs on.
 *
 * A single `GEMINI_FLASH` for all ~47 call sites made every stage share one
 * price and one capability level, so the only way to make transcription cheaper
 * was to make screenplay generation worse at the same time. These jobs are not
 * alike: labelled extraction over audio is high-volume, low-reasoning work that
 * a Lite tier handles, while a screenplay draft is the opposite.
 *
 * A stage moves off the default only on measured output. `broadcast_analysis`
 * is the one that has been measured (2026-09-01, three slots, each model on the
 * same audio):
 *
 *   3.7-flash        3/3 parsed, act coverage 100/100/100%, 4.7 acts avg
 *   3.5-flash-lite   3/3 parsed, act coverage 100/100/100%, 4.7 acts avg
 *   2.5-flash-lite   2/3 parsed, act coverage 9/45/—%,      6.5 acts avg
 *
 * 3.5-flash-lite matched Flash on the output this pipeline actually validates
 * and costs 60% less. 2.5-flash-lite is 89% cheaper on paper and unusable in
 * practice: its acts stop a fraction into the programme, so MIN_ACT_COVERAGE
 * rejects them and the slot retries — and the CloudFront egress for that slot
 * has already been spent, which makes the cheapest model the expensive one.
 *
 * Every other stage stays on Flash because nobody has measured it there yet.
 * Do not move one on price alone.
 */
export type GeminiStage =
	| "broadcast_analysis"
	| "discovery_curation"
	| "discovery_classification"
	| "research_synthesis"
	| "screenplay_generation"
	| "screenplay_extraction"
	| "strategy"
	| "competitor_fit"
	| "recommendation";

const STAGE_MODELS: Record<GeminiStage, GeminiModelId> = {
	broadcast_analysis: GEMINI_FLASH_LITE,
	discovery_curation: GEMINI_FLASH,
	discovery_classification: GEMINI_FLASH,
	research_synthesis: GEMINI_FLASH,
	screenplay_generation: GEMINI_FLASH,
	screenplay_extraction: GEMINI_FLASH,
	strategy: GEMINI_FLASH,
	competitor_fit: GEMINI_FLASH,
	recommendation: GEMINI_FLASH,
};

/**
 * `GEMINI_MODEL_<STAGE>` overrides one stage without a deploy — enough to run a
 * comparison in production, or to fall back fast if a stage regresses. An unset
 * or blank value keeps the pinned default; nothing here silently aliases to a
 * moving `-latest` target.
 */
export function modelForStage(stage: GeminiStage): string {
	const override = process.env[`GEMINI_MODEL_${stage.toUpperCase()}`];
	return override?.trim() || STAGE_MODELS[stage];
}

/** The pinned default for a stage, ignoring any environment override. */
export function defaultModelForStage(stage: GeminiStage): GeminiModelId {
	return STAGE_MODELS[stage];
}
