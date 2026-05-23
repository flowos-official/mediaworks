import assert from "node:assert/strict";
import { parseJsonFromModelText } from "../lib/gemini";

assert.deepEqual(
	parseJsonFromModelText<{ ok: boolean }>('```json\n{"ok":true}\n```', "test"),
	{ ok: true },
);

assert.deepEqual(
	parseJsonFromModelText<{ ok: boolean }>('prefix {"ok": true} suffix', "test"),
	{ ok: true },
);

assert.deepEqual(
	parseJsonFromModelText<{ text: string }>('{"text":"brace } inside string"}', "test"),
	{ text: "brace } inside string" },
);

assert.throws(
	() => parseJsonFromModelText("not json", "test"),
	/Failed to parse JSON from test/,
);

console.log("PASS: gemini JSON parser helpers");
