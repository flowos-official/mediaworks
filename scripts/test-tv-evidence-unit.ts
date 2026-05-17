import { __test } from "../lib/discovery/tv-evidence";

const { splitCategoryToKeywords, tokenizeName, percentile } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

// splitCategoryToKeywords
assert(
	JSON.stringify(splitCategoryToKeywords("美容・運動")) === JSON.stringify(["美容", "運動"]),
	'splitCategoryToKeywords("美容・運動") → ["美容","運動"]',
);
assert(
	JSON.stringify(splitCategoryToKeywords("化粧品")) === JSON.stringify(["化粧品"]),
	"single-token category passes through",
);
// "a", "b", "c" are all 1-char tokens and fail the ≥2 filter → []
// Plan had expected ["a","b","c"] but that contradicts length>=2; corrected to [].
// The assertion still verifies that BOTH delimiters (/ and ・) split correctly —
// we just confirm the split happens and short tokens are dropped.
assert(
	JSON.stringify(splitCategoryToKeywords("a/b・c")) === JSON.stringify([]),
	"slash + middle-dot both split (1-char tokens a/b/c all dropped by ≥2 filter → [])",
);
assert(
	splitCategoryToKeywords("").length === 0,
	"empty input → empty array",
);
// "お" (1 codepoint) and "x" (1 char) both fail the ≥2 filter → []
// Plan had expected ["お"] but that contradicts the length>=2 filter; corrected to [].
assert(
	JSON.stringify(splitCategoryToKeywords("お・x")) === JSON.stringify([]),
	"tokens <2 chars filtered — both 'お' (1 codepoint) and 'x' (1 char) dropped → []",
);

// tokenizeName
assert(
	JSON.stringify(tokenizeName("無印良品 美容液 30ml")) === JSON.stringify(["無印良品", "美容液", "30ml"]),
	"tokenizeName splits on whitespace and drops short tokens",
);
assert(
	tokenizeName("a b c").length === 0,
	"all-short tokens → empty",
);
assert(
	tokenizeName("セラム").length === 1 && tokenizeName("セラム")[0] === "セラム",
	"single Japanese token kept",
);

// percentile
assert(percentile([1, 2, 3, 4, 5], 0.5) === 3, "median of [1..5] = 3");
assert(percentile([1, 2, 3, 4], 0.5) === 2.5, "median of [1..4] = 2.5");
assert(percentile([10], 0.5) === 10, "single-element percentile = element");
assert(percentile([], 0.5) === 0, "empty array percentile = 0");

if (process.exitCode === 1) process.exit(1);
console.log("\nAll unit tests passed.");
