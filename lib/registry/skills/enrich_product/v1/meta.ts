import type { SkillMeta } from "@/lib/registry/types";
import { GEMINI_FLASH } from "@/lib/gemini-models";

export const meta: SkillMeta = {
	model: GEMINI_FLASH,
	provider: "google",
	// Tool-calling agent. Full runtime config lives in lib/discovery/enrich-agent.ts;
	// captured here for catalog purposes only.
	generationConfig: {
		tools: "web_search + price_query + tv_script_delegate",
	},
	validators: [],
};
