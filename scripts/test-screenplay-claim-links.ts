/**
 * Grounding, and the two ways it would become theatre.
 *
 * First: treating the classifier's status as a verdict. A model that calls a
 * proxy airing count "supported" would put a collection artefact on air. What
 * the evidence IS decides, not what the model said about it.
 *
 * Second: treating silence as clearance. The one invented statistic in a
 * 25-minute script is exactly the line a classifier skips, so major claims are
 * detected deterministically and anything unaccounted for is marked for review.
 *
 * The copy guard is the third: reference broadcasts are supposed to contribute
 * structure, and a model given structural guidance about someone's programme
 * will sometimes reproduce their phrasing.
 */
import assert from "node:assert/strict";
import {
	buildClaimLinks,
	claimsNeedingReview,
	detectMajorClaimLines,
	numberScriptLines,
	type ClaimClassifierOutput,
} from "../lib/screenplay/grounding/claim-links";
import {
	findReferencePhraseOverlap,
	MIN_OVERLAP_CHARS,
	normaliseForOverlap,
} from "../lib/screenplay/grounding/copy-guard";
import type { ProductFact, ProductFactPack } from "../lib/screenplay/context/types";

function fact(over: Partial<ProductFact> & Pick<ProductFact, "key">): ProductFact {
	return {
		label: over.key,
		value: "x",
		evidenceClass: "internal_input",
		usage: "direct",
		evidenceItemIds: [`ev-${over.key}`],
		sourceLabel: "screenplay_brief",
		observedAt: "2026-09-05T00:00:00.000Z",
		...over,
	};
}

const PACK: ProductFactPack = {
	subjectId: "sp-1",
	canonicalProductId: null,
	facts: [
		fact({ key: "price_sale_jpy", label: "販売価格", value: 14800, unit: "JPY" }),
		fact({
			key: "seller_claim_units",
			label: "販売実績（メーカー申告）",
			value: "累計10万台",
			evidenceClass: "source_claim",
			usage: "attributed_only",
		}),
		fact({
			key: "tv_airing_count",
			label: "他局放送回数",
			value: 7,
			evidenceClass: "proxy",
			usage: "planning_only",
		}),
	],
	missing: ["guarantee"],
	forbiddenClaims: [],
	builtAt: "2026-09-05T00:00:00.000Z",
};

const SCRIPT = [
	"# 台本",
	"MC: 本日の価格は14,800円です。",
	"MC: メーカーによると累計10万台を突破しています。",
	"MC: この商品を使えば3週間でシミが消えます。",
	"MC: それでは実演をご覧ください。",
].join("\n");

