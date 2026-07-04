# 테레비도쿄 데이터 파이프라인 구현 계획 (A~D 개요 + A 상세)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 도쿄TV 통판 데이터가 도착하기 전에, 데이터 없이 빌드·테스트 가능한 **④ 대본+考査 엔진 기반 정비**(테넌시·식품 법령축·B-5 텔롭검수·B-1 테넌트별 문체)를 완성해, architect 리뷰가 게이트한 2개 항목(테넌시·④ 코드범위)을 해소한다.

**Architecture:** 기존 `lib/screenplay` 검수·생성 엔진은 재사용하되, (1) `compliance_rules`/`compliance_references`에 `tenant` 컬럼을 넣어 도쿄TV 코퍼스가 mediaworks 자체 검수를 오염시키지 않게 하고, (2) 하드코딩된 법령축(薬機法·景表法·健康増進法)을 로드된 규칙에서 파생시켜 食品表示法·特商法을 수용하며, (3) 검수 입력에 텔롭·가격표시 경로를 추가하고, (4) 전역 문체 싱글턴을 테넌트별 파일 로더로 교체한다.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase (Postgres + RLS), `@google/genai` (Gemini), tsx 스모크 테스트 (프레임워크 없음).

## Global Constraints

- **테스트 프레임워크 없음.** 테스트 = `scripts/test-*.ts` + `package.json`의 `test:*` 별칭. 로컬 `assert(cond, msg)` 헬퍼(실패 시 `process.exitCode = 1`, `console.log("✓ …")`). 순수 로직은 `tsx scripts/x.ts`, DB/live는 `tsx --env-file=.env.local scripts/x.ts`.
- **마이그레이션은 수동 적용.** supabase CLI / `db:push` 없음. 에이전트는 `.sql`을 **작성만** 하고 적용은 사용자가 한다. "마이그레이션을 실행했다"고 주장 금지. 검증은 **skip-guarded 라이브 테스트**(env 없으면 SKIP 로그 후 종료)로.
- **`server-only` 금지 (스모크 대상 lib).** `scripts/test-*.ts`에서 직접 import하는 lib 파일은 `import "server-only"`를 포함하면 안 됨(tsx가 모듈 로드 시 throw). 서버 가드는 `getServiceClient`(`SUPABASE_SERVICE_ROLE_KEY`)에 의존.
- **RLS는 최후 방어선.** 새 컬럼·테이블에도 role 기반 정책 유지. `getServiceClient()`는 RLS 우회(크론/서버 전용), 사용자 경로는 `getServerClient()` + `requireUser([roles])`.
- **대본 출력은 100% 일본어** (`SYSTEM_INSTRUCTION` 불변 계약). 이 계획은 검수·주입 경로만 건드리며 그 계약을 바꾸지 않는다.
- **테넌트 기본값 = `'mediaworks'`.** 기존 모든 행·경로의 암묵 테넌트. 도쿄TV는 `'tokyo_tv'`.

---

## 로드맵 개요 (A~D)

이 계획서는 **A를 상세 TDD**로, B~D를 개요로 다룬다. 분할 근거는 데이터 의존성(spec §6.3):

| 하위계획 | 산출물 | 데이터 의존 | 상태 |
|---|---|---|---|
| **A. ④ 엔진 기반 정비** | 테넌시 · 식품 법령축 · B-5 텔롭검수 · B-1 테넌트 문체 | 없음 (합성 픽스처) | **본 계획 상세** |
| **B. `tt_` 웨어하우스 + 일본어 매처** | `tt_*` 마이그레이션 + 크로스워크 2테이블 + 문자 n-gram 매처 | 없음 (합성 일본어명) | 개요 (§B) |
| **C. STAGE 0~2 수집·추출·검수** | 반입 vault+파일해시 dedup / Gemini 소스별 추출 / 리뷰 UI | 부분 (실포맷 대기) | 개요 (§C) |
| **D. STAGE 4 ⑤ 수요 예측** | 방송×콜×EC 예측 + 인력 제안 | 전면 (콜/EC 시계열 대기) | 개요 (§D) |

**의존 순서:** A는 독립. B는 독립(A와 병렬 가능). C는 A(코퍼스 시드 목적지)·B(`tt_` 테이블·매처)에 의존. D는 B(크로스워크)·C(콜/EC 적재)에 의존.

