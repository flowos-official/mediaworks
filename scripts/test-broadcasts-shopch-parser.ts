import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scrapeShopChannelFromHTML } from "../lib/broadcasts/shopch";

const FIXTURE_DIR = join(process.cwd(), "scripts/fixtures/broadcasts");

interface Expected {
	minSlots: number;
	maxSlots: number;
	minPresenterCoverage: number;
	minDescriptionCoverage: number;
	minThumbnailCoverage: number;
	firstSlot: {
		channel: string;
		startTimePattern: string;
		programTitleMinLength: number;
	};
}

function loadFixturePairs(): Array<{ html: string; expected: Expected; date: string }> {
	const files = readdirSync(FIXTURE_DIR);
	const htmlFiles = files.filter((f) => f.startsWith("shopch-") && f.endsWith(".html"));
	return htmlFiles.map((html) => {
		const base = html.replace(".html", "");
		const date = base.replace("shopch-", "");
		const expected = JSON.parse(
			readFileSync(join(FIXTURE_DIR, `${base}.expected.json`), "utf-8"),
		) as Expected;
		return {
			html: readFileSync(join(FIXTURE_DIR, html), "utf-8"),
			expected,
			date,
		};
	});
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`✗ ${msg}`);
		process.exitCode = 1;
	} else {
		console.log(`✓ ${msg}`);
	}
}

async function main() {
	const pairs = loadFixturePairs();
	if (pairs.length === 0) {
		console.error("No shopch fixtures found in", FIXTURE_DIR);
		process.exit(1);
	}

	for (const { html, expected, date } of pairs) {
		console.log(`\n=== shopch-${date} ===`);
		const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
		const slots = scrapeShopChannelFromHTML(html, iso);

		assert(
			slots.length >= expected.minSlots && slots.length <= expected.maxSlots,
			`slot count ${slots.length} within [${expected.minSlots}, ${expected.maxSlots}]`,
		);

		if (slots.length > 0) {
			const first = slots[0];
			assert(first.channel === expected.firstSlot.channel, "first slot channel");
			assert(
				new RegExp(expected.firstSlot.startTimePattern).test(first.start_time),
				`first slot start_time matches ${expected.firstSlot.startTimePattern}`,
			);
			assert(
				first.program_title.length >= expected.firstSlot.programTitleMinLength,
				`first slot program_title length ≥ ${expected.firstSlot.programTitleMinLength}`,
			);
			assert(
				typeof first.source_url === "string" && first.source_url.startsWith("https://"),
				"first slot source_url is https",
			);

			const cov = (key: "presenter" | "description" | "thumbnail_url") =>
				slots.filter((s) => s[key] != null && s[key] !== "").length / slots.length;
			assert(cov("presenter") >= expected.minPresenterCoverage,
				`presenter coverage ${cov("presenter").toFixed(2)} ≥ ${expected.minPresenterCoverage}`);
			assert(cov("description") >= expected.minDescriptionCoverage,
				`description coverage ${cov("description").toFixed(2)} ≥ ${expected.minDescriptionCoverage}`);
			assert(cov("thumbnail_url") >= expected.minThumbnailCoverage,
				`thumbnail coverage ${cov("thumbnail_url").toFixed(2)} ≥ ${expected.minThumbnailCoverage}`);

			const times = slots.map((s) => s.start_time);
			const sorted = [...times].sort();
			assert(JSON.stringify(times) === JSON.stringify(sorted),
				"slots are sorted by start_time");
		}
	}

	if (process.exitCode) {
		console.error("\nSome assertions failed.");
		process.exit(process.exitCode);
	}
	console.log("\nAll shopch parser assertions passed.");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