async function main(): Promise<void> {
	// --- a price claim links to its price evidence -------------------------
	{
		const links = await buildClaimLinks(SCRIPT, PACK, async () => [
			{ lineStart: 2, lineEnd: 2, claimText: "14,800円", factKey: "price_sale_jpy", status: "supported", reason: "" },
			{ lineStart: 3, lineEnd: 3, claimText: "累計10万台", factKey: "seller_claim_units", status: "supported", reason: "" },
		]);
		const byLine = new Map(links.map((l) => [l.lineStart, l]));
		assert.equal(byLine.get(2)?.status, "supported");
		assert.equal(byLine.get(2)?.evidenceItemId, "ev-price_sale_jpy");

		// The classifier said "supported". The evidence is a seller's claim, so
		// it is a seller's claim.
		assert.equal(byLine.get(3)?.status, "source_claim", "a claim is not promoted by confidence");
		assert.equal(byLine.get(3)?.evidenceItemId, "ev-seller_claim_units");
		assert.ok(byLine.get(3)?.reason.includes("出典"));
	}
	console.log("✓ a price links to its evidence and a seller claim stays attributed");

	// --- an unsupported efficacy statement needs review --------------------
	{
		const links = await buildClaimLinks(SCRIPT, PACK, async () => [
			{ lineStart: 4, lineEnd: 4, claimText: "3週間でシミが消えます", factKey: null, status: "needs_review", reason: "根拠なし" },
		]);
		const efficacy = links.find((l) => l.lineStart === 4);
		assert.equal(efficacy?.status, "needs_review");
		assert.equal(efficacy?.evidenceItemId, null, "only needs_review may lack evidence, and it must lack it");
	}
	console.log("✓ an unsupported efficacy statement is marked for review");

	// --- a proxy cannot support anything said on air -----------------------
	{
		const links = await buildClaimLinks("MC: 他局でも7回放送された人気商品です。", PACK, async () => [
			{ lineStart: 1, lineEnd: 1, claimText: "7回放送された", factKey: "tv_airing_count", status: "supported", reason: "" },
		]);
		assert.equal(links[0].status, "needs_review", "a proxy shapes structure; it is not spoken as fact");
		assert.equal(links[0].evidenceItemId, null);
		assert.ok(links[0].reason.includes("代理指標"));
	}
	console.log("✓ a proxy signal cannot ground an on-air claim");

	// --- silence is not clearance ------------------------------------------
	// The classifier returned nothing at all. Every detected claim still has to
	// be accounted for.
	{
		const links = await buildClaimLinks(SCRIPT, PACK, async () => []);
		const lines = links.map((l) => l.lineStart);
		assert.ok(lines.includes(2), "a price line is a claim");
		assert.ok(lines.includes(3), "a units-sold line is a claim");
		assert.ok(lines.includes(4), "an efficacy line is a claim");
		assert.equal(links.every((l) => l.status === "needs_review"), true);
		assert.equal(claimsNeedingReview(links).length, links.length);
	}
	console.log("✓ claims the classifier skipped are detected and marked");

	// --- a classifier that throws does not clear the script ----------------
	{
		const links = await buildClaimLinks(SCRIPT, PACK, async () => {
			throw new Error("503 overloaded");
		});
		assert.ok(links.length >= 3, "a failed classifier must not produce an empty, clean-looking result");
		assert.equal(links.every((l) => l.status === "needs_review"), true);
	}
	console.log("✓ a failed classifier degrades to needs_review, never to silence");

	// --- ranges outside the script are discarded ---------------------------
	{
		const nonsense: ClaimClassifierOutput[] = [
			{ lineStart: 0, lineEnd: 1, claimText: "x", factKey: "price_sale_jpy", status: "supported", reason: "" },
			{ lineStart: 3, lineEnd: 2, claimText: "x", factKey: "price_sale_jpy", status: "supported", reason: "" },
			{ lineStart: 900, lineEnd: 901, claimText: "x", factKey: "price_sale_jpy", status: "supported", reason: "" },
			{ lineStart: 2, lineEnd: 2, claimText: "   ", factKey: "price_sale_jpy", status: "supported", reason: "" },
		];
		const links = await buildClaimLinks(SCRIPT, PACK, async () => nonsense);
		assert.equal(
			links.some((l) => l.status !== "needs_review"),
			false,
			"nothing invalid may survive as a grounded claim",
		);
	}
	console.log("✓ invalid line ranges never become grounded claims");

	// --- a fact key that does not exist grounds nothing --------------------
	{
		const links = await buildClaimLinks("MC: 満足度98%です。", PACK, async () => [
			{ lineStart: 1, lineEnd: 1, claimText: "満足度98%", factKey: "customer_satisfaction", status: "supported", reason: "" },
		]);
		assert.equal(links[0].status, "needs_review");
		assert.equal(links[0].evidenceItemId, null);
	}
	console.log("✓ an invented fact key grounds nothing");

	// --- the deterministic detector -----------------------------------------
	{
		const detected = detectMajorClaimLines(
			numberScriptLines(
				["MC: カメラ3番へ。", "MC: 3倍長持ちします。", "MC: 業界初の設計です。", "MC: シワが改善します。"].join("\n"),
			),
		);
		const kinds = new Map(detected.map((d) => [d.line, d.kind]));
		assert.equal(kinds.has(1), false, "a bare number in a camera cue is not a claim");
		assert.ok(kinds.get(2)?.includes("numeric"));
		assert.ok(kinds.get(3)?.includes("superlative"));
		assert.ok(kinds.get(4)?.includes("efficacy"));
	}
	console.log("✓ the detector fires on units, superlatives and efficacy, not on stage numbers");

	// --- the copy guard ------------------------------------------------------
	{
		const stolen =
			"このお手入れのしやすさが毎日続けられる理由なんです。フィルターは水洗いできますので清潔に保てます";
		assert.ok(normaliseForOverlap(stolen).length >= MIN_OVERLAP_CHARS);

		const script = ["# 台本", "MC: 【手元アップ】" + stolen, "MC: 独自に書いた別の一文です。"].join("\n");
		const overlaps = findReferencePhraseOverlap(script, [
			{ analysisId: "a1", broadcastId: "b1", text: `前置き。${stolen}。後置き。` },
		]);
		assert.equal(overlaps.length, 1, "a 30+ character lift is reported");
		assert.equal(overlaps[0].broadcastId, "b1");
		assert.ok(overlaps[0].length >= MIN_OVERLAP_CHARS);
		assert.equal(overlaps[0].lineStart, 2, "reported against our own line");
	}
	console.log("✓ a long verbatim overlap with a reference broadcast is reported");

	// --- formatting is not a defence ----------------------------------------
	{
		const phrase = "このお手入れのしやすさが毎日続けられる理由なんです。フィルターは水洗いできます";
		const reformatted = phrase.split("").join(" ").replace(/。/g, "、\n");
		const overlaps = findReferencePhraseOverlap(`MC: ${reformatted}`, [
			{ analysisId: "a1", broadcastId: "b1", text: phrase },
		]);
		assert.ok(overlaps.length > 0, "line breaks and spacing must not defeat the guard");
	}
	console.log("✓ reformatting does not defeat the guard");

	// --- independent writing is not flagged ---------------------------------
	{
		const overlaps = findReferencePhraseOverlap(
			"MC: 本日ご紹介するのは静音設計のブレンダーです。氷もしっかり砕けます。",
			[{ analysisId: "a1", broadcastId: "b1", text: "本日はジュエリーの新作をご紹介します。石の輝きをご覧ください。" }],
		);
		assert.deepEqual(overlaps, [], "two independently written scripts must not collide");
	}
	console.log("✓ independently written copy is not flagged");

	// --- our own product name is not their copy -----------------------------
	{
		const name = "静音ブレンダープロフェッショナルモデルウルトラサイレント2026";
		const overlaps = findReferencePhraseOverlap(`MC: ${name}をご紹介します。`, [
			{ analysisId: "a1", broadcastId: "b1", text: `${name}という商品があります。` },
		], [name]);
		assert.deepEqual(overlaps, [], "a collision on our own product name is not copying");
	}
	console.log("✓ the product name is excluded");

	console.log("PASS: screenplay claim links");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
