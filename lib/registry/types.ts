/**
 * Skill & Agent Registry — shared types.
 * Ref: docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md
 */

import type { z } from "zod";

export type SkillCategory =
	| "analysis"
	| "curation"
	| "planning"
	| "enrichment"
	| "generation";

export type Provider = "google" | "anthropic";

export interface SkillMeta {
	/** Provider SDK model identifier (e.g. 'gemini-3.5-flash'). */
	model: string;
	provider: Provider;
	/** Optional generation knobs (temperature, max tokens, thinking budget). */
	generationConfig?: Record<string, unknown>;
	/** Slugs of post-hoc validators applied to the output (Phase A). */
	validators?: string[];
}

export interface SkillDefinition {
	/** Stable slug across all versions. Globally unique. */
	slug: string;
	/** Human-readable name shown in admin UI. */
	displayName: string;
	category: SkillCategory;
	/** Version directory label ('v1', 'v2-experimental', ...). */
	versionLabel: string;
	/** Absolute path to the version directory on disk (used for git_sha lookup). */
	versionDir: string;
	/** Raw prompt template source (the body of prompt.ts; stored verbatim in DB). */
	promptSource: string;
	/** Zod schema for the expected JSON output. */
	outputSchema: z.ZodTypeAny;
	meta: SkillMeta;
}

/** A pipeline DAG is a list of nodes with declared dependencies. */
export interface PipelineNode {
	skill_slug: string;
	requires: string[];
	optional?: boolean;
	retry_policy?: {
		max_retries?: number;
	};
}

export interface PipelineDefinition {
	agentSlug: string;
	versionLabel: string;
	dag: PipelineNode[];
}

export interface AgentDefinition {
	slug: string;
	displayName: string;
	description?: string;
}
