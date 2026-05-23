import { screenplayRunPath } from "../components/products/GenerateScreenplayButton";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

assert(
	screenplayRunPath("ja", "screenplay-1", "run-1") === "/screenplays/screenplay-1?run=run-1",
	"builds default-locale screenplay run path",
);

assert(
	screenplayRunPath("ko", "screenplay-2", "run-2") === "/ko/screenplays/screenplay-2?run=run-2",
	"preserves provided locale",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: generate screenplay button helpers");
