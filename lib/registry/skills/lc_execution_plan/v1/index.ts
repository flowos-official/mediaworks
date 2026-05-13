import type { SkillDefinition } from "@/lib/registry/types";
import { PROMPT_SOURCE, buildPrompt } from "./prompt";
import { outputSchema } from "./schema";
import { meta } from "./meta";

const definition: Omit<SkillDefinition, "versionLabel" | "versionDir"> = {
	slug: "lc_execution_plan",
	displayName: "LC · Execution Plan",
	category: "analysis",
	promptSource: PROMPT_SOURCE,
	outputSchema,
	meta,
};

export default definition;
export { buildPrompt };
export type { ExecutionPlanOutput } from "./schema";
