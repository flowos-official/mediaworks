import type { SkillMeta } from "@/lib/registry/types";
import { GEMINI_FLASH } from "@/lib/gemini-models";

export const meta: SkillMeta = {
	model: GEMINI_FLASH,
	provider: "google",
	generationConfig: {},
	validators: [],
};
