import { createHash } from "node:crypto";

import type { EvidenceDraft } from "./types";

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;

	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}

export function buildEvidenceDraft(input: EvidenceDraft): EvidenceDraft {
	const hasValue = input.value !== undefined && input.value !== null;
	if (input.valueState === "known" && !hasValue) {
		throw new Error("Known evidence requires a non-null value");
	}
	if (input.valueState !== "known" && input.value !== undefined) {
		throw new Error("Non-known evidence must not include a value");
	}
	return input;
}

/**
 * The same instant reaches this function spelled several ways: PostgREST
 * returns a timestamptz as `+00:00`, `toISOString()` produces `Z`, and a date
 * column arrives bare. Postgres normalizes all three to one value, so hashing
 * the raw string made a re-run of the same backfill mint a second row for a
 * fact that had not changed — and `selectActiveEvidence` keeps every row at the
 * newest timestamp, so both then counted.
 */
function canonicalObservedAt(observedAt: string): string {
	const parsed = Date.parse(observedAt);
	// An unparseable value is left alone rather than silently collapsed: it will
	// fail the database's timestamptz cast, which is the honest outcome.
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : observedAt;
}

/**
 * `unit` and `evidenceClass` are part of the identity of a fact, not decoration
 * on it. Without them "1200 JPY" and "1200 USD" hashed the same, and so did a
 * `verified` measurement and a `proxy` signal — and because the repository
 * upserts with `ignoreDuplicates`, the later draft was dropped while the caller
 * received the id of the earlier, differently-classed row. The verified/proxy
 * distinction is the premise of this whole design, so it cannot be a field that
 * two rows are allowed to disagree on under one key.
 */
export function evidenceDedupeKey(input: EvidenceDraft): string {
	const canonical = stableJson({
		subjectType: input.subjectType,
		subjectId: input.subjectId,
		predicate: input.predicate,
		sourceType: input.sourceType,
		sourceTable: input.sourceTable,
		sourceRecordId: input.sourceRecordId,
		observedAt: canonicalObservedAt(input.observedAt),
		valueState: input.valueState,
		evidenceClass: input.evidenceClass,
		unit: input.unit ?? null,
		value: input.value,
	});
	return createHash("sha256").update(canonical).digest("hex");
}
