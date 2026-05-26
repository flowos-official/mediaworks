# 新規リサーチパイプライン — セキュリティ (Phase 4)

> **作成日**: 2026-05-26
> **ブランチ**: `research/security`
> **上位ロードマップ**: Phase 1 (データモデル整理) → Phase 2 (信頼性・運用) → Phase 3 (出力品質, `52fe670` マージ完了) → **Phase 4 (本書, セキュリティ)**

## 1. 背景 / 問題

Phase 1-3 でデータモデル・信頼性・出力品質を整えた後、セキュリティ監査で 7 件の実質リスクが見つかった。Phase 4 は High 3 件 + Medium 2 件を扱う。

### 対象リスク

- **A. Storage バケットが public** (`product-files` bucket)。URL guess で任意の attacker が PDF/PPTX/DOCX/画像 (供給元価格・取引先情報を含む) を取得可能。`supabase/migrations/2026-05-13_auth_storage.sql` のコメントが「Phase 5 will tighten」と明示。
- **B. `/api/analyze` の IDOR**。`requireUser(['member','admin'])` を通過した user-auth 経路で、`productId` の owner 検証なしに任意の row を上書き可能。同僚 product の損壊 + Gemini 予算消費。
- **C. `screenplays` / `screenplay_versions` テーブルに RLS なし**。`product_info_snapshot` JSONB を含むため抽出済み product 情報が viewer ロールに読まれる。
- **D. `/api/upload` の MIME 検証が advisory**。ブラウザ supplied `Content-Type` + 拡張子のみ。実ファイル magic-byte の検証なし。偽 PDF (実体は HTML) アップロード可能 → Gemini への prompt injection 経路。
- **E. `/api/analyze` の per-user rate limit なし**。認証済み member が並列で N 件投げて Gemini 予算を burn 可能。

### 非対象 (本 phase で扱わない)

- AWS credential `?? ""` fallback の正規化 (低リスク、maintenance 項目)
- `error_reason` の PII サニタイザ (Gemini error message が file 内容を echo するケースは稀)
- 依存パッケージのアップグレード (`@google/genai` 1.x→2.x など。一般 maintenance)
- multi-tenant isolation (single-tenant 運用継続)
- Admin retry API の cross-product 制限 (Phase 2 の意図された admin 道具)
- 外部 KV / Upstash の導入

## 2. 目標 / 非目標

### 目標
1. **Storage 잠금**: `product-files` バケットを private 化。`storage.objects` に member|admin の RLS を設置。`/api/upload` は public URL を発行せず、storage path のみを `file_url` に保存。
2. **`/api/analyze` IDOR 차단**: `products` に `created_by uuid` を追加。user-auth 経路で `created_by != auth.userId AND role != 'admin'` なら 403。
3. **`screenplays` / `screenplay_versions` RLS 부여**: Group B (member|admin only) 정책 추가.
4. **MIME magic-byte 검증**: `/api/upload` で実 byte 시그니처 확인. 미스마치/未지원 → 400.
5. **Rate limit**: Postgres カウント기반. inflight ≥ 3 또는 daily ≥ 20 → 429. Admin は bypass.

### 非目標

§1 의 "非対象" 모두.

## 3. A. Storage 잠금

### 3.1 マイグレーション `2026-05-26_storage_lock_product_files.sql`

```sql
BEGIN;

-- 1) bucket을 private 으로 전환. 기존 객체는 영향 없음 — 단지 public URL이 더 이상 작동 안 함.
UPDATE storage.buckets SET public = false WHERE id = 'product-files';

-- 2) storage.objects RLS (member/admin only)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "product_files_member_read"   ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_write"  ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_update" ON storage.objects;
DROP POLICY IF EXISTS "product_files_admin_delete"  ON storage.objects;

CREATE POLICY "product_files_member_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_member_write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_member_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'))
  WITH CHECK (bucket_id = 'product-files' AND public.current_user_role() IN ('member','admin'));

CREATE POLICY "product_files_admin_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-files' AND public.current_user_role() = 'admin');

COMMIT;
```

### 3.2 `app/api/upload/route.ts`

