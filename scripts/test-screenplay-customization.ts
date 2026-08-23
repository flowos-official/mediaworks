import assert from "node:assert/strict";
import {
	sanitizeScreenplayCustomization,
	sanitizeScreenplayOffer,
} from "../lib/screenplay/customization";

const normalized = sanitizeScreenplayCustomization({
	runtimeMinutes: 999,
	targetAudience: "  60代以上   の視聴者  ",
	keyMessage: "毎日の負担を軽くする",
	mustDemos: ["片手で扱う", "", 3, "収納する"],
	mustAvoid: ["効果を断定しない"],
	tonalAdjust: "calm",
	extraSpeakers: [
		{ role: "[佐藤]", description: "メーカー担当者" },
		{ role: "", description: "無効" },
	],
});

assert.equal(normalized?.runtimeMinutes, 120);
assert.equal(normalized?.targetAudience, "60代以上 の視聴者");
assert.equal(normalized?.keyMessage, "毎日の負担を軽くする");
assert.deepEqual(normalized?.mustDemos, ["片手で扱う", "収納する"]);
assert.deepEqual(normalized?.mustAvoid, ["効果を断定しない"]);
assert.equal(normalized?.tonalAdjust, "calm");
assert.deepEqual(normalized?.extraSpeakers, [{ role: "佐藤", description: "メーカー担当者" }]);

assert.equal(sanitizeScreenplayCustomization(null), undefined);
assert.equal(sanitizeScreenplayCustomization({ tonalAdjust: "invalid" }), undefined);
assert.equal(sanitizeScreenplayCustomization({ runtimeMinutes: -10 })?.runtimeMinutes, 1);

assert.deepEqual(
	sanitizeScreenplayOffer({
		price: { listJpy: 19800.9, saleJpy: 14800, shippingJpy: -1 },
		bonuses: ["替えフィルター", ""],
		guarantee: "  30日保証  ",
	}),
	{
		price: { listJpy: 19800, saleJpy: 14800 },
		bonuses: ["替えフィルター"],
		guarantee: "30日保証",
	},
);

console.log("PASS: screenplay customization normalization");