---

# 하위계획 A — ④ 엔진 기반 정비 (상세)

**태스크 순서:** A1(테넌시 스키마) → A2(로드 함수 테넌시) → A3(식품 법령축 스키마) → A4(판정 프롬프트 법령축) → A5(B-5 텔롭·가격 검수) → A6(B-1 테넌트별 문체). A1이 스키마 토대, A3가 그 위 CHECK 확장이라 스키마 태스크(A1·A3)를 먼저 둔다.

---

### Task A1: 테넌시 스키마 마이그레이션

`compliance_rules` / `compliance_references`에 `tenant` 컬럼 추가 + UNIQUE 키에 tenant 포함. (`screenplays` 테넌시는 로드맵 §A-후속 — 검수 코퍼스 오염이 게이트라 코퍼스 2테이블만 우선.)

**Files:**
- Create: `supabase/migrations/2026-07-04_compliance_tenant.sql`
- Create: `scripts/test-compliance-tenant-schema.ts`
- Modify: `package.json` (test 별칭 1줄 추가)

**Interfaces:**
- Produces: `compliance_rules.tenant` / `compliance_references.tenant` (text, NOT NULL, default `'mediaworks'`); UNIQUE(`tenant`,`law`,`pattern`) / UNIQUE(`tenant`,`law`,`topic`).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-tenant-schema.ts`:

```typescript
import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
		console.log("SKIP: no SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)");
		return;
	}
	const sb = getServiceClient();

	// tenant column exists with default 'mediaworks' on both corpus tables.
	const rule = await sb.from("compliance_rules")
		.insert({ law: "yakkiho", pattern: `__tenant_probe_${Date.now()}` })
		.select("id,tenant").single();
	assert(!rule.error, `insert compliance_rules ok: ${rule.error?.message ?? ""}`);
	assert(rule.data?.tenant === "mediaworks", "compliance_rules.tenant defaults to 'mediaworks'");
	if (rule.data?.id) await sb.from("compliance_rules").delete().eq("id", rule.data.id);

	const ref = await sb.from("compliance_references")
		.insert({ law: "other", topic: `__tenant_probe_${Date.now()}`, body: "x" })
		.select("id,tenant").single();
	assert(!ref.error, `insert compliance_references ok: ${ref.error?.message ?? ""}`);
	assert(ref.data?.tenant === "mediaworks", "compliance_references.tenant defaults to 'mediaworks'");
	if (ref.data?.id) await sb.from("compliance_references").delete().eq("id", ref.data.id);

	// UNIQUE now includes tenant: same (law,pattern) under two tenants must coexist.
	const p = `__tenant_uniq_${Date.now()}`;
	const a = await sb.from("compliance_rules").insert({ law: "keihyo", pattern: p, tenant: "mediaworks" }).select("id").single();
	const b = await sb.from("compliance_rules").insert({ law: "keihyo", pattern: p, tenant: "tokyo_tv" }).select("id").single();
	assert(!a.error && !b.error, `same (law,pattern) coexists across tenants: ${a.error?.message ?? ""} ${b.error?.message ?? ""}`);
	for (const id of [a.data?.id, b.data?.id]) if (id) await sb.from("compliance_rules").delete().eq("id", id);
}
main();
```

- [ ] **Step 2: Add the test alias and run to verify it fails**

Add to `package.json` scripts:

```json
"test:compliance-tenant-schema": "tsx --env-file=.env.local scripts/test-compliance-tenant-schema.ts",
```

Run: `npm run test:compliance-tenant-schema`
Expected: FAIL — `insert ... ok: column "tenant" does not exist` (or the tenant assertions fail).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/2026-07-04_compliance_tenant.sql`:

