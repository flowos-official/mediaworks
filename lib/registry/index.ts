/**
 * Skill & Agent Registry — barrel exports.
 * Ref: docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md
 *
 * Telemetry helpers (callGeminiWithTelemetry, pricing, runner) land in
 * follow-up PRs; this barrel currently exposes only the type+walk layer
 * that the publish script needs.
 */

export type {
	SkillDefinition,
	SkillMeta,
	SkillCategory,
	Provider,
	PipelineNode,
	PipelineDefinition,
	AgentDefinition,
} from "./types";
export { walkRegistry } from "./walk";
