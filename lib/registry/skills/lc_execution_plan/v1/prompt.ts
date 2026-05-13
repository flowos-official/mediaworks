/**
 * LC Execution Plan — Skill 4.
 * Phased rollout, staffing, tools & services.
 */

import {
	buildLCExecutionPlanPrompt,
	type LCContext,
} from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCExecutionPlanPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: LCContext;
	priorOutputs: Record<string, unknown>;
}
