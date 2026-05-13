/**
 * Tag Broadcast Evidence — Discovery skill.
 * For each candidate, query Brave for competitor TV-shopping broadcasts then
 * batch-classify via Gemini into broadcast_confirmed | broadcast_likely | unknown.
 */

import { tagBroadcastEvidence } from "@/lib/discovery/broadcast";

export const buildPrompt = tagBroadcastEvidence;
export const PROMPT_SOURCE = buildPrompt.toString();
