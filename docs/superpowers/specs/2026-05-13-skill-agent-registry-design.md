# Skill & Agent Registry — Evolution Design Spec

- **Date**: 2026-05-13
- **Author**: MediaWorks Engineering
- **Status**: Draft (awaiting user review)
- **Target**: 17개 하드코딩된 "skill" 을 DB-backed registry 로 이관 + 진화 가능한 운영 체계 구축
- **Depends on**: 기존 Discovery 피드백 루프 (Phase 4 완료), Vercel Workflow DevKit, AI SDK v6
- **Out of scope**: 자동 A/B winner 선정, LLM 메타 플래너, full multi-agent debate framework (별도 spec)

---

## 1. 목적 (Goal)

현재 시스템은 3개 AI 파이프라인(MD Strategy / Live Commerce / Discovery) 안에 17개의 "skill" 이 TypeScript 함수로 하드코딩되어 있다. 시스템이 진화하면서 skill 이 추가·수정·실험될 때마다 코드 배포가 필요하고, 어떤 prompt 가 어떤 run 에 사용되었는지 추적이 불가능하다.

이 spec 은 **skill 과 agent 를 first-class DB 엔티티로 격상**시켜:
1. 운영자가 admin UI 에서 모든 skill 의 활성 prompt·schema·성능 지표를 볼 수 있게 하고
2. 모든 run 이 사용한 skill 버전을 영구 audit 가능하게 하며
3. 신규 skill 추가가 데이터 작업으로 가능하게 한다 (단, prompt 본문은 여전히 git 소스 truth 유지 — §4.1 참조)

### 1.1 성공 기준

- 17개 skill 이 모두 `skills` / `skill_versions` 테이블에 publish 되어 있다.
- Admin UI (`/admin/registry`) 에서 skill 목록, 버전 이력, 두 버전 diff, 최근 run 샘플을 볼 수 있다.
- 모든 신규 strategy run 이 `agent_runs` + `skill_runs` 에 기록되며, 각 row 는 `skill_version_id` 로 영구 추적 가능하다.
- 기존 하드코딩 for-loop 가 `runPipeline(agentSlug, input)` 단일 진입점으로 교체된다.
- AI Gateway 경유로 Gemini 호출이 통일되어 토큰·비용 텔레메트리가 무료로 들어온다.

### 1.2 범위 밖 (Out of Scope)

- 트래픽 기반 자동 A/B winner 선정 (월 30 runs 에서 통계 검정 불가; §10 거부 패턴 참조)
- LLM 기반 동적 skill 순서 결정 ("메타 플래너"; §10 거부 패턴 참조)
- Critic loop 자동 retry 로직 (Phase D 별도 spec)
- DSPy / MIPRO 식 자동 prompt 최적화 (sample size 부족; §11 외부 참고)
- Non-engineer 가 admin UI 에서 prompt 본문 직접 편집 (대신 "Propose change" → GitHub PR; §4.1 참조)

---

## 2. 현재 시스템 인벤토리

Gemini 호출을 수행하는 모든 함수를 식별. 이 17개가 v1 으로 publish 대상.

