/**
 * Category Plan — Discovery skill (Stage 0).
 * Generates today's discovery keyword plan ({tv_proven, exploration})
 * respecting learning_state's exploration_ratio + category_weights +
 * seasonal_weights + recent rejection reasons.
 */

import { buildCategoryPlan } from "@/lib/discovery/plan";

export const buildPrompt = buildCategoryPlan;
export const PROMPT_SOURCE = buildPrompt.toString();
