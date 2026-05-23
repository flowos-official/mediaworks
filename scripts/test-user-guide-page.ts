import { getGuideContent } from "@/lib/user-guide/content";
import { isViewerAllowedPath } from "@/lib/auth/route-permissions";
import koMessages from "@/messages/ko.json";
import jaMessages from "@/messages/ja.json";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertSection(sections: ReturnType<typeof getGuideContent>["sections"], title: string) {
	assert(
		sections.some((section) => section.title === title),
		`missing guide section: ${title}`,
	);
}

assert((koMessages as { nav?: { guide?: string } }).nav?.guide === "사용 가이드", "missing Korean guide nav label");
assert((jaMessages as { nav?: { guide?: string } }).nav?.guide === "利用ガイド", "missing Japanese guide nav label");
assert(isViewerAllowedPath("/ko/guide"), "Korean guide should be visible to viewer users");
assert(isViewerAllowedPath("/guide"), "Default-locale guide should be visible to viewer users");

const ko = getGuideContent("ko");
const ja = getGuideContent("ja");

assert(ko.sections.length >= 8, "Korean guide should cover the main user workflows");
assert(ko.workflows.length >= 4, "Korean guide should include role/workflow quick paths");
assert(ja.sections.length >= 8, "Japanese guide should cover the main user workflows");
assert(ja.workflows.length >= 4, "Japanese guide should include role/workflow quick paths");

assertSection(ko.sections, "매일 확인할 화면");
assertSection(ko.sections, "신규 상품 발굴");
assertSection(ko.sections, "MD 전략과 상품 추천");
assertSection(ko.sections, "방송 대본 제작");
assertSection(ko.sections, "문제가 보일 때");
assertSection(ja.sections, "毎日確認する画面");
assertSection(ja.sections, "新規商品発掘");
assertSection(ja.sections, "MD戦略と商品推薦");
assertSection(ja.sections, "番組台本制作");
assertSection(ja.sections, "問題が見えたとき");

assert(ko.heroTitle === "推薦システムを業務で使う方法" ? false : true, "Korean guide should not use Japanese hero title");
assert(ja.heroTitle === "推薦システムを業務で使う方法", "Japanese guide should use Japanese hero title");
assert(!ja.sections.some((section) => /신규|상품|가이드|확인/.test(section.title)), "Japanese guide should not expose Korean section titles");

for (const content of [ko, ja]) {
	for (const section of content.sections) {
		assert(section.items.length > 0, `${section.title} has no items`);
		for (const item of section.items) {
			assert(item.title.trim().length > 0, `${section.title} has an item without title`);
			assert(item.body.trim().length > 0, `${section.title} / ${item.title} has no body`);
			assert(!/npm|npx|CLI|\.env|localhost|tsx|cron|API/i.test(item.body), `${section.title} / ${item.title} contains developer wording`);
		}
	}
}

console.log("user guide page content checks passed");
