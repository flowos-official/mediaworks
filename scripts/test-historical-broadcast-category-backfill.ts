import assert from "node:assert/strict";
import {
	buildHistoricalCategoryAssignments,
	replaceHistoricalAssignmentRowCounts,
	summarizeHistoricalCategoryBackfill,
} from "../lib/historical-crawl/category-backfill";

const assignments = buildHistoricalCategoryAssignments(
	[
		{ product_name: "セブンフロー グロウセラムファンデーション", row_count: 3 },
		{ product_name: "大容量コンパクトバッテリー", row_count: 2 },
		{ product_name: "分類不能商品", row_count: 4 },
		{ product_name: "   ", row_count: 1 },
	],
	new Map<string, string[]>([
		["セブンフロー グロウセラムファンデーション", ["コスメ", "ビューティ"]],
		["大容量コンパクトバッテリー", ["家電"]],
		["分類不能商品", []],
	]),
);

assert.deepEqual(assignments, [
	{
		productName: "セブンフロー グロウセラムファンデーション",
		category: "コスメ",
		rowCount: 3,
		alternatives: ["ビューティ"],
	},
	{
		productName: "大容量コンパクトバッテリー",
		category: "家電",
		rowCount: 2,
		alternatives: [],
	},
]);

const exactCountAssignments = replaceHistoricalAssignmentRowCounts(assignments, new Map([
	["セブンフロー グロウセラムファンデーション", 9],
	["大容量コンパクトバッテリー", 7],
]));

assert.deepEqual(exactCountAssignments, [
	{
		productName: "セブンフロー グロウセラムファンデーション",
		category: "コスメ",
		rowCount: 9,
		alternatives: ["ビューティ"],
	},
	{
		productName: "大容量コンパクトバッテリー",
		category: "家電",
		rowCount: 7,
		alternatives: [],
	},
]);

const summary = summarizeHistoricalCategoryBackfill({
	distinctProductNames: 4,
	assignments,
	updatedRows: 5,
	apply: true,
});

assert.deepEqual(summary, {
	distinctProductNames: 4,
	assignableProductNames: 2,
	skippedProductNames: 2,
	plannedRows: 5,
	updatedRows: 5,
	apply: true,
});

console.log("PASS: historical broadcast category backfill helpers");
