/**
 * LC Content Strategy — Skill 3.
 * Per-platform broadcast format, optimal times, host style, content ideas.
 */

import {
	buildLCContentStrategyPrompt,
	type LCContext,
} from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCContentStrategyPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: LCContext;
	priorOutputs: Record<string, unknown>;
}
