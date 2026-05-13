/**
 * Product Selection — Skill 1 of the MD Strategy pipeline.
 *
 * Selects which TV-proven products move to which channel (tier1/tier2/exclude)
 * and articulates the portfolio strategy. Foundational skill: downstream
 * (channel_strategy, pricing_margin, etc.) read its output via priorOutputs.
 *
 * The runtime prompt builder lives in lib/md-strategy.ts and accepts the full
 * StrategyContext (top 30 products with metrics, parsed goal, search sources,
 * optional seed product). The registry re-exports it verbatim; PROMPT_SOURCE
 * is the function's JS source captured at module load for audit display.
 */

import {
	buildProductSelectionPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildProductSelectionPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export type PromptInput = StrategyContext;
