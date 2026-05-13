/**
 * Generate TV Script Draft — Discovery skill.
 * Produces a 30-second Japanese TV-shopping broadcast script for an
 * enriched product. Single-shot Gemini call with structured prompt.
 */

import { generateTvScriptDraft } from "@/lib/discovery/tools/tv-script";

export const buildPrompt = generateTvScriptDraft;
export const PROMPT_SOURCE = buildPrompt.toString();
export type { TvScriptInput as PromptInput } from "@/lib/discovery/tools/tv-script";
