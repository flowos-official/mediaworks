/**
 * Pricing & Margin — Skill 3 of the MD Strategy pipeline.
 * Per-product per-channel recommended pricing, BEP analysis, margin levers.
 * Reads priorOutputs.product_selection + priorOutputs.channel_strategy.
 */

import {
	buildPricingMarginPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildPricingMarginPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: StrategyContext;
	priorOutputs: Record<string, unknown>;
}
