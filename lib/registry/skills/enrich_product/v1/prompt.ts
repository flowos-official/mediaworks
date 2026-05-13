/**
 * Enrich Product — Discovery skill (Stage 2).
 *
 * Multi-step agent (tool calling) that produces a complete CPackage for a
 * discovered candidate:
 *   - manufacturer info (web search)
 *   - wholesale cost estimate (web search + retail anchor)
 *   - MOQ hint
 *   - tv_script_draft (delegated to generate_tv_script_draft skill)
 *   - SNS trend signal
 *
 * NOTE: This v1 represents the agent as a single registry entry whose
 * promptSource is the entire enrichProduct function source (captured via
 * .toString()). Tool calls are NOT flattened into a single prompt — the
 * runtime still executes the multi-turn tool loop. A future v2 will split
 * the agent into individual tool-use skills (separate spec).
 */

import { enrichProduct } from "@/lib/discovery/enrich-agent";

export const buildPrompt = enrichProduct;
export const PROMPT_SOURCE = buildPrompt.toString();
