import { __test } from "../lib/screenplay/compliance/check";
const { describeLegalAxis } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

assert(describeLegalAxis(["yakkiho", "keihyo", "kenzo"]) === "薬機法・景表法・健康増進法", "maps the three legacy laws");
assert(describeLegalAxis(["shokuhin", "tokushoho"]) === "食品表示法・特商法", "maps food-axis laws");
assert(describeLegalAxis(["keihyo", "keihyo"]) === "景表法", "dedupes");
assert(describeLegalAxis(["unknown_x"]) === "関連法規", "unknown-only falls back");
assert(describeLegalAxis([]) === "関連法規", "empty falls back");
