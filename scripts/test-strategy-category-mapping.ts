import assert from "node:assert/strict";
import {
	buildCategoryMatchTerms,
	mapUiCategoryToSalesCategories,
} from "../lib/strategy/category-mapping";

assert.deepEqual(
	mapUiCategoryToSalesCategories("美容・スキンケア"),
	["美容・運動", "化粧品"],
	"keeps existing UI category mapping",
);

assert.deepEqual(
	mapUiCategoryToSalesCategories("コスメ"),
	["化粧品", "美容・運動"],
	"maps normalized competitor category to internal sales categories",
);

assert.deepEqual(
	mapUiCategoryToSalesCategories("グルメ・お酒"),
	["食品"],
	"maps OA food category to internal sales category",
);

assert.deepEqual(
	buildCategoryMatchTerms(["美容・コスメ", "ビューティ", "コスメ"]),
	["美容・コスメ", "美容", "コスメ", "化粧品", "美容・運動", "ビューティ"],
	"builds deduped match terms across raw labels, tokens, aliases, and sales categories",
);

assert.deepEqual(
	buildCategoryMatchTerms(["家電", "ホーム・キッチン"]),
	["家電", "家電・雑貨", "ホーム・キッチン", "ホーム", "キッチン"],
	"bridges competitor categories to internal sales and token matches",
);

console.log("PASS: strategy category mapping");
