import { __test } from "../lib/screenplay/compliance/check";
const { buildDisplayBlock } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

assert(buildDisplayBlock(undefined) === "", "no display → empty block");
assert(buildDisplayBlock({}) === "", "empty display → empty block");

const b = buildDisplayBlock({ telop: "シミが消える", priceShown: "特別価格 9,800円", requiredNotice: "定期便は3回継続" });
assert(b.includes("シミが消える"), "telop text rendered");
assert(b.includes("9,800円"), "price shown rendered");
assert(b.includes("定期便は3回継続"), "required notice rendered");
assert(b.startsWith("【画面表示"), "block has the 画面表示 header");
