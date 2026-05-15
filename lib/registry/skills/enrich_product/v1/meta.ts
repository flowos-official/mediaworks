import type { SkillMeta } from "@/lib/registry/types";

export const meta: SkillMeta = {
	model: "gemini-3-flash-preview",
	provider: "google",
	// Tool-calling agent. Full runtime config lives in lib/discovery/enrich-agent.ts;
	// captured here for catalog purposes only.
	generationConfig: {
		tools: "web_search + price_query + tv_script_delegate",
	},
	validators: [],
};
