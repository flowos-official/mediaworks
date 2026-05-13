/**
 * Analyze Expansion Strategy — LEGACY skill.
 *
 * Pre-dating the 7-skill MD Strategy pipeline. Powers the older
 * `ExpansionAnalysis` panel (single Gemini call → ExpansionAnalysisResult).
 * Catalogued for completeness; expect deprecation once the panel migrates
 * to the registered 7-skill workflow.
 */

import { analyzeExpansionStrategy } from "@/lib/gemini";

export const buildPrompt = analyzeExpansionStrategy;
export const PROMPT_SOURCE = buildPrompt.toString();
export type { ExpansionInput as PromptInput } from "@/lib/gemini";