| Agent slug | Skill slug | 현재 위치 | 카테고리 |
|---|---|---|---|
| `md_strategy` | `goal_analysis` | `lib/md-strategy.ts:runGoalAnalysis` | analysis |
| `md_strategy` | `product_selection` | `lib/md-strategy.ts:buildProductSelectionPrompt` | analysis |
| `md_strategy` | `channel_strategy` | `lib/md-strategy.ts:buildChannelStrategyPrompt` | analysis |
| `md_strategy` | `pricing_margin` | `lib/md-strategy.ts:buildPricingMarginPrompt` | analysis |
| `md_strategy` | `marketing_execution` | `lib/md-strategy.ts:buildMarketingExecutionPrompt` | analysis |
| `md_strategy` | `financial_projection` | `lib/md-strategy.ts:buildFinancialProjectionPrompt` | analysis |
| `md_strategy` | `risk_contingency` | `lib/md-strategy.ts:buildRiskContingencyPrompt` | analysis |
| `md_strategy` | `discover_curation` | `lib/md-strategy.ts:discoverNewProducts` | curation |
| `live_commerce` | `lc_goal_analysis` | `lib/live-commerce-strategy.ts:runGoalAnalysis` | analysis |
| `live_commerce` | `lc_market_research` | `lib/live-commerce-strategy.ts` | analysis |
| `live_commerce` | `lc_platform_selection` | `lib/live-commerce-strategy.ts` | analysis |
| `live_commerce` | `lc_content_planning` | `lib/live-commerce-strategy.ts` | analysis |
| `live_commerce` | `lc_kpi_targets` | `lib/live-commerce-strategy.ts` | analysis |
| `live_commerce` | `lc_risk_assessment` | `lib/live-commerce-strategy.ts` | analysis |
| `discovery` | `category_plan` | `lib/discovery/plan.ts:buildCategoryPlan` | planning |
| `discovery` | `curate_candidates` | `lib/discovery/curate.ts` | curation |
| `discovery` | `enrich_product` | `lib/discovery/enrich-agent.ts:323` | enrichment |
| `discovery` | `tag_broadcast_evidence` | `lib/discovery/broadcast.ts:88` | enrichment |
| `discovery` | `aggregate_week` | `lib/discovery/weekly-insights.ts:43` | analysis |
| `discovery` | `generate_weekly_insight` | `lib/discovery/weekly-insights.ts:121` | analysis |
| `discovery` | `generate_tv_script_draft` | `lib/discovery/tools/tv-script.ts` | generation |
| `legacy` | `analyze_expansion_strategy` | `lib/gemini.ts` | analysis (deprecate 후보) |

실제로는 17 → 22 skill. 일부는 deprecate 검토 대상.

---

## 3. 아키텍처 개요

```
                ┌──────────────────────────────────┐
                │  Git (source of truth)           │
                │  lib/registry/skills/<slug>/v<N> │
                │   ├─ prompt.ts                   │
                │   ├─ schema.ts (Zod)             │
                │   ├─ meta.ts (model, config)     │
                │   └─ README.md                   │
                └────────────────┬─────────────────┘
                                 │ merge to main
                                 ▼
                ┌──────────────────────────────────┐
                │  CI: scripts/publish-registry.ts │
                │   - hash prompt + schema         │
                │   - INSERT skill_versions row    │
                │   - UPDATE skills.active_pointer │
                │     (gated on Zod validity)      │
                └────────────────┬─────────────────┘
                                 ▼
                ┌──────────────────────────────────┐
                │  Supabase (immutable mirror)     │
                │   skills, skill_versions,        │
                │   agent_pipelines, agent_runs,   │
                │   skill_runs                     │
                └─────────┬─────────────┬──────────┘
                          │             │
              read-only   │             │  per-run write
                          ▼             ▼
                ┌─────────────┐  ┌──────────────────┐
                │ Admin UI    │  │  runPipeline()   │
                │ /admin/...  │  │  (WDK workflow)  │
                └─────────────┘  └────────┬─────────┘
                                          ▼
                                ┌──────────────────┐
                                │  AI Gateway →    │
                                │  Gemini / Claude │
                                └──────────────────┘
```

---

## 4. Source-of-Truth 모델

### 4.1 결정 — Git 우선, DB 는 immutable mirror

**Git 이 canonical, DB 는 publish 된 immutable copy.** 이유:
- 2025-2026 산업 합의 (Anthropic, Vercel, Cursor): DB-only 편집은 "3 단어 prompt 수정 → 수 시간 내 JSON parse cascade" 같은 인시던트를 양산
- Type safety / PR review / git blame / CI 게이트를 모두 무료로 얻음
- "한 번 publish 된 버전은 immutable" — 트리거로 강제

**Non-engineer UX**: Admin UI 의 "Propose change" 버튼이 GitHub API 로 PR 자동 생성 (prompt diff prefilled) → 엔지니어 리뷰 → 머지 → CI 가 publish. 비엔지니어도 prompt 를 *제안* 가능, 단 직접 수정 불가.

### 4.2 디렉터리 구조

```
lib/registry/
  index.ts                       # publishRegistry() entry
  types.ts                       # SkillDefinition, AgentPipeline 타입
  runner.ts                      # runPipeline(agentSlug, input) 범용 실행기
  skills/
    goal_analysis/
      v1/
        prompt.ts                # buildPrompt(ctx): string
        schema.ts                # outputSchema = z.object({...})
        meta.ts                  # { model, generationConfig, validators }
        README.md
      v2/
        ...
    product_selection/
      v1/...
    ...
  pipelines/
    md_strategy/
      v1.ts                      # 선언적 DAG
    live_commerce/
      v1.ts
    discovery/
      v1.ts
scripts/
  publish-registry.ts            # CI step
```

