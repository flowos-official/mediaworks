import type { SkillMeta } from "@/lib/registry/types";

export const meta: SkillMeta = {
	model: "gemini-3-flash-preview",
	provider: "google",
	generationConfig: {
		thinkingLevel: "MINIMAL",
	},
	validators: [],
};
