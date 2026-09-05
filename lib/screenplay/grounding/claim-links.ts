/**
 * Tie every factual statement in the script back to the evidence behind it —
 * or mark it as needing a human.
 *
 * The contract is deliberately blunt: a `supported` or `source_claim` link
 * MUST carry an evidence id, and only `needs_review` may lack one. The
 * database enforces the same thing as a biconditional CHECK, so a claim cannot
 * be recorded as grounded without naming what grounds it.
 *
 * Two things stop this from being theatre.
 *
 *   The classifier's status is a proposal, not a verdict. What the evidence
 *   actually is decides: a fact whose usage is `attributed_only` produces a
 *   `source_claim` link however confidently the model called it supported, and
 *   a `planning_only` fact — a proxy, an inference — cannot support an on-air
 *   claim at all.
 *
 *   Silence is not clearance. Lines carrying a number, an efficacy word or a
 *   superlative are detected here, deterministically; any the classifier did
 *   not return become `needs_review`. A model that overlooks the one invented
 *   statistic in a 25-minute script must not thereby bless it.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { ProductFact, ProductFactPack } from "@/lib/screenplay/context/types";

export type ClaimStatus = "supported" | "source_claim" | "needs_review";

export interface ClaimLinkDraft {
	lineStart: number;
	lineEnd: number;
	claimText: string;
	status: ClaimStatus;
	evidenceItemId: string | null;
	reason: string;
}

export interface ClaimClassifierInput {
	numberedLines: Array<{ line: number; text: string }>;
	facts: ProductFact[];
}

export interface ClaimClassifierOutput {
	lineStart: number;
	lineEnd: number;
	claimText: string;
	factKey: string | null;
	status: ClaimStatus;
	reason: string;
}

export type ClaimClassifier = (input: ClaimClassifierInput) => Promise<ClaimClassifierOutput[]>;

/** A number with a unit or counter attached. A bare "3" in a stage direction
 *  is not a claim; "3倍" is. Full-width digits and a Japanese magnitude
 *  character are both in scope: 「累計10万台」 is the shape a sales claim
 *  actually takes, and an ASCII-only pattern walks straight past it. */
const NUMERIC =
	/[0-9０-９][0-9０-９,.，．]*\s*[万億千百]?\s*(?:%|％|割|円|人|件|台|本|枚|個|回|倍|分|秒|時間|日|年|kg|g|ml|L|cm|mm|度|℃|W|Hz)/;
const EFFICACY = /(効果|効能|改善|治る|治療|予防|解消|痩せ|やせ|若返|美白|シミ|シワ|殺菌|除菌|抗菌)/;
const SUPERLATIVE = /(最高|最強|最安|最上|唯一|業界初|世界初|日本一|世界一|ナンバーワン|No\.?\s*1|№1|一番)/i;

/** Deterministic. This is the half that does not depend on a model noticing. */
export function detectMajorClaimLines(
	numberedLines: ReadonlyArray<{ line: number; text: string }>,
): Array<{ line: number; text: string; kind: string }> {
	const found: Array<{ line: number; text: string; kind: string }> = [];
	for (const { line, text } of numberedLines) {
		const kinds: string[] = [];
		if (NUMERIC.test(text)) kinds.push("numeric");
		if (EFFICACY.test(text)) kinds.push("efficacy");
		if (SUPERLATIVE.test(text)) kinds.push("superlative");
		if (kinds.length > 0) found.push({ line, text, kind: kinds.join("+") });
	}
	return found;
}

export function numberScriptLines(markdown: string): Array<{ line: number; text: string }> {
	return markdown
		.split("\n")
		.map((text, i) => ({ line: i + 1, text: text.trim() }))
		.filter((entry) => entry.text.length > 0);
}

/**
 * What the evidence permits, given what the classifier proposed. The fact
 * decides; the model only points at one.
 */
