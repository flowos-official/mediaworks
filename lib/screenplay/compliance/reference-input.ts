// Pure validation/normalization for compliance_references create/update payloads.
// No server-only / Next imports so it can be unit-tested via tsx.

import type { ReferenceLaw } from "./types";

export const REFERENCE_LAWS: ReferenceLaw[] = ["yakkiho", "keihyo", "kenzo", "other"];

export interface ReferenceInput {
	law?: string;
	category_scope?: unknown;
	topic?: string;
	body?: string;
	keywords?: unknown;
	citation?: string;
	source_url?: string;
	active?: boolean;
}

export type NormalizeResult =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string };

function toArray(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter(Boolean);
	return [];
}

function validUrl(u: string): boolean {
	if (u === "") return true;
	return /^https?:\/\//i.test(u) && u.length <= 500;
}

export function normalizeReference(input: unknown, partial = false): NormalizeResult {
	const body: ReferenceInput = (input && typeof input === "object" ? input : {}) as ReferenceInput;
	const out: Record<string, unknown> = {};

	if (body.law !== undefined || !partial) {
		if (!REFERENCE_LAWS.includes(body.law as ReferenceLaw)) return { ok: false, error: "invalid law" };
		out.law = body.law;
	}
	if (body.topic !== undefined || !partial) {
		const t = (body.topic ?? "").trim();
		if (!t) return { ok: false, error: "topic is required" };
		out.topic = t.slice(0, 200);
	}
	if (body.body !== undefined || !partial) {
		const b = (body.body ?? "").trim();
		if (!b) return { ok: false, error: "body is required" };
		out.body = b.slice(0, 4000);
	}
	if (body.category_scope !== undefined || !partial) out.category_scope = toArray(body.category_scope);
	if (body.keywords !== undefined || !partial) out.keywords = toArray(body.keywords);
	if (body.citation !== undefined || !partial) out.citation = (body.citation ?? "").slice(0, 300);
	if (body.source_url !== undefined || !partial) {
		const u = (body.source_url ?? "").trim();
		if (!validUrl(u)) return { ok: false, error: "source_url must be http(s) or empty" };
		out.source_url = u;
	}
	if (body.active !== undefined) out.active = !!body.active;
	else if (!partial) out.active = true;

	return { ok: true, value: out };
}
