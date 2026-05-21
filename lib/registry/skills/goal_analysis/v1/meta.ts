import type { SkillMeta } from "@/lib/registry/types";
import { GEMINI_FLASH } from "@/lib/gemini-models";

export const meta: SkillMeta = {
	model: GEMINI_FLASH,
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
