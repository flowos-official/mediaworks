/**
 * Financial Projection — Skill 5 of the MD Strategy pipeline.
 * Monthly forecast per channel, ROI timeline, conservative/moderate/aggressive scenarios.
 */

import {
	buildFinancialProjectionPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildFinancialProjectionPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: StrategyContext;
	priorOutputs: Record<string, unknown>;
}
