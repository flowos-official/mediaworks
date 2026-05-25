-- 2026-05-25: research_results — 확장 5섹션을 raw_json에서 분리.
-- 사전 점검(plan §사전 운영 절차)이 통과한 뒤 적용한다.

BEGIN;

-- 1) 확장 5섹션을 별도 jsonb 컬럼으로 분리.
ALTER TABLE research_results
  ADD COLUMN distribution_channels jsonb,
  ADD COLUMN pricing_strategy      jsonb,
  ADD COLUMN marketing_strategy    jsonb,
  ADD COLUMN korea_market_fit      jsonb,
  ADD COLUMN live_commerce         jsonb;

-- 2) scalar sub-field generated column.
--    Gemini 출력이 빈 문자열·비숫자 문자열일 가능성이 있어 CASE 로 방어.
--    (a) 필드 없음 / (b) JSON null / (c) 빈 문자열 / (d) 비숫자 문자열 모두 NULL 처리.
ALTER TABLE research_results
  ADD COLUMN korea_fit_score int
    GENERATED ALWAYS AS (
      CASE
        WHEN korea_market_fit->>'fit_score' ~ '^[0-9]+$'
          THEN (korea_market_fit->>'fit_score')::int
      END
    ) STORED;

-- 3) 기존 row의 raw_json -> 새 컬럼 백필.
UPDATE research_results SET
  distribution_channels = raw_json->'research'->'distribution_channels',
  pricing_strategy      = raw_json->'research'->'pricing_strategy',
  marketing_strategy    = raw_json->'research'->'marketing_strategy',
  korea_market_fit      = raw_json->'research'->'korea_market_fit',
  live_commerce         = raw_json->'research'->'live_commerce'
WHERE raw_json->'research' IS NOT NULL;

-- 4) product_id UNIQUE — 코드의 "상품당 1 row" 가정을 DB로 강제.
ALTER TABLE research_results
  ADD CONSTRAINT research_results_product_id_unique UNIQUE (product_id);

-- 5) 인덱스. japan_export_fit_score 컬럼은 이전 마이그레이션에서 이미 추가되어
--    있고, 여기서는 인덱스만 새로 만든다.
CREATE INDEX idx_research_korea_fit_score
  ON research_results (korea_fit_score DESC NULLS LAST);
CREATE INDEX idx_research_japan_export_fit_score
  ON research_results (japan_export_fit_score DESC NULLS LAST);
CREATE INDEX idx_research_distribution_channels
  ON research_results USING gin (distribution_channels jsonb_path_ops);
CREATE INDEX idx_research_pricing_strategy
  ON research_results USING gin (pricing_strategy      jsonb_path_ops);
CREATE INDEX idx_research_marketing_strategy
  ON research_results USING gin (marketing_strategy    jsonb_path_ops);
CREATE INDEX idx_research_korea_market_fit
  ON research_results USING gin (korea_market_fit      jsonb_path_ops);
CREATE INDEX idx_research_live_commerce
  ON research_results USING gin (live_commerce         jsonb_path_ops);

COMMIT;
