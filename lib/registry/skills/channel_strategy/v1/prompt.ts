/**
 * Channel Strategy — Skill 2 of the MD Strategy pipeline.
 *
 * For each candidate channel: fit score, entry requirements, fee structure,
 * competitive landscape, ops needs, KPIs. Also produces a launch sequence.
 * Foundational — pricing_margin / marketing_execution / financial_projection
 * / risk_contingency all read this output via priorOutputs.channel_strategy.
 */

import {
	buildChannelStrategyPrompt,
	type StrategyContext,
} from "@/lib/md-strategy";

export const buildPrompt = buildChannelStrategyPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	ctx: StrategyContext;
	priorOutputs: Record<string, unknown>;
}
