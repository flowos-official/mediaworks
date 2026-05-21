import type { SkillMeta } from "@/lib/registry/types";
import { GEMINI_FLASH } from "@/lib/gemini-models";

export const meta: SkillMeta = {
	model: GEMINI_FLASH,
	provider: "google",
	// Multi-stage pipeline: pool query + Rakuten/Brave search + Gemini ranking
	// + sanity-pass. Full runtime config lives in lib/md-strategy.ts;
	// captured here for catalog purposes only.
	generationConfig: {
		stages: "pool_query + rakuten + brave + gemini_curation + sanity_pass",
	},
	validators: [],
};
