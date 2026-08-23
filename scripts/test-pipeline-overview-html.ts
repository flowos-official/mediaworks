import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { chromium } from "playwright";

async function main() {
	const overviewPath = path.join(process.cwd(), "docs", "pipeline-overview-ko.html");

	let html = "";
	try {
		html = await readFile(overviewPath, "utf8");
	} catch {
		assert.fail("설명용 파이프라인 HTML 파일이 있어야 합니다.");
	}

	const $ = load(html);

	assert.equal($("html").attr("lang"), "ko", "문서 언어가 한국어로 선언되어야 합니다.");
	assert.equal($("meta[name='viewport']").length, 1, "노트북과 회의실 화면을 위한 viewport 설정이 필요합니다.");
	assert.equal($("main[aria-labelledby]").length, 1, "설명 흐름을 감싸는 접근 가능한 main 영역이 필요합니다.");

	const localeButtons = $("[data-locale]").toArray().map((element) => $(element).attr("data-locale"));
	assert.deepEqual(localeButtons, ["ko", "ja"], "한국어와 일본어를 선택하는 두 개의 언어 버튼이 필요합니다.");

	assert.equal($("[data-system-map]").length, 1, "설명 전체가 한 장의 기업 데이터 시스템 맵이어야 합니다.");
	assert.equal($("[data-slide]").length, 0, "여러 장의 슬라이드가 아닌 한 페이지여야 합니다.");

	const zones = $("[data-zone]").toArray().map((element) => $(element).attr("data-zone"));
	assert.deepEqual(zones, ["sources", "engine", "applications"], "데이터 원천 → 기업 데이터 엔진 → 활용 영역으로 읽혀야 합니다.");

	const sources = $("[data-source]").toArray().map((element) => $(element).attr("data-source"));
	assert.deepEqual(
		sources,
		["product-offer", "broadcast-schedule", "media-archive", "channel-category"],
		"수집하는 네 가지 데이터 원천이 모두 보여야 합니다.",
	);

	const featureFlow = $("[data-status='current'][data-feature]").toArray().map((element) => $(element).attr("data-feature"));
	assert.deepEqual(
		featureFlow,
		["broadcast-calendar", "discovery", "selection-pipeline", "research-strategy", "screenplay"],
		"데이터가 현재 연결되는 다섯 가지 실제 기능을 모두 보여야 합니다.",
	);

	const futureApplications = $("[data-status='planned'][data-application]").toArray().map((element) => $(element).attr("data-application"));
	assert.deepEqual(
		futureApplications,
		["competitive-script", "demo-direction", "channel-recommendation"],
		"축적된 데이터로 확장할 세 가지 미래 활용을 보여야 합니다.",
	);

	assert.equal($("[data-feedback-loop]").length, 1, "업무 결과가 데이터 엔진으로 되돌아오는 학습 순환을 보여야 합니다.");
	const cycleSteps = $("[data-cycle-step]").toArray().map((element) => $(element).attr("data-cycle-step"));
	assert.deepEqual(
		cycleSteps,
		["work", "judge", "improve", "revalidate"],
		"현업 사용 → 정답 판정 → 검수 반영 → 동일 조건 재검증이 하나의 운영 사이클로 보여야 합니다.",
	);
	assert.equal($("[data-cycle-reason]").length, 1, "자동학습이 아니라 검수·재검증이 필요한 이유를 설명해야 합니다.");

	assert.ok($("[data-status='current']").length > 0, "현재 운영 항목을 구분해야 합니다.");
	assert.ok($("[data-status='planned']").length > 0, "확장 예정 항목을 구분해야 합니다.");
	assert.equal(
		$("[data-role='takeaway'][data-concept='enterprise-data-operating-system']").length,
		1,
		"단순 플로우가 아니라 기업 데이터 운영 시스템이라는 결론이 필요합니다.",
	);
	assert.equal($("[data-outcome-line]").length, 1, "운영 사이클이 앞으로 더 나은 결과로 이어지는 이유를 한 문장으로 보여야 합니다.");

	const externalAssets = $("script[src], link[rel='stylesheet'], img[src^='http']");
	assert.equal(externalAssets.length, 0, "인터넷 연결 없이 열 수 있는 단일 HTML이어야 합니다.");

	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
		await page.goto(pathToFileURL(overviewPath).href);
		await page.evaluate(() => localStorage.clear());
		await page.reload();
		const readPresentationFontSizes = () => page.evaluate(() => {
			const selectors = {
				hero: ".hero-copy",
				eyebrow: ".eyebrow",
				localeButton: ".locale-button",
				status: ".status",
				zoneNote: ".zone-note",
				connector: ".connector span",
				sourceTitle: ".source-title h3",
				sourceFields: ".source-fields",
				sourceDescription: "[data-source] p",
				engineSummary: ".engine-summary",
				engineLabel: ".engine-label",
				engineProcess: ".engine-process span",
				asset: ".asset",
				engineRule: ".engine-rule",
				applicationTitle: "[data-feature] strong",
				applicationDescription: "[data-feature] span",
				feedbackReason: ".feedback-title p",
				cycleTitle: "[data-cycle-step] strong",
				cycleDescription: "[data-cycle-step] span:last-child",
				cycleNumber: ".cycle-number",
				feedbackResult: ".feedback-result",
			};
			return Object.fromEntries(
				Object.entries(selectors).map(([key, selector]) => [key, Number.parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize)]),
			);
		});

		assert.equal(await page.locator("html").getAttribute("lang"), "ko", "첫 화면은 한국어여야 합니다.");
		assert.equal(await page.locator("[data-locale='ko']").getAttribute("aria-pressed"), "true", "한국어 버튼이 선택 상태여야 합니다.");
		const koreanFontSizes = await readPresentationFontSizes();

		await page.locator("[data-locale='ja']").click();
		assert.equal(await page.locator("html").getAttribute("lang"), "ja", "일본어 버튼을 누르면 문서 언어가 일본어로 바뀌어야 합니다.");
		assert.equal(
			(await page.locator("h1").innerText()).replaceAll("\n", ""),
			"散在するデータをつなぎ、次のアクションを進化させる",
			"핵심 제목이 일본어로 전환되어야 합니다.",
		);
		assert.match(await page.locator("[data-role='takeaway']").innerText(), /単なる業務フローではありません/, "결론 문장도 일본어로 전환되어야 합니다.");
		const japaneseOutcome = await page.locator("[data-outcome-line]").innerText();
		assert.ok(/[ぁ-んァ-ヶ一-龠]/.test(japaneseOutcome) && !/[가-힣]/.test(japaneseOutcome), "더 나은 결과에 관한 문장도 일본어로 전환되어야 합니다.");
		assert.match(
			await page.locator("[data-cycle-reason]").innerText(),
			/使うだけで自動的に改善されるわけではありません/,
			"운영 사이클이 필요한 이유도 일본어로 전환되어야 합니다.",
		);
		const japaneseCycleSteps = await page.locator("[data-cycle-step]").allInnerTexts();
		assert.equal(japaneseCycleSteps.length, 4, "운영 사이클의 네 단계가 유지되어야 합니다.");
		assert.ok(
			japaneseCycleSteps.every((text) => /[ぁ-んァ-ヶ一-龠]/.test(text) && !/[가-힣]/.test(text)),
			"운영 사이클의 네 단계에 한국어가 남지 않고 일본어로 전환되어야 합니다.",
		);
		assert.equal(await page.locator("[data-locale='ja']").getAttribute("aria-pressed"), "true", "일본어 버튼이 선택 상태여야 합니다.");
		const japaneseFontSizes = await readPresentationFontSizes();
		const minimumJapaneseSizes = {
			hero: 15,
			eyebrow: 11,
			localeButton: 11,
			status: 11,
			zoneNote: 11,
			connector: 11,
			sourceTitle: 13.5,
			sourceFields: 11,
			sourceDescription: 12,
			engineSummary: 12,
			engineLabel: 11,
			engineProcess: 11,
			asset: 12,
			engineRule: 12,
			applicationTitle: 12,
			applicationDescription: 12,
			feedbackReason: 12,
			cycleTitle: 12,
			cycleDescription: 12,
			cycleNumber: 11,
			feedbackResult: 11,
		};
		for (const [key, minimum] of Object.entries(minimumJapaneseSizes)) {
			assert.ok(japaneseFontSizes[key] >= minimum, `일본어 ${key} 글자는 노트북 발표에서 읽을 수 있는 크기여야 합니다.`);
			assert.ok(japaneseFontSizes[key] > koreanFontSizes[key], `일본어 ${key} 글자는 한국어보다 크게 표시되어야 합니다.`);
		}
		const japaneseLayout = await page.evaluate(() => {
			const feedbackTop = document.querySelector("[data-feedback-loop]")!.getBoundingClientRect().top;
			const zoneBottoms = [...document.querySelectorAll("[data-zone]")].map((element) => element.getBoundingClientRect().bottom);
			const overflowingCards = [...document.querySelectorAll(".source-card, .engine, .asset, .app-card, .cycle-step")]
				.filter((element) => element.scrollHeight > element.clientHeight + 1)
				.map((element) => element.className);
			const horizontallyOverflowingAssets = [...document.querySelectorAll(".asset")]
				.filter((element) => element.scrollWidth > element.clientWidth + 1)
				.map((element) => element.textContent?.trim());
			const horizontallyOverflowingCards = [...document.querySelectorAll(".source-card, .app-card, .cycle-step > div")]
				.filter((element) => element.scrollWidth > element.clientWidth + 1)
				.map((element) => element.textContent?.trim());
			const assetListBottom = document.querySelector(".asset-list")!.getBoundingClientRect().bottom;
			const engineRuleTop = document.querySelector(".engine-rule")!.getBoundingClientRect().top;
			const feedbackTitleRight = document.querySelector(".feedback-title")!.scrollWidth
				+ document.querySelector(".feedback-title")!.getBoundingClientRect().left;
			const cycleTrackLeft = document.querySelector(".cycle-track")!.getBoundingClientRect().left;
			return {
				feedbackTop,
				zoneBottoms,
				overflowingCards,
				horizontallyOverflowingAssets,
				horizontallyOverflowingCards,
				assetListBottom,
				engineRuleTop,
				feedbackTitleRight,
				cycleTrackLeft,
			};
		});
		assert.ok(
			japaneseLayout.zoneBottoms.every((bottom) => bottom <= japaneseLayout.feedbackTop),
			"일본어 확대 화면에서 데이터 구역과 운영 사이클이 겹치지 않아야 합니다.",
		);
		assert.deepEqual(japaneseLayout.overflowingCards, [], "일본어 확대 화면의 카드 안쪽 글자가 잘리지 않아야 합니다.");
		assert.deepEqual(japaneseLayout.horizontallyOverflowingAssets, [], "일본어 데이터 자산 이름이 카드 오른쪽으로 빠져나가지 않아야 합니다.");
		assert.deepEqual(japaneseLayout.horizontallyOverflowingCards, [], "일본어 설명 문장이 카드 오른쪽으로 빠져나가지 않아야 합니다.");
		assert.ok(japaneseLayout.assetListBottom <= japaneseLayout.engineRuleTop, "일본어 데이터 자산 목록과 엔진 설명이 겹치지 않아야 합니다.");
		assert.ok(japaneseLayout.feedbackTitleRight <= japaneseLayout.cycleTrackLeft, "일본어 운영 사이클 소개와 첫 단계 카드가 겹치지 않아야 합니다.");

		await page.reload();
		assert.equal(await page.locator("html").getAttribute("lang"), "ja", "새로고침 후에도 선택한 일본어가 유지되어야 합니다.");

		await page.locator("[data-locale='ko']").click();
		assert.equal(await page.locator("html").getAttribute("lang"), "ko", "한국어 버튼을 누르면 문서 언어가 한국어로 돌아와야 합니다.");
		assert.match(await page.locator("h1").innerText(), /흩어진 데이터를 연결해/, "핵심 제목이 한국어로 복원되어야 합니다.");
	} finally {
		await browser.close();
	}

	console.log("PASS: pipeline overview HTML contract");
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
