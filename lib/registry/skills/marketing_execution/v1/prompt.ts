/**
 * Marketing Execution — Skill 4 of the MD Strategy pipeline.
 * 6-month monthly plans, content calendar, influencer tier plan, budget summary.
 * Reads priorOutputs.product_selection + priorOutputs.channel_strategy.
 */

import {
	buildMarketingExecutionPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildMarketingExecutionPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: StrategyContext;
	priorOutputs: Record<string, unknown>;
}
