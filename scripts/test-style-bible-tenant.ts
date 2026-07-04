import { __test } from "../lib/screenplay/prompt";
const { loadStyleBible } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	const def = await loadStyleBible();               // default → falls back to style-bible.json
	assert(typeof def === "string" && def.length > 0, "default tenant loads the base style-bible");

	const missing = await loadStyleBible("__no_such_tenant__");
	assert(missing === def, "missing tenant file falls back to base style-bible");
}
main();