각 `v<N>/` 디렉터리는 한 번 머지되면 변경 금지 (편집은 새 `v<N+1>/` 으로). Git 차원에서 immutable.

---

## 5. DB 스키마

### 5.1 Registry 테이블 (4개)

```sql
-- 1. agents — 안정적 top-level 단위 (3개: md_strategy, live_commerce, discovery)
CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  description text,
  active_pipeline_id uuid,                   -- FK after agent_pipelines
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2. skills — 안정적 ID, 버전은 별도 테이블
CREATE TABLE skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  display_name text NOT NULL,
  category text,                             -- 'analysis' | 'curation' | 'planning' | 'enrichment' | 'generation'
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 3. skill_versions — IMMUTABLE
CREATE TABLE skill_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id uuid NOT NULL REFERENCES skills(id),
  git_sha text NOT NULL,                     -- 40-char commit hash
  version_label text NOT NULL,               -- 'v3', 'v3.1-experimental'
  prompt_template text NOT NULL,             -- 전체 prompt 원본
  output_schema jsonb NOT NULL,              -- Zod → JSON Schema 변환
  model text NOT NULL,                       -- 'google/gemini-3-flash' (AI Gateway slug)
  generation_config jsonb NOT NULL,          -- { temperature, maxTokens, thinkingBudget }
  validators jsonb NOT NULL DEFAULT '[]',    -- 후처리 검증기 슬러그 배열
  published_by text NOT NULL,                -- CI user / GH actor
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, git_sha)
);

-- Immutability trigger
CREATE OR REPLACE FUNCTION prevent_skill_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill_versions is immutable; create a new version instead';
END $$;

CREATE TRIGGER no_update_skill_versions BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_version_mutation();

ALTER TABLE skills
  ADD CONSTRAINT fk_active_version
  FOREIGN KEY (active_version_id) REFERENCES skill_versions(id);

-- 4. agent_pipelines — 선언적 DAG
CREATE TABLE agent_pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  git_sha text NOT NULL,
  version_label text NOT NULL,
  dag jsonb NOT NULL,                        -- [{skill_slug, requires:[...], optional, retry_policy}]
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, git_sha)
);

CREATE TRIGGER no_update_agent_pipelines BEFORE UPDATE OR DELETE ON agent_pipelines
  FOR EACH ROW EXECUTE FUNCTION prevent_skill_version_mutation();

ALTER TABLE agents
  ADD CONSTRAINT fk_active_pipeline
  FOREIGN KEY (active_pipeline_id) REFERENCES agent_pipelines(id);
```

### 5.2 Run 추적 테이블 (2개)

```sql
-- 5. agent_runs — 한 번의 워크플로우 실행
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id),
  pipeline_version_id uuid NOT NULL REFERENCES agent_pipelines(id),
  workflow_run_id text,                       -- Vercel WDK run id
  user_id uuid,
  input jsonb NOT NULL,
  status text NOT NULL,                       -- 'running' | 'completed' | 'failed' | 'cancelled'
  total_cost_usd numeric(10,6),
  total_tokens_in int,
  total_tokens_out int,
  duration_ms int,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ON agent_runs (agent_id, started_at DESC);
CREATE INDEX ON agent_runs (status) WHERE status = 'running';

-- 6. skill_runs — 모든 skill 호출 1건씩 (월별 파티션)
CREATE TABLE skill_runs (
  id uuid DEFAULT gen_random_uuid(),
  agent_run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES skills(id),
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),  -- 영구 audit anchor
  step_name text NOT NULL,
  input_hash text NOT NULL,                  -- sha256(normalized input) → replay key
  input_jsonb jsonb,
  output_jsonb jsonb,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(10,6),
  duration_ms int,
  validator_violations jsonb DEFAULT '[]',
  status text NOT NULL,
  gateway_request_id text,                   -- AI Gateway correlation
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);

CREATE TABLE skill_runs_2026_05 PARTITION OF skill_runs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE skill_runs_2026_06 PARTITION OF skill_runs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
-- 추가 파티션은 nightly 잡으로 6개월 앞 미리 생성

CREATE INDEX ON skill_runs (skill_version_id, started_at DESC);
CREATE INDEX ON skill_runs (agent_run_id);
CREATE INDEX ON skill_runs (input_hash);     -- workflow replay lookup
```

