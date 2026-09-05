/**
 * The one screen affordance that spends money and leaves the building.
 *
 * Everything else on this surface reads stored data. The failure this guards
 * against is an operator triggering an external search by accident — or,
 * worse, a dialog that fires the request as it opens, which would make the
 * "stored-only by default" claim untrue for anyone who merely looked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SUPPLEMENT_GAPS } from "../lib/intelligence/supplement/types";
import { preselectedGaps } from "../components/product-finder/SupplementResearchDialog";

function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

const dialog = code("components/product-finder/SupplementResearchDialog.tsx");
const card = code("components/product-finder/ProductFinderResultCard.tsx");
const client = code("components/product-finder/ProductFinderClient.tsx");

// --- opening the dialog makes no request ------------------------------------
{
	// The only fetch in the dialog must be inside the run handler, never in an
	// effect or at render.
	assert.equal(
		/useEffect/.test(dialog),
		false,
		"a dialog that fetches on open turns merely looking into an external search",
	);
	const fetches = [...dialog.matchAll(/fetch\(/g)].length;
	assert.equal(fetches, 1, "the dialog makes exactly one request, and only when run");
	const runBody = dialog.slice(dialog.indexOf("async function run()"));
	assert.ok(runBody.includes("fetch("), "the request lives in the run handler");
}
console.log("✓ opening the dialog issues no request");

// --- only the five allowed gaps are offered ---------------------------------
{
	assert.ok(
		dialog.includes("SUPPLEMENT_GAPS.map("),
		"the checkboxes must be generated from the allowed set, not hand-listed",
	);
	for (const forbidden of ["actual_competitor_revenue", "competitor_sales", "actual_sales"]) {
		assert.equal(dialog.includes(forbidden), false, `${forbidden} must not be offerable`);
	}
	const messages = JSON.parse(readFileSync("messages/ja.json", "utf8")) as Record<string, never>;
	const supplement = (messages.productFinder as Record<string, Record<string, Record<string, string>>>)
		.supplement;
	for (const gap of SUPPLEMENT_GAPS) {
		assert.ok(supplement.gap?.[gap], `ja is missing a label for ${gap}`);
		// What the result can BECOME is stated next to the checkbox, before it
		// is ticked — not discovered afterwards in a badge.
		assert.ok(supplement.gapClass?.[gap], `ja is missing the source-class rule for ${gap}`);
	}
	const ko = JSON.parse(readFileSync("messages/ko.json", "utf8")) as Record<string, never>;
	const koSupplement = (ko.productFinder as Record<string, Record<string, Record<string, string>>>)
		.supplement;
	for (const gap of SUPPLEMENT_GAPS) {
		assert.ok(koSupplement.gap?.[gap], `ko is missing a label for ${gap}`);
		assert.ok(koSupplement.gapClass?.[gap], `ko is missing the source-class rule for ${gap}`);
	}
	// The seller-claim rule is the one that must be visible before running.
	assert.ok(
		supplement.gapClass.seller_sales_claim.includes("メーカー主張"),
		"an operator must be told a sales claim stays a claim BEFORE paying for it",
	);
}
console.log("✓ only the five allowed gaps are offered, each with its source-class rule");

// --- running takes a second, separate confirmation --------------------------
{
	assert.ok(dialog.includes("confirming"), "there is an explicit confirmation state");
	assert.ok(
		dialog.includes("confirmSentence"),
		"the confirmation states what will be searched, in words",
	);
	assert.ok(
		/disabled=\{selected\.length === 0\}/.test(dialog),
		"a request with no gaps selected must be impossible",
	);
	assert.ok(
		/if \(selected\.length === 0\) return;/.test(dialog),
		"and impossible in the handler too, not only in the button",
	);
	assert.ok(
		/setConfirming\(true\)/.test(dialog) && /setConfirming\(false\)/.test(dialog),
		"changing the selection must reset the confirmation, not carry it over",
	);
}
console.log("✓ running requires a second confirmation that names what will happen");

// --- preselection follows the item's own gaps -------------------------------
{
	assert.deepEqual(preselectedGaps(["価格: 裏づけとなるデータがありません price"]), ["current_price"]);
	assert.deepEqual(preselectedGaps(["review_count のデータがありません"]), ["review_signal"]);
	const both = preselectedGaps(["price", "review_count"]);
	assert.ok(both.includes("current_price") && both.includes("review_signal"));
	// Never an empty form the operator has to guess their way through.
	assert.deepEqual(preselectedGaps([]), ["current_price"]);
	// Preselection is a suggestion, not the whole menu — every gap stays
	// tickable, so an operator is never blocked from asking for one.
	assert.ok(preselectedGaps(["price"]).every((gap) => SUPPLEMENT_GAPS.includes(gap)));
}
console.log("✓ the preselection follows the item's missing data and is never empty");

// --- the original result is preserved ---------------------------------------
{
	assert.ok(
		client.includes("priorResult"),
		"the run being replaced must be kept — otherwise there is nothing to see what the research changed",
	);
	assert.ok(client.includes("backToOriginal"), "and a way back to it");
	assert.ok(
		client.includes("supplement.applied"),
		"the operator is told the result they are looking at is a supplemented one",
	);
	// The card hands the new run up rather than replacing itself in place.
	assert.ok(card.includes("onSupplemented"), "the card reports success upward");
	assert.equal(
		/setResult\(/.test(card),
		false,
		"a card must not swap out the result set it is a member of",
	);
}
console.log("✓ the supplemented run is shown without destroying the original");

// --- a failed run never looks like a new result -----------------------------
{
	assert.ok(
		/payload\.status === "failed"/.test(dialog),
		"a 200-shaped body with status failed must not be treated as success",
	);
	assert.ok(
		dialog.includes("t(\"failed\")"),
		"and the operator is told the original result is still usable",
	);
}
console.log("✓ a failed research run is reported, not silently shown as a result");

console.log("PASS: supplemental research view");