`getPublicUrl()` 호출 제거. `file_url` 에 storage path 만 저장:

```diff
- const { data: { publicUrl } } = supabase.storage.from('product-files').getPublicUrl(storageFileName);
- ... { file_url: publicUrl, file_name: ... }
+ // Phase 4: public URL を発行せず storage path のみ保存。
+ // 미래 consumer 는 createSignedProductFileUrl 로 resolve.
+ ... { file_url: storageFileName, file_name: ... }
```

### 3.3 신규 헬퍼 `lib/storage/signed-url.ts`

```ts
import "server-only";
import { getServiceClient } from "@/lib/supabase";

const DEFAULT_TTL_SEC = 3600; // 1h

/**
 * Resolve a storage path to a signed URL with TTL.
 * Server-only — never call from client components.
 */
export async function createSignedProductFileUrl(
  storagePath: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<string> {
  const sb = getServiceClient();
  const { data, error } = await sb.storage
    .from("product-files")
    .createSignedUrl(storagePath, ttlSec);
  if (error || !data) {
    throw new Error(`Failed to sign product-files URL '${storagePath}': ${error?.message ?? "unknown"}`);
  }
  return data.signedUrl;
}
```

### 3.4 영향 분석

- `getPublicUrl` 호출은 `app/api/upload/route.ts` 1 곳뿐 (grep 확인). 다른 `getPublicUrl` 사용은 `product-images`, `oa-images` 등 다른 bucket — 영향 없음.
- `products.file_url` / `product_files.file_url` 는 UI 어디서도 안 읽음 (write-only dead column). 마이그레이션 직후 기존 public URL 들이 작동 안 해도 user-facing 영향 없음.
- 기존 DB 의 public URL 값은 그대로 둠. 미래 backfill 필요 시 별도 스크립트.

## 4. B. `/api/analyze` IDOR 차단

### 4.1 マイグレーション `2026-05-26_products_created_by.sql`

```sql
BEGIN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);
COMMIT;
```

NOT NULL 강제하지 않음. 기존 row 와 cron 생성 row 는 NULL — application layer 에서 owner 판정.

### 4.2 `lib/supabase.ts::Product`

```diff
  updated_at: string;
+ created_by: string | null;
  created_at: string;
```

### 4.3 `app/api/upload/route.ts` — INSERT 시 owner 기록

```diff
  .insert({
    name: ...,
-   file_url: ...,
+   file_url: storageFileName,
    file_name: ...,
+   created_by: auth.userId,
    status: 'pending',
  })
```

### 4.4 `app/api/analyze/route.ts` — ownership 검증

기존:
```ts
const isInternal = hasInternalSecret(request);
if (!isInternal) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
}
const { productId, files, ... } = body;
```

이후 ownership block 추가:

```ts
if (!isInternal) {
  // 위에서 auth 이미 통과 — userId, role 사용 가능.
  const { data: prod, error: prodErr } = await supabase
    .from("products")
    .select("id, created_by")
    .eq("id", productId)
    .maybeSingle();
  if (prodErr) {
    console.error(`[${productId}] ownership lookup failed:`, prodErr);
    return NextResponse.json({ error: "product lookup failed" }, { status: 500 });
  }
  if (!prod) {
    return NextResponse.json({ error: "product not found" }, { status: 404 });
  }
  const isOwner = prod.created_by === auth.userId;
  const isAdmin = auth.role === "admin";
  if (!isOwner && !isAdmin) {
    console.warn(`[${productId}] analyze IDOR blocked: user=${auth.userId} owner=${prod.created_by}`);
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
}
```

`requireUser` 반환 객체에 `userId` 와 `role` 이 노출되는지 확인 — `lib/auth/require-user.ts` 가 이미 user 객체 반환. 필요 시 destructure 인라인.

### 4.5 영향 분석

- internal-secret 경로 (cron, `/api/upload` self-call) 우회 — Phase 2 와 동일 패턴.
- Admin retry API (`/api/admin/research-pipeline/retry`) 는 ownership check 없이 admin 만 통과 — 의도 유지.
- `created_by IS NULL` 인 구 row 에 user-auth 경로 시도 시 admin 만 통과. member 가 구 row 를 재분석하려면 admin 에 요청 (실질 거의 안 일어남, 대부분 completed).

