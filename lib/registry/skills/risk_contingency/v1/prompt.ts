/**
 * Risk & Contingency — Skill 6 of the MD Strategy pipeline.
 * Per-channel risk matrix, top-5 risks with mitigation playbooks, go/no-go criteria.
 */

import {
	buildRiskContingencyPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildRiskContingencyPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: StrategyContext;
	priorOutputs: Record<string, unknown>;
}
