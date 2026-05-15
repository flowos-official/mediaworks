import type { SkillDefinition } from "@/lib/registry/types";
import { PROMPT_SOURCE, buildPrompt } from "./prompt";
import { outputSchema } from "./schema";
import { meta } from "./meta";

const definition: Omit<SkillDefinition, "versionLabel" | "versionDir"> = {
	slug: "generate_tv_script_draft",
	displayName: "Generate TV Script Draft",
	category: "generation",
	promptSource: PROMPT_SOURCE,
	outputSchema,
	meta,
};

export default definition;
export { buildPrompt };
