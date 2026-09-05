import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AXIS_KEYS } from "../lib/product-finder/types";

/**
 * Structural review of the finder surface.
 *
 * These assert what the screen is allowed to DO — which endpoints it may call,
 * which roles may reach it, and that an unknown number is rendered as unknown.
 * A behavioural test would not catch a second `fetch` added for convenience,
 * and that is the change that would quietly make this surface expensive.
 */

/** Read a source file with comments stripped.
 *
 * These guards are about what the code does. Scanning prose too makes a rule
 * unstatable in the very comment that explains it — the first version of this
 * file failed on its own explanation of why `return auth.error` is wrong. */
function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
}

const page = code("app/[locale]/(market)/analytics/product-finder/page.tsx");
const client = code("components/product-finder/ProductFinderClient.tsx");
const form = code("components/product-finder/ProductFinderForm.tsx");
const card = code("components/product-finder/ProductFinderResultCard.tsx");
const evidence = code("components/product-finder/EvidenceList.tsx");
const all = [page, client, form, card, evidence];

// --- the page is gated and redirects (not `return auth.error`) -------------
assert.ok(
	/requireUser\(\[\s*"member",\s*"admin"\s*\]\)/.test(page),
	"the page must gate on member|admin",
);
assert.ok(page.includes("redirect("), "a Page redirects on auth failure");
assert.ok(
	!page.includes("return auth.error"),
	"auth.error is a NextResponse and Next.js rejects it from a Page",
);
console.log("✓ the page is role-gated and redirects rather than returning a response");

// --- the client posts to exactly one endpoint ------------------------------
{
	const endpoints = [...client.matchAll(/fetch\(\s*["'`]([^"'`]+)/g)].map((m) => m[1]);
	assert.deepEqual(endpoints, ["/api/product-finder"], "the client calls one endpoint only");
	assert.ok(client.includes("errors.supplementRequired"), "a 409 gets its own message");
	assert.ok(client.includes("res.status === 409"), "a refusal is distinguished from a failure");
}
console.log("✓ the client posts only to /api/product-finder and surfaces a 409 distinctly");

// --- the form declares stored_only -----------------------------------------
assert.ok(form.includes('mode: "stored_only"'), "the form sends the stored-only mode explicitly");
// Number("") is 0, which would become a price filter the operator never typed.
assert.ok(!/\bNumber\(\s*price/.test(form), "a blank price field must not coerce to 0");
assert.ok(form.includes("optionalNumber"), "blank numeric fields stay undefined");
console.log("✓ the form declares stored_only and leaves blank numbers blank");

// --- nothing anywhere reaches the legacy or external paths -----------------
for (const src of all) {
	for (const forbidden of ["/api/recommend", "/api/analyze", "@/lib/brave", "@/lib/rakuten"]) {
		assert.ok(!src.includes(forbidden), `no finder component may reference ${forbidden}`);
	}
}
console.log("✓ no component references the legacy recommend route or a search provider");

// --- every axis is rendered -------------------------------------------------
// A card that silently omits an axis it has no data for tells the operator the
// axis was irrelevant rather than unmeasured.
assert.ok(card.includes("<EvidenceList"), "the card renders the axis list");
assert.ok(evidence.includes("axes.map("), "every axis is rendered, including unknown ones");
for (const key of AXIS_KEYS) {
	assert.ok(
		evidence.includes("axis.${axis.key}") || evidence.includes("`axis.${axis.key}`"),
		`axis labels must come from the message namespace (${key})`,
	);
}
console.log("✓ all five axes render, including the ones with no data");

// --- unknown is shown as unknown -------------------------------------------
assert.ok(card.includes("result.profitUnknown"), "unknown profit has its own copy");
assert.ok(
	card.includes("expectedContributionProfitJpy === null"),
	"unknown profit is detected as null, not as falsy — 0 is a real profit",
);
assert.ok(card.includes("result.missing"), "missing data is rendered, not dropped");
assert.ok(card.includes("confidence.coverage"), "coverage is shown beside the confidence level");
// An empty bar reads as "measured, and low".
assert.ok(evidence.includes('"—"') || evidence.includes("—"), "an unmeasured axis shows a dash");
console.log("✓ unknown profit, missing data and coverage are all shown explicitly");

// --- the screenplay affordance is real, and deliberate ---------------------
// It was inert until the grounded-screenplay workflow existed to receive it.
// Now it posts the canonical product id, so the script it produces is built
// from the same evidence the recommendation was.
assert.ok(card.includes('fetch("/api/screenplays"'), "the screenplay button posts a real request");
assert.ok(
	card.includes("canonicalProductId: item.canonicalProductId"),
	"and sends the canonical product, which is what the fact pack is read against",
);
assert.equal(
	card.includes("actions.screenplayDisabled"),
	false,
	"the disabled explanation is gone now that the action works",
);
// A recommendation being produced is not a decision to build a broadcast.
assert.equal(
	/useEffect\([^)]*createScreenplay/.test(card),
	false,
	"creating a screenplay must stay a click, never automatic",
);
console.log("✓ the screenplay action posts the canonical product on a click");

// --- navigation --------------------------------------------------------------
{
	const nav = code("lib/nav/groups.ts");
	assert.ok(nav.includes("/analytics/product-finder"), "the finder is in the nav");
	assert.ok(
		/nav\.market\.productFinder[\s\S]{0,160}roles: \['admin', 'member'\]/.test(nav),
		"the finder is member|admin only — a viewer cannot read the evidence behind it",
	);
	assert.ok(
		nav.includes("'/analytics/product-finder'"),
		"the path is registered as an active-matching prefix",
	);
}
console.log("✓ navigation exposes the finder to member and admin only");

// --- locale parity ----------------------------------------------------------
{
	const ja = JSON.parse(readFileSync("messages/ja.json", "utf8"));
	const ko = JSON.parse(readFileSync("messages/ko.json", "utf8"));
	assert.ok(ja.productFinder && ko.productFinder, "both locales carry the namespace");
	const flatten = (o: Record<string, unknown>, p = ""): string[] =>
		Object.entries(o).flatMap(([k, v]) =>
			v !== null && typeof v === "object"
				? flatten(v as Record<string, unknown>, `${p}${k}.`)
				: [`${p}${k}`],
		);
	assert.deepEqual(
		flatten(ja.productFinder).sort(),
		flatten(ko.productFinder).sort(),
		"the two locales must define the same keys",
	);
	for (const key of AXIS_KEYS) {
		assert.ok(ja.productFinder.axis[key], `ja is missing axis label ${key}`);
		assert.ok(ko.productFinder.axis[key], `ko is missing axis label ${key}`);
	}
}
console.log("✓ ja and ko define the same productFinder keys, including every axis");

console.log("PASS: product finder view");
