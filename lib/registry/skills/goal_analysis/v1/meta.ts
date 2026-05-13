import type { SkillMeta } from "@/lib/registry/types";

export const meta: SkillMeta = {
	model: "gemini-3-flash-preview",
	provider: "google",
	// Matches the runtime config in lib/md-strategy.ts:callGeminiOnce —
	// MINIMAL thinking for the flash model (LOW reserved for pro fallback).
	generationConfig: {
		thinkingLevel: "MINIMAL",
	},
	// Phase A will populate this with deterministic validator slugs
	// (schema_strict, cross_skill_consistency, etc.).
	validators: [],
};