```sql
-- 2026-07-04: multi-tenant scoping for the screenplay compliance corpus.
-- Tokyo-TV 考査 rules/refs must not pollute mediaworks' own checks and vice
-- versa. `tenant` is a DATA filter (not a security boundary between our own
-- roles) — RLS role policies are unchanged. Existing rows default to
-- 'mediaworks'. UNIQUE keys gain `tenant` so the same (law,pattern)/(law,topic)
-- may exist per tenant.

BEGIN;

ALTER TABLE compliance_rules      ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'mediaworks';
ALTER TABLE compliance_references ADD COLUMN IF NOT EXISTS tenant text NOT NULL DEFAULT 'mediaworks';

ALTER TABLE compliance_rules      DROP CONSTRAINT IF EXISTS compliance_rules_law_pattern_key;
ALTER TABLE compliance_rules      ADD  CONSTRAINT compliance_rules_tenant_law_pattern_key UNIQUE (tenant, law, pattern);

ALTER TABLE compliance_references DROP CONSTRAINT IF EXISTS compliance_references_law_topic_key;
ALTER TABLE compliance_references ADD  CONSTRAINT compliance_references_tenant_law_topic_key UNIQUE (tenant, law, topic);

CREATE INDEX IF NOT EXISTS compliance_rules_tenant_active_idx      ON compliance_rules (tenant, active)      WHERE active;
CREATE INDEX IF NOT EXISTS compliance_references_tenant_active_idx ON compliance_references (tenant, active) WHERE active;

COMMIT;
```

- [ ] **Step 4: Apply the migration (USER action) then run the test**

The engineer CANNOT apply migrations. Post this message and wait:

> 마이그레이션 `supabase/migrations/2026-07-04_compliance_tenant.sql`를 Supabase SQL 에디터에서 적용해 주세요. 적용 후 알려주시면 검증 테스트를 돌립니다.

After user confirms, run: `npm run test:compliance-tenant-schema`
Expected: PASS (all ✓, no ✗).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-07-04_compliance_tenant.sql scripts/test-compliance-tenant-schema.ts package.json
git commit -m "feat(compliance): add tenant scoping to rules/references corpus"
```

---

### Task A2: 로드 함수 테넌시 스레딩

`loadActiveRules` / `loadActiveReferences`가 `tenant`로 필터하도록, `checkScreenplay`가 tenant를 전달하도록 한다.

**Files:**
- Modify: `lib/screenplay/compliance/check.ts:26-50` (두 로드 함수), `:255-261` (checkScreenplay 시그니처)
- Create: `scripts/test-compliance-tenant-load.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `compliance_rules.tenant` / `compliance_references.tenant` (Task A1).
- Produces:
  - `loadActiveRules(tenant?: string): Promise<ComplianceRule[]>` — default `'mediaworks'`.
  - `loadActiveReferences(tenant?: string): Promise<ComplianceReference[]>` — default `'mediaworks'`.
  - `checkScreenplay(markdown, brief, rules, references?, opts?)` — `opts` gains `tenant?: string` (used later; load happens at call sites, so this is forward-compat metadata on `GroundingMeta`... see Step 3).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-tenant-load.ts`:

```typescript
import { loadActiveRules, loadActiveReferences } from "../lib/screenplay/compliance/check";
import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log("SKIP: no service key"); return; }
	const sb = getServiceClient();
	const stamp = Date.now();
	const tt = await sb.from("compliance_rules")
		.insert({ law: "keihyo", pattern: `__tt_only_${stamp}`, tenant: "tokyo_tv", active: true }).select("id").single();

	try {
		const mw = await loadActiveRules();               // default 'mediaworks'
		assert(!mw.some((r) => r.pattern === `__tt_only_${stamp}`), "default tenant load excludes tokyo_tv rule");
		const tv = await loadActiveRules("tokyo_tv");
		assert(tv.some((r) => r.pattern === `__tt_only_${stamp}`), "tokyo_tv load includes its own rule");
		const refs = await loadActiveReferences("tokyo_tv");
		assert(Array.isArray(refs), "loadActiveReferences(tenant) returns array");
	} finally {
		if (tt.data?.id) await sb.from("compliance_rules").delete().eq("id", tt.data.id);
	}
}
main();
```

- [ ] **Step 2: Add alias and run to verify it fails**

Add to `package.json`:

```json
"test:compliance-tenant-load": "tsx --env-file=.env.local scripts/test-compliance-tenant-load.ts",
```

Run: `npm run test:compliance-tenant-load`
Expected: FAIL — `loadActiveRules("tokyo_tv")` is a type/arg error OR the mediaworks load wrongly includes the tokyo_tv rule (no tenant filter yet).

- [ ] **Step 3: Modify the load functions**

In `lib/screenplay/compliance/check.ts`, replace the two load functions (lines 26-50):

```typescript
export async function loadActiveRules(tenant: string = "mediaworks"): Promise<ComplianceRule[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("compliance_rules")
		.select("id,law,category_scope,pattern,is_regex,allowed,severity,reason,safe_rewrite,citation,active")
		.eq("active", true)
		.eq("tenant", tenant);
	if (error) {
		console.warn("[compliance] loadActiveRules failed:", error.message);
		return [];
	}
	return (data ?? []) as ComplianceRule[];
}

