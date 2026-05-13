/**
 * Generate Weekly Insight — Discovery analytics skill.
 * Takes the previous week's feedback aggregate (per-context) and produces
 * a narrative summary with sourced patterns, exploration wins, next-week
 * suggestions. Used by the weekly cron + admin insights dashboard.
 */

import { generateWeeklyInsight } from "@/lib/discovery/weekly-insights";

export const buildPrompt = generateWeeklyInsight;
export const PROMPT_SOURCE = buildPrompt.toString();
export type { WeeklyInsightInput as PromptInput } from "@/lib/discovery/weekly-insights";
