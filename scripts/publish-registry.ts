/**
 * Skill & Agent Registry — publish script (CI step).
 *
 * Walks lib/registry/skills/<slug>/v<N>/index.ts modules and publishes each
 * to Supabase. Idempotent: (skill_id, git_sha) is UNIQUE, so re-running
 * the same SHA is a no-op. A version is promoted to "active" when the
 * skill's active.txt file matches the versionLabel.
 *
 * Ref: docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md §6-7
 *
 * Usage:
 *   npm run publish-registry
 *   GITHUB_SHA=<sha> GITHUB_ACTOR=<user> npm run publish-registry
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { z } from "zod";
import { walkRegistry } from "@/lib/registry/walk";
import type { SkillDefinition } from "@/lib/registry/types";
import { getServiceClient } from "@/lib/supabase";

function resolveGitSha(): string {
	const fromEnv = process.env.GITHUB_SHA?.trim();
	if (fromEnv) return fromEnv;
	try {
		// execFileSync avoids any shell interpolation; no untrusted input.
		return execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
	} catch (err) {
		throw new Error(
			`Cannot determine git SHA: set GITHUB_SHA env or run inside a git repo (${err instanceof Error ? err.message : err})`,
		);
	}
}

function resolveActor(): string {
	return process.env.GITHUB_ACTOR?.trim() || process.env.USER?.trim() || "local";
}

function readActiveLabel(skill: SkillDefinition): string | null {
	const activePath = join(dirname(skill.versionDir), "active.txt");
	if (!existsSync(activePath)) return null;
	return readFileSync(activePath, "utf8").trim();
}

async function publishSkill(
	skill: SkillDefinition,
	gitSha: string,
	publishedBy: string,
): Promise<{ skillId: string; versionId: string; promoted: boolean }> {
	const sb = getServiceClient();

	// Convert Zod schema → JSON Schema using Zod 4's built-in converter.
	// Fails publish if the schema is malformed.
	let schemaJson: object;
	try {
		schemaJson = z.toJSONSchema(skill.outputSchema);
	} catch (err) {
		throw new Error(
			`Skill ${skill.slug} ${skill.versionLabel}: invalid Zod schema (${err instanceof Error ? err.message : err})`,
		);
	}

	// 1) Upsert skill row (stable identity)
	const { data: existingSkill } = await sb
		.from("skills")
		.select("id")
		.eq("slug", skill.slug)
		.maybeSingle();

	let skillId: string;
	if (existingSkill) {
		skillId = existingSkill.id as string;
	} else {
		const { data: inserted, error: insErr } = await sb
			.from("skills")
			.insert({
				slug: skill.slug,
				display_name: skill.displayName,
				category: skill.category,
			})
			.select("id")
			.single();
		if (insErr || !inserted) {
			throw new Error(`Failed to insert skill ${skill.slug}: ${insErr?.message}`);
		}
		skillId = inserted.id as string;
	}

	// 2) Insert skill_version if (skill_id, git_sha) is new
	const { data: existingVersion } = await sb
		.from("skill_versions")
		.select("id")
		.eq("skill_id", skillId)
		.eq("git_sha", gitSha)
		.maybeSingle();

	let versionId: string;
	if (existingVersion) {
		versionId = existingVersion.id as string;
	} else {
		const { data: insertedVer, error: verErr } = await sb
			.from("skill_versions")
			.insert({
				skill_id: skillId,
				git_sha: gitSha,
				version_label: skill.versionLabel,
				prompt_template: skill.promptSource,
				output_schema: schemaJson as Record<string, unknown>,
				model: skill.meta.model,
				provider: skill.meta.provider,
				generation_config: skill.meta.generationConfig ?? {},
				validators: skill.meta.validators ?? [],
				published_by: publishedBy,
			})
			.select("id")
			.single();
		if (verErr || !insertedVer) {
			throw new Error(
				`Failed to insert skill_version ${skill.slug}/${skill.versionLabel}: ${verErr?.message}`,
			);
		}
		versionId = insertedVer.id as string;
	}

	// 3) Promote to active if active.txt matches
	let promoted = false;
	const activeLabel = readActiveLabel(skill);
	if (activeLabel === skill.versionLabel) {
		const { error: updErr } = await sb
			.from("skills")
			.update({ active_version_id: versionId })
			.eq("id", skillId);
		if (updErr) {
			throw new Error(
				`Failed to set active_version for ${skill.slug}: ${updErr.message}`,
			);
		}
		promoted = true;
	}

	return { skillId, versionId, promoted };
}

async function main() {
	const gitSha = resolveGitSha();
	const publishedBy = resolveActor();

	console.log(`[publish-registry] git_sha=${gitSha} actor=${publishedBy}`);

	const skills = await walkRegistry();
	console.log(`[publish-registry] discovered ${skills.length} skill version(s)`);

	if (skills.length === 0) {
		console.log("[publish-registry] no skills to publish — exiting cleanly");
		return;
	}

	let published = 0;
	let promoted = 0;

	for (const skill of skills) {
		const result = await publishSkill(skill, gitSha, publishedBy);
		published += 1;
		if (result.promoted) promoted += 1;
		console.log(
			`[publish-registry] ${skill.slug}/${skill.versionLabel} → version=${result.versionId} ${result.promoted ? "(active)" : ""}`,
		);
	}

	console.log(
		`[publish-registry] done: ${published} versions ensured, ${promoted} promoted to active`,
	);
}

main().catch((err) => {
	console.error("[publish-registry] FAILED:", err instanceof Error ? err.message : err);
	process.exit(1);
});
