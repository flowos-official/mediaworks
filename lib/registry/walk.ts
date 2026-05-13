/**
 * Filesystem walker that discovers skill versions on disk.
 * Layout:
 *   lib/registry/skills/<slug>/v<N>/{prompt.ts,schema.ts,meta.ts,README.md}
 *
 * Each version directory must export from index.ts:
 *   - default: SkillDefinition fragment ({ slug, displayName, category, prompt, outputSchema, meta })
 * The walker fills in versionLabel + versionDir from the path.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SkillDefinition } from "./types";

const SKILLS_ROOT = join(process.cwd(), "lib", "registry", "skills");

export async function walkRegistry(): Promise<SkillDefinition[]> {
	if (!existsSync(SKILLS_ROOT)) return [];

	const slugs = readdirSync(SKILLS_ROOT).filter((entry) =>
		statSync(join(SKILLS_ROOT, entry)).isDirectory(),
	);

	const results: SkillDefinition[] = [];

	for (const slug of slugs) {
		const skillDir = join(SKILLS_ROOT, slug);
		const versionDirs = readdirSync(skillDir)
			.filter((entry) => entry.startsWith("v"))
			.filter((entry) => statSync(join(skillDir, entry)).isDirectory());

		for (const versionLabel of versionDirs) {
			const versionDir = join(skillDir, versionLabel);
			const indexPath = join(versionDir, "index.ts");
			if (!existsSync(indexPath)) {
				console.warn(`[walk] skipping ${slug}/${versionLabel}: missing index.ts`);
				continue;
			}

			try {
				// pathToFileURL is required on Windows; absolute paths must be file:// URLs
				// for the ESM dynamic import to accept them.
				const mod = await import(pathToFileURL(indexPath).href);
				const def = mod.default as Omit<SkillDefinition, "versionLabel" | "versionDir">;
				results.push({ ...def, versionLabel, versionDir });
			} catch (err) {
				console.error(
					`[walk] failed to load ${slug}/${versionLabel}:`,
					err instanceof Error ? err.message : err,
				);
				throw err;
			}
		}
	}

	return results;
}
