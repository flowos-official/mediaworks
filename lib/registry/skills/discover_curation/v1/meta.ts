import type { SkillMeta } from "@/lib/registry/types";

export const meta: SkillMeta = {
	model: "gemini-3-flash-preview",
	provider: "google",
	// Multi-stage pipeline: pool query + Rakuten/Brave search + Gemini ranking
	// + sanity-pass. Full runtime config lives in lib/md-strategy.ts;
	// captured here for catalog purposes only.
	generationConfig: {
		stages: "pool_query + rakuten + brave + gemini_curation + sanity_pass",
	},
	validators: [],
};
