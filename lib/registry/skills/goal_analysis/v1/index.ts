import type { SkillDefinition } from "@/lib/registry/types";
import { PROMPT_TEMPLATE, buildPrompt } from "./prompt";
import { outputSchema } from "./schema";
import { meta } from "./meta";

const definition: Omit<SkillDefinition, "versionLabel" | "versionDir"> = {
	slug: "goal_analysis",
	displayName: "Goal Analysis",
	category: "analysis",
	promptSource: PROMPT_TEMPLATE,
	outputSchema,
	meta,
};

export default definition;
export { buildPrompt };
export type { GoalAnalysisInput } from "./prompt";
export type { ParsedGoal } from "./schema";
