import type { SkillDefinition } from "@/lib/registry/types";
import { PROMPT_SOURCE, buildPrompt } from "./prompt";
import { outputSchema } from "./schema";
import { meta } from "./meta";

const definition: Omit<SkillDefinition, "versionLabel" | "versionDir"> = {
	slug: "tag_broadcast_evidence",
	displayName: "Tag Broadcast Evidence",
	category: "enrichment",
	promptSource: PROMPT_SOURCE,
	outputSchema,
	meta,
};

export default definition;
export { buildPrompt };