## 5. C. screenplays / screenplay_versions RLS

### 5.1 マイグレーション `2026-05-26_screenplays_rls.sql`

```sql
BEGIN;
ALTER TABLE screenplays ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenplay_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "screenplays_member_read"        ON screenplays;
DROP POLICY IF EXISTS "screenplays_member_all"         ON screenplays;
DROP POLICY IF EXISTS "screenplay_versions_member_read" ON screenplay_versions;
DROP POLICY IF EXISTS "screenplay_versions_member_all"  ON screenplay_versions;

CREATE POLICY "screenplays_member_read" ON screenplays
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplays_member_all" ON screenplays
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('member','admin'))
  WITH CHECK (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplay_versions_member_read" ON screenplay_versions
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "screenplay_versions_member_all" ON screenplay_versions
  FOR ALL TO authenticated
  USING (public.current_user_role() IN ('member','admin'))
  WITH CHECK (public.current_user_role() IN ('member','admin'));

COMMIT;
```

### 5.2 영향 분석
- viewer 로그인 시 supabase-js client 로 직접 SELECT 시 차단.
- 기존 cron / screenplay 생성 라우트는 `getServiceClient()` → service-role bypass — 영향 없음.

## 6. D. MIME magic-byte validation

### 6.1 신규 헬퍼 `lib/upload/magic-bytes.ts`

```ts
const SIGNATURES: Array<{ mime: string; magic: number[]; offset?: number }> = [
  { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },                              // %PDF
  { mime: "image/png",       magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },     // PNG
  { mime: "image/jpeg",      magic: [0xff, 0xd8, 0xff] },                                    // JPEG
  { mime: "image/gif",       magic: [0x47, 0x49, 0x46, 0x38] },                              // GIF8
  { mime: "image/webp",      magic: [0x52, 0x49, 0x46, 0x46] },                              // RIFF (+ WEBP at +8)
  { mime: "application/zip", magic: [0x50, 0x4b, 0x03, 0x04] },                              // ZIP (OOXML)
  { mime: "application/x-cfb", magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },   // OLE2 (legacy Office)
];

const OOXML_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const LEGACY_OFFICE_MIMES = new Set([
  "application/vnd.ms-powerpoint",
  "application/msword",
  "application/vnd.ms-excel",
]);

export type MimeCheckResult =
  | { kind: "match"; detectedMime: string }
  | { kind: "mismatch"; detectedMime: string; declaredMime: string }
  | { kind: "unsupported"; declaredMime: string };

export function checkMagicBytes(bytes: Buffer, declaredMime: string): MimeCheckResult {
  if (bytes.length < 12) return { kind: "unsupported", declaredMime };

  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    const match = sig.magic.every((b, i) => bytes[offset + i] === b);
    if (!match) continue;

    if (sig.mime === "image/webp") {
      const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isWebp) continue;
    }

    if (sig.mime === "application/zip") {
      if (OOXML_MIMES.has(declaredMime)) return { kind: "match", detectedMime: declaredMime };
      return { kind: "mismatch", detectedMime: "application/zip", declaredMime };
    }

    if (sig.mime === "application/x-cfb") {
      if (LEGACY_OFFICE_MIMES.has(declaredMime)) return { kind: "match", detectedMime: declaredMime };
      return { kind: "mismatch", detectedMime: "application/x-cfb", declaredMime };
    }

    if (declaredMime === sig.mime) return { kind: "match", detectedMime: sig.mime };
    return { kind: "mismatch", detectedMime: sig.mime, declaredMime };
  }

  return { kind: "unsupported", declaredMime };
}
```

### 6.2 `app/api/upload/route.ts` — 검증 삽입

`fileBytes = Buffer.from(await file.arrayBuffer())` 직후, storage upload 직전에 삽입:

