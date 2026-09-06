/**
 * 楽天ショッピングチャンネル archive parser, against a real captured page.
 *
 * The fixture is the live page as of 2026-09-06. Two things about this channel
 * make it different from the other OA parsers, and both are asserted here:
 *
 *   Only the ARCHIVE is server-rendered. The upcoming-schedule block on the
 *   same page is a JS template with every field empty, so a parser that tried
 *   to read it would emit rows with blank names. Nothing empty may survive.
 *
 *   Rakuten airs once a month, on the 18th. A parser that silently started
 *   returning one date, or the crawl date instead of the broadcast date, would
 *   look like it was working — so the dates are asserted explicitly.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseJapaneseDate, parseRakutenLive } from "../lib/historical-crawl/parsers/rakutenlive";

const html = readFileSync("scripts/fixtures/historical-crawl/rakutenlive.html", "utf8");
const rows = parseRakutenLive(html);

// --- the archive is read, and only the archive ------------------------------
{
	assert.ok(rows.length >= 30, `expected the full archive window, got ${rows.length}`);
	for (const row of rows) {
		assert.equal(row.channel, "rakutenlive");
		assert.ok(row.product_name.trim().length > 0, "a blank name means the JS template leaked in");
		assert.match(row.air_date, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(row.source_sheet, "live-crawl:rakutenlive");
		// The offer lives inside the stream; there is no price on the card.
		assert.equal(row.price_jpy, null, "a price must not be invented");
		assert.equal(row.price_text, null);
		// Start times exist only in the JS-filled block we deliberately skip.
		assert.equal(row.start_time, null);
	}
}
console.log(`✓ ${rows.length} archive rows, none of them empty template shells`);

// --- monthly cadence, dated from the card and not from the crawl ------------
{
	const dates = [...new Set(rows.map((r) => r.air_date))].sort();
	assert.deepEqual(
		dates,
		["2026-06-18", "2026-07-18", "2026-08-18"],
		"Rakuten airs monthly on the 18th; a single date would mean the crawl date leaked in",
	);
	for (const date of dates) {
		const count = rows.filter((r) => r.air_date === date).length;
		assert.ok(count >= 10, `${date} should carry a full event, got ${count}`);
	}
	// day_of_week must agree with the date rather than being decorative.
	const aug = rows.find((r) => r.air_date === "2026-08-18");
	assert.equal(aug?.day_of_week, "火", "2026-08-18 is a Tuesday");
}
console.log("✓ three monthly events, each dated from its own card");

// --- one broadcast, one row -------------------------------------------------
// The same item appears in both the top slider and the archive list.
{
	const keys = rows.map((r) => `${r.air_date} ${r.product_name}`);
	assert.equal(new Set(keys).size, keys.length, "the slider and the archive list must not double-count");
}
console.log("✓ items appearing in both the slider and the list are counted once");

// --- provenance -------------------------------------------------------------
{
	const withSource = rows.filter((r) => r.source_url?.includes("liveId="));
	assert.ok(
		withSource.length >= rows.length * 0.9,
		`most rows should carry their liveId link, got ${withSource.length}/${rows.length}`,
	);
	const withImage = rows.filter((r) => r.image_url);
	assert.ok(withImage.length >= rows.length * 0.9, "the card thumbnail should survive");
}
console.log("✓ rows carry their source link and thumbnail");

// --- date parsing -----------------------------------------------------------
{
	assert.equal(parseJapaneseDate("2026年8月18日(火)"), "2026-08-18");
	assert.equal(parseJapaneseDate("2026年8月18日"), "2026-08-18");
	assert.equal(parseJapaneseDate("２０２６年８月１８日"), "2026-08-18", "full-width digits are digits");
	assert.equal(parseJapaneseDate("2026年12月31日"), "2026-12-31");
	// A date that does not exist is not a date, and an undated card is not a
	// broadcast we can place — neither may become "today".
	assert.equal(parseJapaneseDate("2026年2月31日"), null);
	assert.equal(parseJapaneseDate("2026年13月1日"), null);
	assert.equal(parseJapaneseDate("近日公開"), null);
	assert.equal(parseJapaneseDate(""), null);
}
console.log("✓ an unparseable or impossible date yields null, never a fallback");

console.log("PASS: rakutenlive parser");
