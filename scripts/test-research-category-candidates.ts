import { __test } from "../lib/research/competitor-context";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

const candidates = __test.uniqueCategoryCandidates("美容・コスメ", [
	"コスメ",
	"美容・コスメ",
	"ヘルスケア",
	"",
]);

assert(
	JSON.stringify(candidates) === JSON.stringify(["美容・コスメ", "コスメ", "ヘルスケア"]),
	"keeps raw category first and dedupes normalized categories",
);

assert(
	JSON.stringify(__test.uniqueCategoryCandidates(null, ["家電"])) === JSON.stringify(["家電"]),
	"accepts normalized categories without raw input",
);

assert(
	__test.uniqueCategoryCandidates("   ", []).length === 0,
	"returns empty for blank input",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: research category candidate helpers");