```ts
import { checkMagicBytes } from "@/lib/upload/magic-bytes";

const check = checkMagicBytes(fileBytes, mimeType);
if (check.kind === "unsupported") {
  console.warn(`[upload] rejected ${file.name}: unsupported magic bytes (declared ${mimeType})`);
  return NextResponse.json(
    { error: `Unsupported file content: ${file.name}` },
    { status: 400 },
  );
}
if (check.kind === "mismatch") {
  console.warn(`[upload] rejected ${file.name}: declared ${mimeType} but bytes look like ${check.detectedMime}`);
  return NextResponse.json(
    { error: `File content does not match declared type for ${file.name}` },
    { status: 400 },
  );
}
```

### 6.3 영향 분석
- 합법 업로드 (PDF/PNG/JPG/GIF/WEBP/PPTX/DOCX/XLSX/PPT/DOC/XLS) 모두 통과.
- 가짜 확장자 / 가짜 Content-Type 업로드 400.
- 매우 작은 (<12 bytes) 파일도 unsupported 로 reject — 정상 사용에 영향 없음.

## 7. E. Per-user rate limit

### 7.1 신규 헬퍼 `lib/research/analyze-rate-limit.ts`

```ts
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_INFLIGHT_PER_USER = Number(process.env.ANALYZE_MAX_INFLIGHT_PER_USER ?? "3");
const MAX_DAILY_PER_USER = Number(process.env.ANALYZE_MAX_DAILY_PER_USER ?? "20");

export type RateLimitResult =
  | { kind: "ok" }
  | { kind: "inflight_exceeded"; current: number; max: number }
  | { kind: "daily_exceeded"; current: number; max: number };

export async function checkAnalyzeRateLimit(
  sb: SupabaseClient,
  userId: string,
  role: "member" | "admin",
): Promise<RateLimitResult> {
  if (role === "admin") return { kind: "ok" };

  const { count: inflightCount, error: inflightErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .in("status", ["pending", "analyzing"]);
  if (inflightErr) throw inflightErr;
  const inflight = inflightCount ?? 0;
  if (inflight >= MAX_INFLIGHT_PER_USER) {
    return { kind: "inflight_exceeded", current: inflight, max: MAX_INFLIGHT_PER_USER };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dailyCount, error: dailyErr } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .gt("created_at", since);
  if (dailyErr) throw dailyErr;
  const daily = dailyCount ?? 0;
  if (daily >= MAX_DAILY_PER_USER) {
    return { kind: "daily_exceeded", current: daily, max: MAX_DAILY_PER_USER };
  }

  return { kind: "ok" };
}
```

### 7.2 `app/api/upload/route.ts` — auth 통과 직후, INSERT 직전 적용

```ts
import { checkAnalyzeRateLimit } from "@/lib/research/analyze-rate-limit";

const auth = await requireUser(['member','admin']);
if ('error' in auth) return auth.error;

const rateCheck = await checkAnalyzeRateLimit(auth.sb, auth.userId, auth.role);
if (rateCheck.kind !== 'ok') {
  console.warn(`[upload] rate limit ${rateCheck.kind} for user=${auth.userId}: ${rateCheck.current}/${rateCheck.max}`);
  const msg = rateCheck.kind === 'inflight_exceeded'
    ? `現在分析中の商品が ${rateCheck.current} 件あります (上限 ${rateCheck.max} 件)。完了後に再度お試しください。`
    : `本日のアップロード上限 (${rateCheck.max} 件/24h) に達しました。明日以降お試しください。`;
  return NextResponse.json({ error: msg, code: rateCheck.kind }, { status: 429 });
}
```

### 7.3 영향 분석
- Member 의 inflight ≥ 3 또는 daily ≥ 20 → 429 + 일본어 메시지.
- Admin 은 항상 통과 (운영자 restoration 작업 대비).
- internal-secret 경로 (cron) 는 이 helper 호출 안 함.
- `created_by IS NULL` 인 구 row 는 count 에 포함 안 됨 — 마이그레이션 직후 카운터 깨끗.

### 7.4 env vars
- `ANALYZE_MAX_INFLIGHT_PER_USER` (default 3)
- `ANALYZE_MAX_DAILY_PER_USER` (default 20)

