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

export function evidenceDedupeKey(input: EvidenceDraft): string {
	const canonical = stableJson({
		subjectType: input.subjectType,
		subjectId: input.subjectId,
		predicate: input.predicate,
		sourceType: input.sourceType,
		sourceTable: input.sourceTable,
		sourceRecordId: input.sourceRecordId,
		observedAt: input.observedAt,
		valueState: input.valueState,
		value: input.value,
	});
	return createHash("sha256").update(canonical).digest("hex");
}
