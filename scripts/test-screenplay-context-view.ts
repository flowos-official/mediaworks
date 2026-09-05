/**
 * The provenance UI, checked structurally.
 *
 * The failure this guards against is not a crash — it is a panel that renders
 * an empty, satisfied-looking state for a version that has no provenance at
 * all. A legacy version and a version whose competitor lookup timed out and a
 * version with a fully applied pattern must all look different on screen.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function strip(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const PATTERN_STATUSES = [
	"disabled",
	"no_category",
	"off_whitelist",
	"under_sampled",
	"timed_out",
	"failed",
	"applied",
] as const;

// --- every pattern status has a caption in both locales --------------------
{
	for (const locale of ["ja", "ko"]) {
		const messages = JSON.parse(readFileSync(`messages/${locale}.json`, "utf8")) as Record<string, never>;
		const captions = (messages.screenplay as Record<string, Record<string, string>>).patternStatus;
		for (const status of PATTERN_STATUSES) {
			assert.ok(captions?.[status], `messages/${locale}.json is missing screenplay.patternStatus.${status}`);
		}
		const claims = (messages.screenplay as Record<string, Record<string, string>>).claims;
		for (const status of ["supported", "source_claim", "needs_review"]) {
			assert.ok(
				(claims?.status as unknown as Record<string, string>)?.[status],
				`messages/${locale}.json is missing screenplay.claims.status.${status}`,
			);
		}
	}
}
console.log("✓ every pattern and claim status has a caption in both locales");

// --- provenance renders the negative statuses, not only the positive one ---
{
	const source = strip(readFileSync("components/screenplay/VersionProvenance.tsx", "utf8"));
	for (const status of PATTERN_STATUSES.filter((s) => s !== "applied")) {
		assert.ok(
			source.includes(`"${status}"`),
			`VersionProvenance must be able to render the ${status} pattern state`,
		);
	}
	assert.ok(
		/patternStatus/.test(source),
		"provenance must read the explicit status, not infer absence from a null sample size",
	);
}
console.log("✓ provenance renders every non-applied pattern state");

// --- a legacy version says so instead of inventing an applied state --------
{
	const panel = strip(readFileSync("components/screenplay/GenerationContextPanel.tsx", "utf8"));
	assert.ok(
		/if \(!context\) return <GenerationContextUnavailable/.test(panel),
		"a version with no context must render an explicit unavailable state",
	);
	assert.ok(panel.includes('t("unavailable")'));

	const claims = strip(readFileSync("components/screenplay/ClaimEvidencePanel.tsx", "utf8"));
	assert.ok(
		/hasContext \? t\("none"\) : t\("unavailable"\)/.test(claims),
		'"no claims were detected" and "this version predates grounding" are different facts and must read differently',
	);
}
console.log("✓ a version without provenance says so rather than showing an empty pass");

// --- the navigator exposes each provenance view ---------------------------
{
	const navigator = strip(readFileSync("components/screenplay/ScreenplayNavigator.tsx", "utf8"));
	for (const tab of ["facts", "references", "outline", "demo", "claims"]) {
		assert.ok(
			new RegExp(`id: "${tab}"`).test(navigator),
			`the navigator needs a ${tab} tab`,
		);
	}
	assert.ok(/GenerationContextPanel/.test(navigator));
	assert.ok(/ClaimEvidencePanel/.test(navigator));
	assert.ok(
		/onJumpToLine=\{onJumpToLine\}/.test(navigator),
		"clicking a claim must jump to its line in the script",
	);
}
console.log("✓ the navigator exposes facts, references, outline, demo and claims");

// --- the read API scopes provenance by ownership, not by supplied id -------
{
	const route = strip(readFileSync("app/api/screenplays/[id]/route.ts", "utf8"));
	assert.ok(
		/screenplay_generation_contexts[\s\S]{0,120}\.eq\("screenplay_id", id\)/.test(route),
		"contexts must be scoped through screenplay_id",
	);
	assert.ok(
		/screenplay_claim_links[\s\S]{0,400}\.in\("version_id", versionIds\)/.test(route),
		"claim links must be scoped through this screenplay's version ids",
	);
	assert.ok(
		/generation_context: version\.generation_context_id/.test(route),
		"a version with no context id must return null, not a lookup miss dressed as data",
	);
}
console.log("✓ the read API scopes provenance to the screenplay being read");

// --- the product-finder handoff is real and deliberate --------------------
{
	const card = strip(readFileSync("components/product-finder/ProductFinderResultCard.tsx", "utf8"));
	assert.ok(/canonicalProductId: item\.canonicalProductId/.test(card), "the handoff must send the canonical id");
	assert.ok(/fetch\("\/api\/screenplays"/.test(card));
	assert.equal(
		/disabled\s*$|disabled\n/.test(card.slice(card.indexOf("createScreenplay()"))),
		false,
		"the screenplay button must no longer be inert",
	);
	// A recommendation being produced is not a decision to build a broadcast.
	assert.equal(
		/useEffect\([^)]*createScreenplay/.test(card),
		false,
		"creating a screenplay must be a click, never automatic",
	);
}
console.log("✓ the product-finder handoff posts the canonical product on a click");

console.log("PASS: screenplay context view");