export async function loadActiveReferences(tenant: string = "mediaworks"): Promise<ComplianceReference[]> {
	const sb = getServiceClient();
	const { data, error } = await sb
		.from("compliance_references")
		.select("id,law,category_scope,topic,body,keywords,citation,source_url,active")
		.eq("active", true)
		.eq("tenant", tenant);
	if (error) {
		console.warn("[compliance] loadActiveReferences failed:", error.message);
		return [];
	}
	return (data ?? []) as ComplianceReference[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:compliance-tenant-load`
Expected: PASS.

- [ ] **Step 5: Update call sites (grep + thread tenant)**

Run: `git grep -n "loadActiveRules\|loadActiveReferences" -- 'app/**' 'lib/**'`
For each caller in an API route, resolve tenant from the request context (default `'mediaworks'` when unset — no behavior change for existing mediaworks paths). If a caller has no tenant concept yet, leave the default (explicitly pass nothing). Do NOT invent a tenant source; only thread where a tenant is already available. Commit note should list which call sites were touched.

- [ ] **Step 6: Verify no type regressions**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/screenplay/compliance/check.ts scripts/test-compliance-tenant-load.ts package.json
git commit -m "feat(compliance): tenant-filter rule/reference loaders (default mediaworks)"
```

---

### Task A3: 식품 법령축 CHECK 확장 마이그레이션

`law` CHECK가 `('yakkiho','keihyo','kenzo')`뿐이라 食品表示法·特商法을 거부한다. CHECK를 확장한다.

**Files:**
- Create: `supabase/migrations/2026-07-04_compliance_law_food_axis.sql`
- Create: `scripts/test-compliance-food-law.ts`
- Modify: `package.json`
- Modify: `lib/screenplay/compliance/types.ts:1` (`ComplianceLaw` 유니온 확장)

**Interfaces:**
- Produces: `compliance_rules.law` / `compliance_references.law` accept `'shokuhin'` (食品表示法), `'tokushoho'` (特定商取引法). `ComplianceLaw = "yakkiho" | "keihyo" | "kenzo" | "shokuhin" | "tokushoho"`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-food-law.ts`:

```typescript
import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log("SKIP: no service key"); return; }
	const sb = getServiceClient();
	for (const law of ["shokuhin", "tokushoho"]) {
		const r = await sb.from("compliance_rules")
			.insert({ law, pattern: `__foodlaw_${law}_${Date.now()}`, tenant: "tokyo_tv" }).select("id").single();
		assert(!r.error, `compliance_rules accepts law='${law}': ${r.error?.message ?? ""}`);
		if (r.data?.id) await sb.from("compliance_rules").delete().eq("id", r.data.id);
	}
}
main();
```

- [ ] **Step 2: Add alias and run to verify it fails**

Add to `package.json`:

```json
"test:compliance-food-law": "tsx --env-file=.env.local scripts/test-compliance-food-law.ts",
```

Run: `npm run test:compliance-food-law`
Expected: FAIL — `violates check constraint "compliance_rules_law_check"`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/2026-07-04_compliance_law_food_axis.sql`:

```sql
-- 2026-07-04: extend the compliance `law` axis for Tokyo-TV food commerce.
-- 虎ノ門市場 (food) は薬機法より食品表示法・優良誤認(景表法)・特商法(定期便告知)
-- が考査の中心。CHECK を拡張して食品表示法(shokuhin)・特商法(tokushoho)を受容する。
-- inline column CHECK の既定名は <table>_<column>_check。

BEGIN;

ALTER TABLE compliance_rules DROP CONSTRAINT IF EXISTS compliance_rules_law_check;
ALTER TABLE compliance_rules ADD  CONSTRAINT compliance_rules_law_check
  CHECK (law IN ('yakkiho','keihyo','kenzo','shokuhin','tokushoho'));

ALTER TABLE compliance_references DROP CONSTRAINT IF EXISTS compliance_references_law_check;
ALTER TABLE compliance_references ADD  CONSTRAINT compliance_references_law_check
  CHECK (law IN ('yakkiho','keihyo','kenzo','other','shokuhin','tokushoho'));

COMMIT;
```