### 5.3 Materialized view — 30 일 비용/품질 롤업

```sql
CREATE MATERIALIZED VIEW skill_version_cost_30d AS
SELECT
  sv.id AS skill_version_id,
  sv.skill_id,
  COUNT(*) AS runs,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
  SUM(cost_usd) AS total_cost_usd,
  AVG(jsonb_array_length(validator_violations)) AS avg_violations,
  SUM(CASE WHEN jsonb_array_length(validator_violations) > 0 THEN 1 ELSE 0 END)::float
    / NULLIF(COUNT(*), 0) AS violation_rate
FROM skill_runs sr
JOIN skill_versions sv ON sv.id = sr.skill_version_id
WHERE sr.started_at >= now() - interval '30 days'
GROUP BY sv.id, sv.skill_id;

CREATE UNIQUE INDEX ON skill_version_cost_30d (skill_version_id);
```

Nightly refresh via cron at 04:00 JST.

### 5.4 RLS 정책

```sql
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_runs ENABLE ROW LEVEL SECURITY;

-- Registry: authenticated 읽기, service_role (CI) 쓰기
CREATE POLICY registry_read ON agents FOR SELECT TO authenticated USING (true);
CREATE POLICY registry_read ON skills FOR SELECT TO authenticated USING (true);
CREATE POLICY registry_read ON skill_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY registry_read ON agent_pipelines FOR SELECT TO authenticated USING (true);

-- Runs: 일단 authenticated 모두 읽기 (single-tenant internal tool); 추후 user_id 기반 제한
CREATE POLICY runs_read ON agent_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY runs_read ON skill_runs FOR SELECT TO authenticated USING (true);

-- 쓰기는 모두 service_role (server-only)
```

---

## 6. Publish 파이프라인 (CI)

`scripts/publish-registry.ts` 가 `main` 머지마다 실행:

```typescript
// 의사 코드
async function publishRegistry() {
  const gitSha = process.env.GITHUB_SHA;
  const skills = await walkRegistry('lib/registry/skills');

  for (const skill of skills) {
    // 1. Zod schema 유효성 검증 (publish 게이트)
    try {
      zodToJsonSchema(skill.outputSchema);
    } catch (err) {
      throw new Error(`Skill ${skill.slug} v${skill.version}: invalid Zod schema`);
    }

    // 2. (skill_id, git_sha) idempotent insert
    const skillRow = await upsertSkill(skill.slug, skill.displayName, skill.category);
    const versionRow = await insertSkillVersionIfNew({
      skill_id: skillRow.id,
      git_sha: gitSha,
      version_label: skill.versionLabel,
      prompt_template: skill.promptSource,
      output_schema: zodToJsonSchema(skill.outputSchema),
      model: skill.meta.model,
      generation_config: skill.meta.generationConfig,
      validators: skill.meta.validators,
      published_by: process.env.GITHUB_ACTOR,
    });

    // 3. release.json 에 명시된 active 버전이면 pointer 이동
    if (skill.versionLabel === skill.activeVersionLabel) {
      await db.update(skills)
        .set({ active_version_id: versionRow.id })
        .where(eq(skills.id, skillRow.id));
    }
  }

  // 4. agent_pipelines 동일하게 publish
  for (const pipeline of await loadPipelines()) {
    await insertPipelineVersionIfNew(pipeline, gitSha);
  }
}
```

GitHub Actions workflow (`.github/workflows/publish-registry.yml`):

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'lib/registry/skills/**'
      - 'lib/registry/pipelines/**'
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run publish-registry
        env:
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          GITHUB_SHA: ${{ github.sha }}
          GITHUB_ACTOR: ${{ github.actor }}
