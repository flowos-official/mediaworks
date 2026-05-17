import { __test } from "../lib/discovery/category-normalize";

const { parseGeminiResponse, validateAgainstWhitelist } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

// parseGeminiResponse
const valid = '{"results":[{"index":0,"matches":["家電"]},{"index":1,"matches":[]}]}';
const parsedValid = parseGeminiResponse(valid);
assert(parsedValid.length === 2, "parses 2 results");
assert(parsedValid[0].index === 0 && parsedValid[0].matches[0] === "家電", "result[0] correct");
assert(parsedValid[1].matches.length === 0, "result[1] empty matches");

const wrapped = '```json\n{"results":[{"index":0,"matches":["コスメ"]}]}\n```';
const parsedWrapped = parseGeminiResponse(wrapped);
assert(parsedWrapped.length === 1 && parsedWrapped[0].matches[0] === "コスメ", "extracts JSON from markdown fence");

const bogus = "not json at all";
const parsedBogus = parseGeminiResponse(bogus);
assert(parsedBogus.length === 0, "returns [] on unparseable input");

const malformed = '{"results":[{"index":"not a number","matches":["家電"]}]}';
const parsedMalformed = parseGeminiResponse(malformed);
assert(parsedMalformed.length === 0, "rejects non-numeric index");

// validateAgainstWhitelist
const whitelist = new Set(["家電", "コスメ", "ホーム・インテリア"]);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "コスメ"], whitelist)) === JSON.stringify(["家電", "コスメ"]),
	"both valid pass through",
);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "幻覚カテゴリ"], whitelist)) === JSON.stringify(["家電"]),
	"hallucinated category dropped",
);
assert(
	validateAgainstWhitelist([], whitelist).length === 0,
	"empty input returns empty",
);
assert(
	JSON.stringify(validateAgainstWhitelist(["家電", "家電"], whitelist)) === JSON.stringify(["家電"]),
	"duplicates collapsed",
);
assert(
	validateAgainstWhitelist(["家電", "コスメ", "ホーム・インテリア", "家電"], whitelist).length === 3,
	"cap at distinct whitelist length (no spurious cap of 3)",
);

// Task 3 tests — buildPrompt
const { buildPrompt } = __test;

const prompt = buildPrompt(["家電", "コスメ"], ["自動 豆乳 メーカー", "口紅"]);
assert(prompt.includes("家電") && prompt.includes("コスメ"), "prompt includes whitelist");
assert(prompt.includes("[0] 自動 豆乳 メーカー"), "prompt includes input 0");
assert(prompt.includes("[1] 口紅"), "prompt includes input 1");
assert(prompt.includes("results"), "prompt asks for JSON results array");

if (process.exitCode === 1) process.exit(1);
console.log("\nAll unit tests passed.");
