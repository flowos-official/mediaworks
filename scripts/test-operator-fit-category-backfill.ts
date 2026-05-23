import assert from "node:assert/strict";
import {
	pickCategoryFromBroadcastRows,
	type BroadcastCategoryCandidate,
} from "../lib/competitor-fit/category-backfill";

const rows: BroadcastCategoryCandidate[] = [
	{ category: null },
	{ category: "家電" },
	{ category: "家電" },
	{ category: "コスメ" },
	{ category: "" },
];

assert.equal(pickCategoryFromBroadcastRows(rows), "家電");
assert.equal(pickCategoryFromBroadcastRows([{ category: "" }, { category: null }]), null);
assert.equal(
	pickCategoryFromBroadcastRows([
		{ category: "コスメ" },
		{ category: "家電" },
		{ category: "家電" },
	]),
	"家電",
);

console.log("PASS: operator fit category backfill helpers");
