import assert from "node:assert/strict";
import ja from "../messages/ja.json";
import ko from "../messages/ko.json";
import {
	STRATEGY_SUB_TABS,
	getStrategyActiveTab,
} from "../lib/nav/strategy-subtabs";

assert.deepEqual(
	STRATEGY_SUB_TABS.map((tab) => [tab.key, tab.href, tab.labelKey]),
	[
		["expansion", "/analytics/strategy/expansion", "strategyTabs.expansion"],
		["live", "/analytics/strategy/live", "strategyTabs.live"],
		["status", "/analytics/strategy/status", "strategyTabs.status"],
	],
);

assert.equal(getStrategyActiveTab("/ja/analytics/strategy/status"), "status");
assert.equal(getStrategyActiveTab("/ko/analytics/strategy/live"), "live");
assert.equal(getStrategyActiveTab("/analytics/strategy/expansion"), "expansion");
assert.equal(getStrategyActiveTab("/analytics/strategy"), "expansion");

assert.equal(ja.nav.strategyTabs.expansion, "拡大戦略");
assert.equal(ja.nav.strategyTabs.live, "ライブコマース戦略");
assert.equal(ja.nav.strategyTabs.status, "連携状態");
assert.equal(ko.nav.strategyTabs.expansion, "확장 전략");
assert.equal(ko.nav.strategyTabs.live, "라이브 커머스 전략");
assert.equal(ko.nav.strategyTabs.status, "연결 상태");

console.log("PASS: strategy sub tabs i18n");
