/**
 * Curate Candidates — Discovery skill (Stage 1).
 * Given a raw PoolItem[] from Rakuten/Brave, scores TV/EC fit per item and
 * returns the curated Candidate[] (subset with score breakdown + reasoning).
 */

import { curatePool } from "@/lib/discovery/curate";

export const buildPrompt = curatePool;
export const PROMPT_SOURCE = buildPrompt.toString();
