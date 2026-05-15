import type { SkillDefinition } from "@/lib/registry/types";
import { PROMPT_SOURCE, buildPrompt } from "./prompt";
import { outputSchema } from "./schema";
import { meta } from "./meta";

const definition: Omit<SkillDefinition, "versionLabel" | "versionDir"> = {
	slug: "lc_goal_analysis",
	displayName: "LC · Goal Analysis",
	category: "analysis",
	promptSource: PROMPT_SOURCE,
	outputSchema,
	meta,
};

export default definition;
export { buildPrompt };
export type { LCParsedGoal } from "./schema";
