/**
 * LC Platform Analysis — Skill 2 of the LC strategy pipeline.
 * Per-platform fit score, commission, success cases, recommended own products.
 */

import {
	buildLCPlatformAnalysisPrompt,
	type LCContext,
} from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCPlatformAnalysisPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: LCContext;
	priorOutputs: Record<string, unknown>;
}
