/**
 * LC Risk Analysis — Skill 5 (last).
 * Risk list with severity/probability/mitigation, contingency plans, success factors.
 */

import {
	buildLCRiskAnalysisPrompt,
	type LCContext,
} from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCRiskAnalysisPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: LCContext;
	priorOutputs: Record<string, unknown>;
}