- [ ] **Step 4: Extend the type union**

In `lib/screenplay/compliance/types.ts` line 1:

```typescript
export type ComplianceLaw = "yakkiho" | "keihyo" | "kenzo" | "shokuhin" | "tokushoho";
```

(`ReferenceLaw = ComplianceLaw | "other"` on line 40 stays as-is; it inherits the new members.)

- [ ] **Step 5: Apply migration (USER action) then run test + typecheck**

Post and wait:

> 마이그레이션 `2026-07-04_compliance_law_food_axis.sql`를 적용해 주세요.

After confirm:
Run: `npm run test:compliance-food-law` → Expected: PASS.
Run: `npx tsc --noEmit` → Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-07-04_compliance_law_food_axis.sql lib/screenplay/compliance/types.ts scripts/test-compliance-food-law.ts package.json
git commit -m "feat(compliance): extend law axis with 食品表示法/特商法 for food commerce"
```

---

### Task A4: 판정 프롬프트의 법령축 파생

`buildPrompt`가 법령축을 `"薬機法・景表法・健康増進法"`로 하드코딩(`check.ts:215`)한다. 로드된 규칙의 distinct `law`에서 법령 목록을 파생하는 순수 함수로 교체한다.

**Files:**
- Modify: `lib/screenplay/compliance/check.ts:169-228` (`buildPrompt`) — 순수 헬퍼 `describeLegalAxis` 추가 + `__test` export
- Create: `scripts/test-compliance-legal-axis.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `describeLegalAxis(laws: string[]): string` — distinct law 코드를 일본어 법령명으로 매핑해 `"薬機法・景表法・食品表示法"` 형태 문자열 반환. 미지 코드는 무시. 빈 입력 → `"関連法規"`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-legal-axis.ts`:

```typescript
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
```

- [ ] **Step 2: Add alias and run to verify it fails**

Add to `package.json`:

```json
"test:compliance-legal-axis": "tsx scripts/test-compliance-legal-axis.ts",
```

Run: `npm run test:compliance-legal-axis`
Expected: FAIL — `Cannot read properties of undefined (reading 'describeLegalAxis')`.

- [ ] **Step 3: Add the helper and wire it into buildPrompt**

In `lib/screenplay/compliance/check.ts`, add above `buildPrompt` (near line 169):

```typescript
const LAW_LABELS: Record<string, string> = {
	yakkiho: "薬機法",
	keihyo: "景表法",
	kenzo: "健康増進法",
	shokuhin: "食品表示法",
	tokushoho: "特商法",
};

export function describeLegalAxis(laws: string[]): string {
	const seen = new Set<string>();
	const labels: string[] = [];
	for (const l of laws) {
		const label = LAW_LABELS[l];
		if (label && !seen.has(label)) { seen.add(label); labels.push(label); }
	}
	return labels.length ? labels.join("・") : "関連法規";
}
```

At the bottom of the file, add (or extend) a test export:

```typescript
export const __test = { describeLegalAxis };
```

In `buildPrompt`, replace the hardcoded law names on the `1. legal:` line (currently line 215):

```typescript
1. legal: ${describeLegalAxis(rules.map((r) => r.law))}の違反疑い（上記NGの言い換え・優良誤認・No.1/最上級の根拠欠如等）。根拠資料があれば references に出典を付す。
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:compliance-legal-axis`
Expected: PASS.

- [ ] **Step 5: Regression — existing compliance tests still green + typecheck**

Run: `npm run test:compliance-lexicon && npx tsc --noEmit`
Expected: PASS, no new type errors. (Confirms the `__test` export + buildPrompt edit didn't break the module.)

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/check.ts scripts/test-compliance-legal-axis.ts package.json
git commit -m "feat(compliance): derive legal-axis law list from loaded rules (food-axis aware)"
```

---

### Task A5: B-5 텔롭·가격표시 검수 경로

현재 검수기는 발화(`markdown`)만 본다. 考査는 텔롭·가격표시·필수고지도 본다. 검수 입력에 `display`를 추가하고 프롬프트에 주입 + 결정론적 렉시콘 매칭도 텔롭에 적용한다.

