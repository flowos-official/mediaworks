import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = [
	"components/analytics/MDStrategyPanel.tsx",
	"components/analytics/md-strategy/FinancialProjectionSection.tsx",
];

function responsiveContainerOpenTags(source: string): string[] {
	return source.match(/<ResponsiveContainer\b[^>]*>/g) ?? [];
}

for (const file of files) {
	const source = readFileSync(file, "utf8");
	const tags = responsiveContainerOpenTags(source);
	assert.ok(tags.length > 0, `${file} should contain ResponsiveContainer tags`);
	for (const tag of tags) {
		assert.match(
			tag,
			/\bminWidth=\{0\}/,
			`${file} ResponsiveContainer should set minWidth={0}: ${tag}`,
		);
		assert.match(
			tag,
			/\binitialDimension=\{\{ width: 1, height: 1 \}\}/,
			`${file} ResponsiveContainer should avoid Recharts default -1 initial dimensions: ${tag}`,
		);
	}
}

console.log("PASS: recharts responsive containers declare stable initial dimensions");
