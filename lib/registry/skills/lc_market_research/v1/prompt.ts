/**
 * LC Market Research — Skill 1 of the LC strategy pipeline.
 * Brave-search-grounded analysis of Japan's live commerce market.
 */

import {
	buildLCMarketResearchPrompt,
	type LCContext,
} from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCMarketResearchPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: LCContext;
	priorOutputs: Record<string, unknown>;
}
