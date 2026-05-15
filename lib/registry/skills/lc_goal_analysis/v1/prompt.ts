/**
 * Live Commerce Goal Analysis — Skill 0 of the LC strategy pipeline.
 * Parses userGoal into ParsedGoal with target_platforms (TikTok Live etc.)
 * rather than target_channels (Amazon, 楽天 etc.) — different from md_strategy's
 * goal_analysis skill.
 */

import { buildLCGoalAnalysisPrompt } from "@/lib/live-commerce-strategy";

export const buildPrompt = buildLCGoalAnalysisPrompt;
export const PROMPT_SOURCE = buildPrompt.toString();
export interface PromptInput {
	userGoal: string;
}