```

---

## 7. Pipeline Runner — `runPipeline(agentSlug, input)`

`lib/registry/runner.ts` 가 모든 agent 실행의 단일 진입점.

```typescript
// 의사 코드
export async function runPipeline(
  agentSlug: string,
  input: Record<string, unknown>,
  ctx: { userId?: string; workflowRunId?: string },
): Promise<AgentRunResult> {
  // 1. 활성 pipeline DAG 로드
  const { pipeline, dag } = await loadActivePipeline(agentSlug);

  // 2. agent_runs row 생성
  const run = await insertAgentRun({
    agent_id: pipeline.agent_id,
    pipeline_version_id: pipeline.id,
    workflow_run_id: ctx.workflowRunId,
    user_id: ctx.userId,
    input,
    status: 'running',
  });

  // 3. DAG topological sort + 입력 부재 skill skip
  const order = topoSort(dag);
  const outputs: Record<string, unknown> = {};

  for (const node of order) {
    // 의존성 확인
    const missing = node.requires.filter((req) => !outputs[req]);
    if (missing.length > 0) {
      if (node.optional) continue;
      throw new Error(`Skill ${node.skill_slug}: missing required inputs ${missing.join(',')}`);
    }

    // 활성 skill_version 로드
    const skillVersion = await loadActiveSkillVersion(node.skill_slug);

    // skill 실행 — Vercel Workflow "use step" 안에서
    const result = await runSkill(skillVersion, { input, outputs });
    outputs[node.skill_slug] = result.output;

    // skill_runs 기록
    await insertSkillRun({
      agent_run_id: run.id,
      skill_id: skillVersion.skill_id,
      skill_version_id: skillVersion.id,
      ...result,
    });
  }

  // 4. agent_runs 마무리
  await updateAgentRun(run.id, {
    status: 'completed',
    total_cost_usd: sum(outputs.costs),
    duration_ms: now() - run.started_at,
    finished_at: now(),
  });

  return { agentRunId: run.id, outputs };
}
```

`runSkill` 은 내부적으로 AI SDK v6 `generateText` 를 AI Gateway 경유로 호출하고 `experimental_telemetry: { metadata: { skillSlug, skillVersionId, agentRunId } }` 를 붙임.

---

## 8. Admin UI 표면

| 페이지 | 경로 | 데이터 바인딩 | 핵심 UI |
|---|---|---|---|
| **Registry list** | `/admin/registry` | `skills` ⋈ active `skill_versions` ⋈ `skill_version_cost_30d` | 정렬·필터 가능 테이블: slug, 활성 버전, 모델, p95 latency, 30일 비용 (USD), violation rate |
| **Skill detail** | `/admin/registry/[skillSlug]` | `skill_versions WHERE skill_id=?`, 최근 20 `skill_runs` | 버전 타임라인 (활성 뱃지), 두 버전 side-by-side diff (prompt + schema, Monaco editor), 최근 runs 샘플 카드, "Set active" 버튼 (audited), "Propose change" → GitHub PR 생성 |
| **Run inspector** | `/admin/runs/[agentRunId]` | `agent_runs` row + `skill_runs` 트리 | react-flow DAG 시각화, 노드 클릭 시 drawer 에 input/output JSON / violations / tokens / cost / AI Gateway deeplink |
| **Pipeline view** | `/admin/agents/[agentSlug]` | `agent_pipelines WHERE agent_id=?` | 활성 DAG 렌더링, 버전 dropdown, 각 노드 클릭 → skill detail |

권한: 일단 모든 authenticated 사용자에게 read-only. "Set active" / "Propose change" 는 admin role 필요 (별도 RLS + UI 게이팅).

---

## 9. Phase 통합

이 spec 의 registry 가 도입되면 이전 4번에 걸친 분석에서 도출된 Phase 들이 자연스럽게 맞물림:

| Phase | Registry 와의 관계 |
|---|---|
| **Phase 0** AI Gateway + telemetry | `skill_runs.gateway_request_id` + `cost_usd` 가 Gateway 출력을 그대로 받아들임. Gateway 가 model='google/gemini-3-flash' slug 를 직접 라우팅 |
| **Phase A** 결정론적 validator | `skill_versions.output_schema` 가 Zod → JSON Schema 변환본. 런타임 후처리 검증 결과를 `skill_runs.validator_violations` 에 기록 |
| **Phase B** Prompts as data | **이게 Registry 자체**. 별도 phase 아님 |
| **Phase C** 선언적 skill manifest | `agent_pipelines.dag` 가 manifest. for-loop 는 `runPipeline()` 으로 대체 |
| **Phase D** Evaluator-Optimizer (critic) | `validator_critic` 라는 skill 슬러그로 registry 등록. cross-family judge (Claude Sonnet 4.6) 사용. `meta.ts` 의 `model` 필드로 강제. `agent_pipelines.dag` 의 한 노드로 삽입 |

---

## 10. 거부하는 anti-patterns (명시적)

| Anti-pattern | 이유 |
|---|---|
| DB 에서 prompt 직접 편집 + 핫리로드 | git ownership 포기 → type safety / CI / review 전멸; 3 단어 수정이 cascade 사고 유발 (Deepchecks 보고) |
| `skill_versions` row 의 UPDATE/DELETE | replay audit 가 깨짐; v3 를 가리키는 run 이 나중에 다른 prompt 를 읽게 됨. **트리거로 차단** |
| Zod schema 를 런타임에서만 검증 | publish 시 CI 가 schema 자체의 well-formedness 도 검증해야 함 (malformed schema 가 prod 에 못 들어오게) |
| 하나의 거대 `prompts` JSONB 테이블 (버전 미분리) | 3 개월 전 run X 가 어느 prompt 썼는지 못 찾음 → 감사 불가 |
| 트래픽 기반 자동 winner promotion | N=30/월 에서 모든 통계 검정 의미 없음. 수동 pinning 만 허용 |
| LLM 메타 플래너로 동적 skill 순서 결정 | `agent_pipelines.dag` 의 선언적 형태로 충분. LLM 결정은 replay non-determinism + PDF/대시보드 계약 깨뜨림 |
| Gemini-judges-Gemini critic | self-preference bias (arXiv 2508.06709). `validator_critic` 은 반드시 cross-family (Claude). `meta.ts` 의 `model` 필드로 강제 |
| Workflow step 안에서 prompt 변형 후 재실행 | WDK step memoization 과 충돌. critic-triggered retry 는 별도 step + `workflow_decisions` 캐시 테이블 필요 |

---

## 11. 마이그레이션 순서 (Step 1-13, 각 단계 독립 출시 가능)

| Step | 작업 | 의존성 | 예상 |
|---|---|---|---|
| 1 | Registry 스키마 + immutability trigger + RLS migration | — | 반일 |
| 2 | `lib/registry/skills/` 스캐폴드 + `scripts/publish-registry.ts` + CI workflow | 1 | 1일 |
| 3 | `goal_analysis` 1개 skill 을 v1 으로 이관 (패턴 검증) | 2 | 반일 |
| 4 | 나머지 16개 skill 을 v1 으로 일괄 이관 | 3 | 2-3일 |
| 5 | Admin UI 페이지 1+2 (registry list, skill detail) | 4 | 3일 |
| 6 | `agent_pipelines` + 3개 파이프라인 v1 publish | 4 | 1일 |
| 7 | `agent_runs` + `skill_runs` 파티션 테이블 생성 | 1 | 반일 |
| 8 | AI Gateway 라우팅 전환 + AI SDK `experimental_telemetry` 활성화 | — (병렬) | 반일 |
| 9 | 기존 for-loop 에 dual-write 추가 (실행은 옛 코드, 기록은 신규 테이블) | 7, 8 | 1-2일 |
| 10 | Admin UI 페이지 3+4 (run inspector, pipeline view) | 9 | 3일 |
| 11 | `lib/registry/runner.ts` 의 `runPipeline()` 구현 | 6, 7 | 2일 |
| 12 | `REGISTRY_ENABLED=md_strategy` flag 로 점진 cut-over → LC → Discovery | 11 | agent 당 1주 (관찰 포함) |
| 13 | for-loop 코드 삭제, dual-write 제거, `skill_version_cost_30d` MV + nightly refresh | 12 | 1일 |

**총 추정**: full-time 1 dev 기준 약 4-6주 (관찰·QA 시간 포함).

### 추후 (별도 spec)

- **Phase A 확장**: 7 개 Zod 검증기 + cross-skill consistency + citation 누락 검출
- **Phase D**: `validator_critic` skill 등록 + Evaluator-Optimizer 패턴 + `workflow_decisions` 캐시
- **Eval suite**: `docs/evals/golden-inputs.json` + `npm run eval:strategy` + PR merge gate (Hex funnel-of-binary-graders 모델)

---

## 12. 첫 PR 묶음 (다음 액션)

| PR | 범위 | 추정 |
|---|---|---|
| **PR #17** | Phase 0: AI Gateway 라우팅 + `experimental_telemetry`. `.env.local` 에 `AI_GATEWAY_API_KEY` 추가. 17개 Gemini 호출 지점을 Gateway 경유로 통일 | 반일 |
| **PR #18** | Step 1-2: registry DDL migration + immutability trigger + RLS + `lib/registry/` 스캐폴드 + publish CI | 1-2일 |
| **PR #19** | Step 3: `goal_analysis` 만 v1 으로 이관해서 publish 파이프라인 end-to-end 검증 | 반일 |
| **PR #20** | Step 4: 나머지 16개 skill 일괄 v1 이관 | 2-3일 |
| **PR #21** | Step 5: Admin UI 페이지 1+2 (registry list + skill detail) → 사용자 요구 "보이는 형태" 직접 충족 | 3일 |

PR #17 + #18 + #19 까지면 **약 1주 안에 처음 사용자에게 "registry 가 살아 있다"가 보이는 상태** 가 됨.

---

## 13. 외부 참고

| 출처 | 시사점 |
|---|---|
| [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) | 프레임워크 도입 전에 raw LLM 호출 패턴이 충분한지 먼저 검증. Evaluator-Optimizer / Orchestrator-Worker 패턴 명명 |
| [AI SDK v6 — Workflow Patterns](https://ai-sdk.dev/docs/agents/workflows) | Sequential / Routing / Parallel / Evaluator-Optimizer / Orchestrator-Worker 5 패턴. 우리는 Sequential + Evaluator-Optimizer 채택 |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) | 토큰·비용·latency 텔레메트리 무료. zero markup. 한 줄 도입 |
| [Hex — vanity evals 거부](https://hex.tech/blog/im-sorry-but-those-are-vanity-evals/) | 7-skill 파이프라인의 evaluation 은 stage-level binary pass/fail funnel 로. 평균 별점 거부 |
| [Hamel Husain — LLM Eval FAQ](https://hamel.dev/blog/posts/evals-faq/) | 30 examples, binary pass/fail, 매 prompt 변경 후 manual review 30분. 우리 scale 의 정답 |
| [Hamel Husain — LLM as Judge](https://hamel.dev/blog/posts/llm-judge/) | judge 는 stronger family. binary pass/fail. ~30 calibration examples 으로 expert 와 align. pairwise > absolute |
| [arXiv 2508.06709 — Self-bias in LLM judge](https://arxiv.org/abs/2508.06709) | Same-family judge 의 self-preference bias 정량 증거. cross-family judge 채택 근거 |
| [DSPy MIPRO docs](https://dspy.ai/learn/optimization/optimizers/) | 자동 prompt 최적화는 50+ (BootstrapFewShot) / 200+ (MIPROv2) examples 필요. 우리는 영구 cold start → 자동 최적화 불가 |
| [Mastering Prompt Versioning](https://dev.to/kuldeep_paul/mastering-prompt-versioning-best-practices-for-scalable-llm-development-2mgm) | Git 우선, DB 는 immutable mirror. publish 후 row immutable. fix = 새 version |
| [Deepchecks — Prompt update incidents](https://deepchecks.com/llm-production-challenges-prompt-update-incidents/) | DB-only 편집의 실제 인시던트들. "3 단어 수정 → 수 시간 내 JSON parse cascade" |
| [vercel/workflow-examples](https://github.com/vercel/workflow-examples) | WDK 캐노니컬 패턴. `kitchen-sink`, `rag-agent`, `routing-slip` 참고 |

---

## 14. Open questions (사용자 확인 필요)

1. **Admin UI 권한 모델**: 일단 모든 authenticated 사용자에게 read-only, "Set active" / "Propose change" 만 admin role 요구. 별도 admin role 테이블 추가할지, 기존 인증 시스템에 role 컬럼 추가할지?
2. **Cross-family judge 비용**: Claude Sonnet 4.6 호출이 critic 으로 들어가면 Anthropic API key 별도 필요. 예산 영향 검토 필요 (Phase D 시점에 결정)
3. **`analyze_expansion_strategy` (legacy) 처리**: registry 에 넣을지, deprecate 후 사용처 정리할지?
4. **Discovery `enrich_product` 는 실제로 다단 agent**: tool calling 까지 포함됨. Phase 5 (tool-using skill) 도래 전까지 단순 prompt 로 평탄화할지, 별도 처리할지?

---

**End of spec.**
