# Recommendation System Completion Audit

작성 기준일: 2026-05-23

이 문서는 "기존 내부 홈쇼핑 상품/매출 데이터"와 "현재 경쟁 홈쇼핑/방송 데이터"를 함께 사용해 신상품을 추천하고, 판매 방법까지 연결되는 전체 시스템이 현재 기준으로 충족되는지 감사한 결과다.

## 감사 기준

원래 목표를 다음 요구사항으로 분해했다.

1. 현재 기능을 명확히 파악할 수 있어야 한다.
2. 내부 상품/매출 데이터와 경쟁 방송/상품 데이터가 추천 근거로 함께 쓰여야 한다.
3. Discovery 후보가 Research 상품으로 승격되고, Research 결과와 방송 대본까지 연결되어야 한다.
4. MD Strategy가 내부 실적과 외부 후보를 함께 사용해 "무엇을 팔지"와 "어떻게 팔지"를 제안해야 한다.
5. 운영자가 전체 흐름의 준비 상태와 데이터 근거 품질을 한 곳에서 확인할 수 있어야 한다.
6. 위 상태가 현재 코드/DB/화면에서 검증 가능해야 한다.

## 요구사항별 현재 증거

| 요구사항 | 현재 증거 | 판정 |
| --- | --- | --- |
| 기능 파악 | `docs/current-system-feature-map.md`가 인증, 내부 분석, Research, 방송 캘린더, Discovery, C package, Research promotion, MD Strategy, Live Commerce, Screenplay를 기능/데이터/API/UI 기준으로 정리한다. | 충족 |
| 내부+경쟁 데이터 결합 | MD Strategy smoke가 내부 실적 8개와 Discovery pool 외부 후보 20개를 포함한 전략을 검증한다. Research competitor context는 raw category와 normalized category 후보를 함께 조회한다. | 충족 |
| Discovery -> Research | `products.discovered_product_id` 기반 승격 서비스, API, CLI가 있으며 strict smoke가 승격 상품과 Research result 존재를 확인한다. | 충족 |
| Research -> Screenplay | `/api/screenplays`가 `productId` 입력을 받고, Research 상품 상세의 생성 버튼과 `screenplays.product_id` 연결이 있다. Strict smoke가 product-linked ready screenplay를 확인한다. | 충족 |
| 판매 방법 제안 | MD Strategy는 내부 실적, Discovery pool, Research pool, fresh search를 사용하고, 전략 상세는 내부/외부 evidence와 TV/OA 신호를 표시한다. Live Commerce Strategy와 Screenplay가 실행물 축을 보완한다. | 충족 |
| 운영 상태 확인 | `/api/recommendation-flow/status`, `/analytics/strategy/status`, `/ko/analytics/strategy/status`가 strict readiness와 category/broadcast/operator-fit coverage를 표시한다. | 충족 |
| 데이터 품질 | Discovery raw category 428/428, normalization cache rows 1330, 방송 카테고리 coverage 23.7%, operator fit category 2/2가 strict smoke와 화면에서 확인된다. | 충족 |
| 운영 문서 | `README.md`, `.env.example`, `docs/user-guide-jp.md`, `docs/current-system-feature-map.md`가 env, cron, 운영 명령, smoke gate, 장애 확인 절차를 설명한다. | 충족 |

## 현재 검증된 대표 경로

- Discovery 후보: `3a3a8438-9afd-4f1a-a5bb-d1e91d340df3`
- 승격 Research 상품: `89af86a0-ff55-48cc-9ed9-506f9d0e6b7e`
- 내부 실적+Discovery pool 외부 후보 통합 MD Strategy: `2b051561-e464-4f7f-a350-b663a16f85b3`
- 연결 screenplay: `cfc6f41f-f32f-434e-8199-957565a5a8e0` (`ready`)

## 남은 후속 개선

아래 항목은 현재 목표 완료를 막는 공백은 아니지만, 이후 품질을 더 높이는 작업이다.

- DB 레벨 normalized category 컬럼/alias를 `broadcasts`, `historical_broadcasts`, `products`, `product_summaries`에 더 일관되게 확장한다.
- `npm run lint`의 기존 warning 29개를 정리한다.
- 운영자 문서에 실제 화면 캡처나 역할별 장애 대응 예시를 추가한다.

## 완료 판정

현재 기준으로 원래 목표였던 "현재 기능 파악"과 "내부/경쟁 데이터 기반 추천부터 판매 실행물까지의 전체 시스템 연결"은 코드, DB, CLI smoke, status UI, 운영 문서로 검증 가능하다.