**Files:**
- Modify: `lib/screenplay/compliance/check.ts` — `CheckOptions`에 `display` 추가, `buildPrompt`에 display 블록, `checkScreenplay`에서 텔롭에 렉시콘 매칭
- Create: `scripts/test-compliance-display.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `matchLexicon(text, rules, category)` (기존 `./lexicon-match`), `describeLegalAxis` (A4).
- Produces: `CheckOptions.display?: { telop?: string; priceShown?: string; requiredNotice?: string }`. `buildPrompt(markdown, brief, rules, references, evidence, display?)` — display가 있으면 `【画面表示（テロップ・価格・必須告知）】` 블록을 台本 앞에 삽입.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-compliance-display.ts`:

```typescript
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
```

- [ ] **Step 2: Add alias and run to verify it fails**

Add to `package.json`:

```json
"test:compliance-display": "tsx scripts/test-compliance-display.ts",
```

Run: `npm run test:compliance-display`
Expected: FAIL — `buildDisplayBlock` undefined.

- [ ] **Step 3: Implement display block + wire through**

In `lib/screenplay/compliance/check.ts`:

Add the pure builder (near `buildPrompt`):

```typescript
export interface DisplayInput { telop?: string; priceShown?: string; requiredNotice?: string }

export function buildDisplayBlock(display?: DisplayInput): string {
	if (!display) return "";
	const lines = [
		display.telop && `- テロップ: ${display.telop}`,
		display.priceShown && `- 価格表示: ${display.priceShown}`,
		display.requiredNotice && `- 必須告知: ${display.requiredNotice}`,
	].filter(Boolean);
	if (!lines.length) return "";
	return `【画面表示（テロップ・価格・必須告知）】\n${lines.join("\n")}`;
}
```

Extend `__test`:

```typescript
export const __test = { describeLegalAxis, buildDisplayBlock };
```

Add `display?: DisplayInput` to `CheckOptions` (near line 248):

```typescript
export interface CheckOptions {
	factSearch?: boolean;
	display?: DisplayInput;
}
```

In `buildPrompt`, accept a 6th param and insert the block before the 【台本】 section:

```typescript
function buildPrompt(
	markdown: string,
	brief: ProductBrief,
	rules: ComplianceRule[],
	references: ComplianceReference[],
	evidence: FactEvidence[],
	display?: DisplayInput,
): string {
	// ... existing ngList/okList/refBlock/evidenceBlock ...
	const displayBlock = buildDisplayBlock(display);
	// ... in the returned template, insert `${displayBlock ? displayBlock + "\n\n" : ""}` immediately before `【台本】` ...
```

In `checkScreenplay`, (a) pass `opts.display` into `buildPrompt(...)` at the call on line 303, and (b) run the deterministic lexicon over the telop too, merging into `legal`:

```typescript
const lexFindings = matchLexicon(markdown, rules, brief.category ?? null);
const telopFindings = opts.display?.telop
	? matchLexicon(opts.display.telop, rules, brief.category ?? null)
	: [];
// ... later, when composing legal:
const legal = dedupe([...lexFindings, ...telopFindings, ...llmLegal]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:compliance-display`
Expected: PASS.

- [ ] **Step 5: Regression + typecheck**

