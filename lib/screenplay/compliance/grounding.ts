// Pure grounding-snapshot helpers. No server-only / Next imports so they can be
// unit-tested directly via tsx. Shared by check.ts.

import { createHash } from "node:crypto";
import type { ComplianceReference, ReferenceSnapshot } from "./types";

/**
 * Immutable snapshot of every injected reference, carrying the FULL canonical
 * payload (incl. `body`, `category_scope`, `keywords`) so a past check stays
 * reproducible even after the live corpus row is edited or deactivated.
 * Preserves the retrieval-ranked order of `refs`. Arrays are sorted for a stable
 * representation (Codex audit #2).
 */
export function buildReferenceSnapshot(refs: ComplianceReference[]): ReferenceSnapshot[] {
	return refs.map((r) => ({
		id: r.id,
		law: r.law,
		category_scope: [...r.category_scope].sort(),
		topic: r.topic,
		body: r.body,
		keywords: [...r.keywords].sort(),
		citation: r.citation,
		source_url: r.source_url,
	}));
}

/**
 * sha256 (short) over the canonical snapshot of ALL injected reference fields,
 * order-independent (sorted by id). Editing any field that feeds the prompt /
 * retrieval / allowlist changes the hash, so corpus drift behind a stored check
 * is detectable.
 */
export function corpusHashOf(refs: ComplianceReference[]): string {
	const canonical = buildReferenceSnapshot(refs).sort((a, b) => a.id.localeCompare(b.id));
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}