function resolve(
	proposed: ClaimStatus,
	fact: ProductFact | undefined,
): { status: ClaimStatus; evidenceItemId: string | null; reason: string } {
	if (proposed === "needs_review") {
		return { status: "needs_review", evidenceItemId: null, reason: "" };
	}
	if (!fact) {
		return {
			status: "needs_review",
			evidenceItemId: null,
			reason: "根拠として指定された事実が事実欄に存在しません",
		};
	}
	const evidenceItemId = fact.evidenceItemIds[0];
	if (!evidenceItemId) {
		return {
			status: "needs_review",
			evidenceItemId: null,
			reason: `「${fact.label}」に紐づく証拠レコードがありません`,
		};
	}
	if (fact.usage === "planning_only") {
		// A proxy or an inference can shape the running order. It cannot be the
		// basis of something said on air, whatever the classifier decided.
		return {
			status: "needs_review",
			evidenceItemId: null,
			reason: `「${fact.label}」は代理指標・推定値のため放送での断定根拠になりません`,
		};
	}
	if (fact.usage === "attributed_only") {
		return {
			status: "source_claim",
			evidenceItemId,
			reason: `「${fact.label}」はメーカー申告のため出典を明示した引用としてのみ使用可`,
		};
	}
	return { status: "supported", evidenceItemId, reason: `「${fact.label}」に基づく` };
}

export async function buildClaimLinks(
	markdown: string,
	factPack: ProductFactPack,
	classifyClaims: ClaimClassifier,
): Promise<ClaimLinkDraft[]> {
	const numberedLines = numberScriptLines(markdown);
	if (numberedLines.length === 0) return [];
	const maxLine = numberedLines[numberedLines.length - 1].line;
	const factsByKey = new Map(factPack.facts.map((f) => [f.key, f]));

	let classified: ClaimClassifierOutput[] = [];
	try {
		classified = await classifyClaims({ numberedLines, facts: factPack.facts });
	} catch (error) {
		// A classifier that fell over must not produce a script full of
		// silently-approved claims. Every detected claim then needs review.
		console.warn(
			"[screenplay] claim classifier failed; every detected claim falls back to needs_review:",
			error instanceof Error ? error.message : String(error),
		);
		classified = [];
	}

	const drafts: ClaimLinkDraft[] = [];
	const covered = new Set<number>();

	for (const output of classified) {
		const lineStart = Math.trunc(output.lineStart);
		const lineEnd = Math.trunc(output.lineEnd);
		// A range the script does not have is not a claim about the script.
		if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) continue;
		if (lineStart < 1 || lineEnd < lineStart || lineEnd > maxLine) continue;
		const claimText = (output.claimText ?? "").trim();
		if (!claimText) continue;

		const fact = output.factKey ? factsByKey.get(output.factKey) : undefined;
		const resolved = resolve(output.status, fact);
		drafts.push({
			lineStart,
			lineEnd,
			claimText: claimText.slice(0, 500),
			status: resolved.status,
			evidenceItemId: resolved.evidenceItemId,
			reason: (resolved.reason || output.reason || "根拠未確認").slice(0, 500),
		});
		for (let line = lineStart; line <= lineEnd; line++) covered.add(line);
	}

	// Anything the classifier passed over that looks like a claim.
	for (const claim of detectMajorClaimLines(numberedLines)) {
		if (covered.has(claim.line)) continue;
		drafts.push({
			lineStart: claim.line,
			lineEnd: claim.line,
			claimText: claim.text.slice(0, 500),
			status: "needs_review",
			evidenceItemId: null,
			reason: `自動検出（${claim.kind}）: 根拠が特定できていません`,
		});
	}

	return drafts.sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
}

/** True when nothing in the script is making an unaccounted-for claim. */
export function claimsNeedingReview(drafts: readonly ClaimLinkDraft[]): ClaimLinkDraft[] {
	return drafts.filter((d) => d.status === "needs_review");
}
