/**
 * Discover Curation — MD strategy skill (Stage 8 / final).
 *
 * Multi-stage Gemini call inside `discoverNewProducts`:
 *   1. Pool-first: query discovered_products (Strategy ↔ Discovery integration)
 *   2. Optional Rakuten + Brave fresh search to fill pool deficits
 *   3. Build the large curation prompt with TV signals + japan-market trends
 *   4. Gemini ranks / scores / annotates each pool item
 *   5. Sanity-pass filter (anti-hallucination — items must match pool words/URL)
 *
 * Registry v1 catalogs the entire `discoverNewProducts` function via
 * Function.prototype.toString() rather than extracting the inline prompt —
 * the prompt depends on 10+ context strings assembled by the function itself
 * (signalText / japanMarketContext / poolText / suitabilityBlock / etc.) and
 * clean extraction is impractical without restructuring the multi-stage logic.
 *
 * This matches the δ3 pattern (Discovery + legacy) and the spec §15.4 note
 * about complex orchestrations being cataloged whole at v1.
 */

import { discoverNewProducts } from "@/lib/md-strategy";

export const buildPrompt = discoverNewProducts;
export const PROMPT_SOURCE = buildPrompt.toString();
export type { DiscoverInput as PromptInput } from "@/lib/md-strategy";