Run: `npm run test:compliance-lexicon && npx tsc --noEmit`
Expected: PASS. (Backward-compat: `display` is optional; existing callers pass none → `buildDisplayBlock` returns "" and telop findings are [].)

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/compliance/check.ts scripts/test-compliance-display.ts package.json
git commit -m "feat(compliance): add telop/price/notice display axis to check input"
```

---

### Task A6: B-1 테넌트별 문체 주입

전역 싱글턴 `_styleBible`(`prompt.ts:8-12`)이 하나의 style-bible만 캐시한다. 테넌트별 파일 로더로 교체(도쿄TV 문체 ≠ mediaworks 문체).

**Files:**
- Modify: `lib/screenplay/prompt.ts:6-13` (싱글턴 → 테넌트별 Map 캐시 + fallback), 및 `loadStyleBible` 호출부
- Create: `lib/screenplay/style/README.md` (테넌트 파일 규약 문서)
- Create: `scripts/test-style-bible-tenant.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `loadStyleBible(tenant?: string): Promise<string>` — `lib/screenplay/style/{tenant}.json`을 읽고, 없으면 기존 `lib/screenplay/style-bible.json`으로 fallback. 테넌트별 캐시.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-style-bible-tenant.ts`:

```typescript
import { __test } from "../lib/screenplay/prompt";
const { loadStyleBible } = __test;

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	const def = await loadStyleBible();               // default → falls back to style-bible.json
	assert(typeof def === "string" && def.length > 0, "default tenant loads the base style-bible");

	const missing = await loadStyleBible("__no_such_tenant__");
	assert(missing === def, "missing tenant file falls back to base style-bible");
}
main();
```

- [ ] **Step 2: Add alias and run to verify it fails**

Add to `package.json`:

```json
"test:style-bible-tenant": "tsx scripts/test-style-bible-tenant.ts",
```

Run: `npm run test:style-bible-tenant`
Expected: FAIL — `__test`/`loadStyleBible` not exported.

- [ ] **Step 3: Replace the singleton with a per-tenant loader**

In `lib/screenplay/prompt.ts`, replace lines 6-13:

```typescript
const STYLE_DIR = path.join(process.cwd(), "lib/screenplay/style");
const BASE_STYLE_BIBLE_PATH = path.join(process.cwd(), "lib/screenplay/style-bible.json");

const _styleCache = new Map<string, string>();

async function loadStyleBible(tenant: string = "mediaworks"): Promise<string> {
	const cached = _styleCache.get(tenant);
	if (cached) return cached;
	let content: string;
	try {
		content = await fs.readFile(path.join(STYLE_DIR, `${tenant}.json`), "utf-8");
	} catch {
		content = await fs.readFile(BASE_STYLE_BIBLE_PATH, "utf-8");   // fallback
	}
	_styleCache.set(tenant, content);
	return content;
}

export const __test = { loadStyleBible };
```

Update any existing `loadStyleBible()` call in this file to thread the tenant where available (default keeps current behavior). Run `git grep -n "loadStyleBible" -- lib/screenplay` and pass the tenant through the same way the generation entry point receives it (default `'mediaworks'` when absent).

- [ ] **Step 4: Add the style dir doc**

Create `lib/screenplay/style/README.md`:

```markdown
# Per-tenant style bibles

`loadStyleBible(tenant)` reads `{tenant}.json` here, falling back to
`../style-bible.json` when the tenant file is absent.

- `mediaworks` → falls back to the base `style-bible.json` (no override file).
- `tokyo_tv` → add `tokyo_tv.json` once Tokyo-TV past scripts (B-1) are ingested
  and a house-style profile is distilled from them.