`CLAUDE.md` 에 한 줄 추가.

## 8. 검증 / smokes

### 신규 스크립트

1. **`scripts/test-magic-bytes.ts`** (pure unit) — 6 케이스:
   - PDF magic + declared PDF → match
   - HTML payload + declared PDF → mismatch/unsupported
   - PNG magic + declared PNG → match
   - ZIP magic + declared PPTX → match
   - ZIP magic + declared PDF → mismatch
   - 짧은 버퍼 (<12 bytes) → unsupported

2. **`scripts/test-analyze-ownership.ts`** (live DB) — 4 케이스:
   - user A 가 user A 의 productId 로 analyze → owner 통과
   - user A 가 user B 의 productId 로 analyze → 403
   - admin 이 임의 productId → 통과
   - internal-secret 경로 → ownership check skip
   - 끝나면 temp row + temp profiles 정리

3. **`scripts/test-analyze-rate-limit.ts`** (live DB) — 4 케이스:
   - inflight=2 → ok
   - inflight=3 → inflight_exceeded
   - daily=20 → daily_exceeded
   - role=admin → 무조건 ok
   - cleanup

4. **`scripts/test-storage-signed-url.ts`** (live DB) — 2 케이스:
   - `createSignedProductFileUrl` 가 유효 URL 반환
   - bucket public URL (이미 발급된 형식) 으로 직접 GET 시 403/404 확인

### `package.json` 신규 entry
```json
"test:magic-bytes": "tsx scripts/test-magic-bytes.ts",
"test:analyze-ownership": "tsx --env-file=.env.local scripts/test-analyze-ownership.ts",
"test:analyze-rate-limit": "tsx --env-file=.env.local scripts/test-analyze-rate-limit.ts",
"test:storage-signed-url": "tsx --env-file=.env.local scripts/test-storage-signed-url.ts"
```

### Phase 1-3 회귀
- `npm run test:research-data-model` PASS 유지
- `npm run test:research-stuck-detector` PASS 유지
- Phase 3 의 7 smokes 모두 PASS 유지

## 9. 배포 순서

1. **dev DB 적용** (의존성 없음, 순서 자유):
   - Migration 1 — storage lock
   - Migration 2 — products.created_by
   - Migration 3 — screenplays RLS
2. **dev smoke 검증** (4 신규 smoke 통과 + 기존 smoke 회귀 통과)
3. **코드 배포**: upload (magic-byte + rate limit + created_by) + analyze (ownership) + signed-url helper + Product type
4. **운영 모니터링**: Vercel 배포 후 24시간 admin pipeline + Vercel logs 의 신규 403/429 추적

## 10. 리스크 / 미해결

- **`created_by IS NULL` 인 구 row**: Member 가 user-auth 경로로 재분석 시도 시 admin 만 통과. 실질 영향 미미. 운영자가 backfill 원하면 별도 SQL.
- **Storage public URL 의 외부 캐싱**: 이미 발급된 public URL 이 browser cache / 로그 / 백업에 남아 있을 수 있음. 마이그레이션 후 즉시 invalidate. UI 에서 안 쓰므로 user-facing 영향 미미.
- **Magic-byte 우회**: PDF magic 으로 시작하는 악성 페이로드는 통과 가능. 본 phase 는 "캐주얼 가짜 확장자 차단" 까지. 본격 sandboxing 은 비목표.
- **Rate limit 우회**: 동일 user 가 여러 account 보유 시 우회 가능. Single-tenant 운영의 의도된 한계.
- **`screenplays` 마이그레이션 후 viewer 영향**: viewer 가 screenplays 를 읽는 경로 없음 (grep 확인). 안전.

## 11. 영향 없는 영역 (의도적 비변경)

- Phase 1-3 의 마이그레이션 / 모든 컬럼 / 모든 smoke 변경 없음.
- Discovery / Strategy / Broadcasts / Pipeline 주요 모듈 영향 없음.
- Admin retry API + trigger-detection API 영향 없음.
- Synthesize / extract / expansion 로직 영향 없음.
- 다른 buckets (`product-images`, `oa-images` 등) 영향 없음.