```

- [ ] **Step 5: Run the test + typecheck**

Run: `npm run test:style-bible-tenant && npx tsc --noEmit`
Expected: PASS, no new type errors.

- [ ] **Step 6: Commit**

```bash
git add lib/screenplay/prompt.ts lib/screenplay/style/README.md scripts/test-style-bible-tenant.ts package.json
git commit -m "feat(screenplay): per-tenant style-bible loader with base fallback"
```

---

## §B 개요 — `tt_` 웨어하우스 + 일본어 매처 (독립, 데이터 무관)

STAGE 3의 순수 매처와 운영 기록 스키마. A와 병렬 가능.

- **B1 `tt_` 스키마 마이그레이션:** `tt_broadcasts`, `tt_products`, `tt_sales`, `tt_product_evidence`, `tt_broadcast_display`, `tt_call_stats`, `tt_ec_stats` (필드: spec §4.2). 재적재 멱등성 UNIQUE 키(spec §8.1): `tt_broadcasts(air_date,air_time,corner)`, `tt_sales(order_dt,product_ref,channel)`, `tt_call_stats(date,timeslot)`, `tt_ec_stats(date,timeslot)`. Group B RLS(member/admin). 검증: skip-guarded 라이브(A1 패턴).
- **B2 크로스워크 2테이블:** `tt_product_aliases`(raw_ref, source_type, canonical_product_id, match_method, confidence, confirmed_by), `tt_broadcast_links`(broadcast_id, linked_type, linked_id, match_method, confidence). 검증: 라이브.
- **B3 일본어 문자 n-gram 매처 (순수, 지금 TDD 가능):** `lib/tt/match/name-similarity.ts` — `normalize(s)`(NFKC + 全角半角 + 가나 폴딩 + 공백제거), `bigrams(s)`, `similarity(a,b)`(Dice 계수). `__test` export, DB-free 유닛(`scripts/test-tt-name-similarity.ts`). 테스트 케이스: 全角/半角 등가, ひらがな/カタカナ 등가, 브랜드 접두 부분일치. **architect 게이트 #3 해소.**
- **B4 4단 매칭 오케스트레이터:** `resolveProductRef(rawRef, candidates)` — Layer1 정확→Layer2 n-gram 제안(자동확정 금지)→미해결 플래그. 순수 함수 + 유닛.

의존: B3→B4. B1·B2는 독립. C가 B 전체에 의존.

## §C 개요 — STAGE 0~2 수집·추출·검수 (부분 블록)

- **C1 반입 vault + 파일해시 dedup (가능):** Supabase Storage 버킷 + `tt_intake_files`(sha256, source_type, tenant, status). 중복 해시 거부. 라이브 테스트.
- **C2 소스별 Gemini 추출 (실포맷 대기):** source_type별 목표 스키마 프롬프트 + `parseJSON`(check.ts 재사용 가능한 balanced-brace 스캐너). **실제 샘플 도착 후** 각 포맷 픽스처로 TDD. 지금은 스키마 계약만 정의.
- **C3 검수·확정 리뷰 UI (실레이아웃 대기):** 원본 옆 추출 초안 교정 화면(ja 단일 로케일, spec §8.1). 소스별×레이아웃별 템플릿 + 골든 픽스처 회귀.

의존: C1은 지금 가능. C2/C3는 도쿄TV 샘플 게이트.

## §D 개요 — STAGE 4 ⑤ 수요 예측 (전면 블록)

- **D1 방송×콜×EC 조인 뷰:** 크로스워크(B2) 시간창 조인으로 `"방송의 콜+EC 반응"` 시계열. 콜 입도 go/no-go(spec §8.2)에 따라 상품수준 vs 슬롯수준.
- **D2 예측 모델 + 인력 제안:** 시간대별 콜+EC 예측 → Erlang 인력 산출. 백테스트로 완성 판정(spec §7.4).

의존: 콜/EC 실데이터(C 적재) 필수. 데이터 도착 전 착수 불가.

---

## Self-Review

**Spec coverage (하위계획 A ↔ spec):**
- spec §2.5 테넌시 → A1(스키마)·A2(로드) ✅
- spec §2.6/§6.1 코드 드롭 4개 → 법령축 A3(스키마)+A4(프롬프트), 테넌시 A1+A2, B-5 A5, 문체 A6 ✅ (4개 모두 태스크 존재)
- spec §4.2b `law` CHECK 확장 → A3 ✅; UNIQUE에 tenant → A1 ✅; `tt_kousa_findings` 신규 → §C 로드맵(코퍼스 시드는 데이터 게이트) ⚠ 의도적 이연
- spec §5.1 일본어 매처 → §B3 개요(순수라 지금 가능하나 A 스코프 밖, B로 분리) ✅
- spec §8.1 멱등성 UNIQUE → §B1 개요 ✅

**Placeholder scan:** A1~A6 모든 코드 스텝에 실제 코드/SQL/명령·기대출력 포함. "적절한 에러처리" 류 없음. USER 적용 대기 스텝(A1 S4, A3 S5)은 마이그레이션 수동적용 제약(Global Constraints)의 정직한 반영이지 placeholder 아님.

**Type consistency:** `loadActiveRules`/`loadActiveReferences`의 `tenant?: string` 시그니처가 A2 정의 ↔ A2 사용 일치. `describeLegalAxis`(A4)·`buildDisplayBlock`(A5)·`loadStyleBible`(A6) 모두 `__test`로 export, 테스트의 구조분해와 일치. `DisplayInput`(A5)이 `CheckOptions.display`·`buildPrompt` 6번째 인자에서 동일 타입. `ComplianceLaw` 확장(A3)이 CHECK 확장(A3 SQL)과 동일 5개 멤버.

**Gaps 발견 → 처리:** 없음(모든 A 스코프 spec 요구가 태스크로 매핑됨). `tt_kousa_findings`·매처는 각각 §C·§B로 명시 이연.
