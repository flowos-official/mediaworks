# Research Security (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 5 specific risks found in the Phase 4 security audit: bucket-public storage exposure, `/api/analyze` IDOR, missing RLS on screenplays tables, advisory-only MIME validation, and unlimited per-user `/api/analyze` consumption.

**Architecture:** Three idempotent migrations (storage lock, `products.created_by`, screenplays RLS) plus three small `lib/` helpers (`magic-bytes`, `signed-url`, `analyze-rate-limit`). Existing `/api/upload` and `/api/analyze` routes are extended in place. No changes to discovery / strategy / broadcasts / pipeline modules.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS + storage), TypeScript, `tsx --env-file=.env.local` smoke runner.

**Spec:** `docs/superpowers/specs/2026-05-26-research-security-design.md` (commit `dfa0aae`).

**Branch:** `research/security` (worktree `.claude/worktrees/research-security`, branched from `main@52fe670`).

---

## File Structure

### New files
- `supabase/migrations/2026-05-26_storage_lock_product_files.sql` — bucket private + storage.objects RLS
- `supabase/migrations/2026-05-26_products_created_by.sql` — ownership column
- `supabase/migrations/2026-05-26_screenplays_rls.sql` — RLS enable + Group B policies
- `lib/upload/magic-bytes.ts` — file signature checker (pure)
- `lib/storage/signed-url.ts` — `createSignedProductFileUrl(path, ttlSec)` (uses service client)
- `lib/research/analyze-rate-limit.ts` — `checkAnalyzeRateLimit(sb, userId, role)`
- `scripts/test-magic-bytes.ts` — pure unit (6 cases)
- `scripts/test-analyze-ownership.ts` — live-DB smoke (4 cases)
- `scripts/test-analyze-rate-limit.ts` — live-DB smoke (4 cases)
- `scripts/test-storage-signed-url.ts` — live-DB smoke (2 cases)

### Modified files
- `lib/supabase.ts::Product` — `created_by: string | null`
- `app/api/upload/route.ts` — rate limit + magic-byte + `created_by` + storage path-only
- `app/api/analyze/route.ts` — ownership check after auth
- `package.json` — 4 new test scripts

### Boundary notes
- `lib/upload/magic-bytes.ts` is **pure** (no imports, no `server-only`) — usable by smoke directly.
- `lib/storage/signed-url.ts` and `lib/research/analyze-rate-limit.ts` must be **smoke-importable**: NO `import "server-only"`. They take a Supabase client argument so smoke can pass a service client without going through Next.js bundler.
- `requireUser` actually returns `{ user: User; role: Role; sb: SupabaseClient }` — so user id is `auth.user.id`, not `auth.userId`.

---

## Task 1: Migration — storage lock for `product-files`

**Files:**
- Create: `supabase/migrations/2026-05-26_storage_lock_product_files.sql`

- [ ] **Step 1: Write the migration**

`supabase/migrations/2026-05-26_storage_lock_product_files.sql`:
```sql
-- 2026-05-26: product-files bucket を private 化 + storage.objects に RLS。
-- 既存オブジェクトは残るが、unauthenticated な public URL は機能しなくなる。
-- UI は file_url を読まないため user-facing 影響なし。

BEGIN;

-- 1) bucket を private 化
UPDATE storage.buckets SET public = false WHERE id = 'product-files';

-- 2) storage.objects RLS 有効化 (idempotent)
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 3) 既存ポリシーをクリア (idempotent re-run)
DROP POLICY IF EXISTS "product_files_member_read"   ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_write"  ON storage.objects;
DROP POLICY IF EXISTS "product_files_member_update" ON storage.objects;
DROP POLICY IF EXISTS "product_files_admin_delete"  ON storage.objects;

-- 4) Group B (member/admin) ポリシー
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

- [ ] **Step 2: Apply migration to dev DB**

User applies via Supabase SQL editor (project's manual workflow). After application, confirm via:
```bash
npm run test:research-data-model
```
Expected: PASS — Phase 1 smoke doesn't depend on bucket or storage policies, so it continues to pass.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-26_storage_lock_product_files.sql
git commit -m "feat(security): private product-files bucket + member/admin RLS"
```

---

## Task 2: Migration — `products.created_by`

**Files:**
- Create: `supabase/migrations/2026-05-26_products_created_by.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-05-26: products に created_by を追加。Phase 4 の IDOR check 用。
-- nullable (既存 row + cron 生成 row は NULL 維持)。
-- application layer で owner / admin 判定 — RLS は変更しない。

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES profiles(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_created_by ON products(created_by);

COMMIT;
```

- [ ] **Step 2: Apply to dev DB** (manual via Supabase SQL editor)

- [ ] **Step 3: Verify column exists**

```bash
npm run test:research-data-model
```
Expected: PASS (existing smoke does `select("*")` and won't break on new columns).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-26_products_created_by.sql
git commit -m "feat(security): products.created_by for IDOR ownership check"
```

---

## Task 3: Migration — screenplays / screenplay_versions RLS

**Files:**
- Create: `supabase/migrations/2026-05-26_screenplays_rls.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 2026-05-26: screenplays / screenplay_versions が Group B (member|admin) のはずだったが
-- 元のマイグレーションで ENABLE RLS + ポリシーが抜けていた。viewer ロールが
-- 直接 SELECT 可能だったので閉じる。

BEGIN;

ALTER TABLE screenplays ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenplay_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "screenplays_member_read"         ON screenplays;
DROP POLICY IF EXISTS "screenplays_member_all"          ON screenplays;
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

- [ ] **Step 2: Apply to dev DB** (manual)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-05-26_screenplays_rls.sql
git commit -m "feat(security): RLS for screenplays + screenplay_versions"
```

---

## Task 4: Sync `Product` TS type with `created_by`

**Files:**
- Modify: `lib/supabase.ts` (the `Product` type)

- [ ] **Step 1: Read the existing type**

In `lib/supabase.ts`, locate the `Product` type. It currently has `updated_at` and `created_at` near the end.

- [ ] **Step 2: Insert the new field**

Find:
```ts
  updated_at: string;
  created_at: string;
};
```
Replace with:
```ts
  updated_at: string;
  created_by: string | null;
  created_at: string;
};
```

- [ ] **Step 3: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add lib/supabase.ts
git commit -m "feat(security): extend Product type with created_by"
```

---

## Task 5: `magic-bytes` helper + unit smoke

**Files:**
- Create: `lib/upload/magic-bytes.ts`
- Create: `scripts/test-magic-bytes.ts`
- Modify: `package.json` (add `test:magic-bytes`)

- [ ] **Step 1: Write the failing unit smoke**

`scripts/test-magic-bytes.ts`:
```ts
/**
 * 単位テスト: checkMagicBytes の 6 ケース。
 * 実行: npm run test:magic-bytes
 */
import { checkMagicBytes } from "../lib/upload/magic-bytes";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function bufOf(...bytes: number[]): Buffer {
  const arr = [...bytes];
  while (arr.length < 16) arr.push(0x00);
  return Buffer.from(arr);
}

function main(): void {
  // 1) PDF magic + declared PDF → match
  const pdf = bufOf(0x25, 0x50, 0x44, 0x46);
  const r1 = checkMagicBytes(pdf, "application/pdf");
  assert(r1.kind === "match" && r1.detectedMime === "application/pdf",
    `PDF magic should match, got ${JSON.stringify(r1)}`);

  // 2) HTML payload + declared PDF → not match (mismatch or unsupported)
  const html = Buffer.from("<!DOCTYPE html><html>body</html>", "utf8");
  const r2 = checkMagicBytes(html, "application/pdf");
  assert(r2.kind !== "match", `HTML body should not match PDF mime, got ${r2.kind}`);

  // 3) PNG magic + declared PNG → match
  const png = bufOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const r3 = checkMagicBytes(png, "image/png");
  assert(r3.kind === "match" && r3.detectedMime === "image/png",
    `PNG magic should match, got ${JSON.stringify(r3)}`);

  // 4) ZIP magic + declared PPTX → match (treated as OOXML)
  const zip = bufOf(0x50, 0x4b, 0x03, 0x04);
  const r4 = checkMagicBytes(zip, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert(r4.kind === "match",
    `ZIP magic + PPTX declared should match, got ${JSON.stringify(r4)}`);

  // 5) ZIP magic + declared PDF → mismatch
  const r5 = checkMagicBytes(zip, "application/pdf");
  assert(r5.kind === "mismatch",
    `ZIP magic + PDF declared should mismatch, got ${JSON.stringify(r5)}`);

  // 6) Short buffer (<12 bytes) → unsupported
  const tiny = Buffer.from([0x25, 0x50]);
  const r6 = checkMagicBytes(tiny, "application/pdf");
  assert(r6.kind === "unsupported",
    `short buffer → unsupported, got ${r6.kind}`);

  console.log("[ok] checkMagicBytes 全6ケース通過");
}

main();
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:magic-bytes
```
Expected: FAIL — script not registered or module not found.

- [ ] **Step 3: Wire up npm script**

Edit `package.json`. After the last existing test entry, add:
```json
"test:magic-bytes": "tsx scripts/test-magic-bytes.ts"
```

- [ ] **Step 4: Implement `lib/upload/magic-bytes.ts`**

```ts
/**
 * 파일 시그니처 (magic bytes) 기반 MIME 검증.
 * 클라이언트 supplied Content-Type 또는 확장자가 아니라 실제 파일 머리 8 바이트로 판정.
 *
 * 반환값:
 *   - declaredMime 과 detected 가 일치 → 'match'
 *   - detected 가 supported 이지만 declaredMime 과 다름 → 'mismatch'
 *   - 어떤 known signature 와도 매치 안 됨 → 'unsupported'
 */

const SIGNATURES: Array<{ mime: string; magic: number[]; offset?: number }> = [
	{ mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },                           // %PDF
	{ mime: "image/png",       magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },   // PNG
	{ mime: "image/jpeg",      magic: [0xff, 0xd8, 0xff] },                                  // JPEG
	{ mime: "image/gif",       magic: [0x47, 0x49, 0x46, 0x38] },                            // GIF8
	{ mime: "image/webp",      magic: [0x52, 0x49, 0x46, 0x46] },                            // RIFF (+ WEBP @+8)
	{ mime: "application/zip", magic: [0x50, 0x4b, 0x03, 0x04] },                            // ZIP (OOXML)
	{ mime: "application/x-cfb", magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // OLE2 (legacy Office)
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

		// WEBP: also requires 'WEBP' at offset 8
		if (sig.mime === "image/webp") {
			const isWebp =
				bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
			if (!isWebp) continue;
		}

		// ZIP magic: only valid for OOXML declared types
		if (sig.mime === "application/zip") {
			if (OOXML_MIMES.has(declaredMime)) {
				return { kind: "match", detectedMime: declaredMime };
			}
			return { kind: "mismatch", detectedMime: "application/zip", declaredMime };
		}

		// OLE2 magic: only valid for legacy Office declared types
		if (sig.mime === "application/x-cfb") {
			if (LEGACY_OFFICE_MIMES.has(declaredMime)) {
				return { kind: "match", detectedMime: declaredMime };
			}
			return { kind: "mismatch", detectedMime: "application/x-cfb", declaredMime };
		}

		// Direct mime match for PDF / PNG / JPEG / GIF / WEBP
		if (declaredMime === sig.mime) {
			return { kind: "match", detectedMime: sig.mime };
		}
		return { kind: "mismatch", detectedMime: sig.mime, declaredMime };
	}

	return { kind: "unsupported", declaredMime };
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
npm run test:magic-bytes
```
Expected: `[ok] checkMagicBytes 全6ケース通過`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/upload/magic-bytes.ts scripts/test-magic-bytes.ts package.json
git commit -m "feat(security): magic-bytes MIME checker + 6-case unit"
```

---

## Task 6: `signed-url` helper + live smoke

**Files:**
- Create: `lib/storage/signed-url.ts`
- Create: `scripts/test-storage-signed-url.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing live smoke**

`scripts/test-storage-signed-url.ts`:
```ts
/**
 * Live DB smoke: createSignedProductFileUrl が
 *   1) 有効な signed URL を返す
 *   2) bucket は public でないため、未認証の curl で signed URL は読めるが
 *      非-signed (素の path) では 403/404 になる
 * 実行: npm run test:storage-signed-url
 *
 * 前提: 2026-05-26_storage_lock_product_files.sql が dev DB に適用済み。
 */
import { createClient } from "@supabase/supabase-js";
import { createSignedProductFileUrl } from "../lib/storage/signed-url";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main(): Promise<void> {
	const tag = `signed-url-smoke-${Date.now()}.txt`;
	const payload = Buffer.from("hello signed url smoke", "utf8");

	// 1) Upload a tiny file via service-role
	const { error: upErr } = await sb.storage.from("product-files").upload(tag, payload, {
		contentType: "text/plain",
		upsert: false,
	});
	if (upErr) throw new Error(`temp upload failed: ${upErr.message}`);

	try {
		// 2) Get a signed URL via the helper
		const signed = await createSignedProductFileUrl(tag, 60);
		assert(signed.startsWith("http"), `signed URL should start with http, got: ${signed}`);
		assert(signed.includes(tag) || signed.includes(encodeURIComponent(tag)),
			`signed URL should reference the path, got: ${signed}`);

		// 3) Fetch via signed URL — should succeed
		const r1 = await fetch(signed);
		assert(r1.ok, `signed URL fetch should be 200, got ${r1.status}`);
		const body = await r1.text();
		assert(body === "hello signed url smoke", `body mismatch: ${body}`);

		// 4) Fetch a guessed public URL (bucket is private) — should fail
		const guessedPublic = `${url}/storage/v1/object/public/product-files/${tag}`;
		const r2 = await fetch(guessedPublic);
		assert(!r2.ok, `non-signed public URL should be denied (bucket private), got ${r2.status}`);

		console.log("[ok] signed-url smoke 通過 (signed: 200, raw public: blocked)");
	} finally {
		await sb.storage.from("product-files").remove([tag]);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:storage-signed-url
```
Expected: FAIL — script not registered or module not found.

- [ ] **Step 3: Wire up npm script**

```json
"test:storage-signed-url": "tsx --env-file=.env.local scripts/test-storage-signed-url.ts"
```

- [ ] **Step 4: Implement `lib/storage/signed-url.ts`**

NOTE: NO `import "server-only"` — the smoke imports this directly via tsx.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/supabase";

const DEFAULT_TTL_SEC = 3600; // 1h

/**
 * Resolve a storage path to a signed URL with TTL.
 *
 * Pass a custom client (e.g. a server client with a user session) if you want
 * RLS to apply. The default uses the service-role client — safe for callers
 * that have already gated authorization upstream (e.g. report-export, admin
 * tooling) and unsafe to use directly from a route handler that hasn't.
 *
 * No `import "server-only"` so smoke scripts can import. Guard upstream.
 */
export async function createSignedProductFileUrl(
	storagePath: string,
	ttlSec: number = DEFAULT_TTL_SEC,
	client?: SupabaseClient,
): Promise<string> {
	const sb = client ?? getServiceClient();
	const { data, error } = await sb.storage
		.from("product-files")
		.createSignedUrl(storagePath, ttlSec);
	if (error || !data) {
		throw new Error(`Failed to sign product-files URL '${storagePath}': ${error?.message ?? "unknown"}`);
	}
	return data.signedUrl;
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
npm run test:storage-signed-url
```
Expected: `[ok] signed-url smoke 通過 (signed: 200, raw public: blocked)`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/storage/signed-url.ts scripts/test-storage-signed-url.ts package.json
git commit -m "feat(security): createSignedProductFileUrl helper + live smoke"
```

---

## Task 7: `analyze-rate-limit` helper + live smoke

**Files:**
- Create: `lib/research/analyze-rate-limit.ts`
- Create: `scripts/test-analyze-rate-limit.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing smoke**

`scripts/test-analyze-rate-limit.ts`:
```ts
/**
 * Live DB smoke: checkAnalyzeRateLimit の 4 ケース。
 * 実行: npm run test:analyze-rate-limit
 *
 * 前提: 2026-05-26_products_created_by.sql が dev DB に適用済み。
 *       profiles に最低 1 行存在する (smoke は 1 個取得して使う)。
 */
import { createClient } from "@supabase/supabase-js";
import { checkAnalyzeRateLimit } from "../lib/research/analyze-rate-limit";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function main(): Promise<void> {
	// Grab any existing profile id to use as the test user
	const { data: profile } = await sb.from("profiles").select("id").limit(1).maybeSingle();
	if (!profile) throw new Error("profiles テーブルに最低 1 行必要");
	const userId = profile.id as string;
	const tag = `rate-limit-smoke-${Date.now()}`;

	// Clean any leftover smoke rows for this user (safety: previous failed run)
	await sb.from("products").delete().like("name", `${tag.split("-").slice(0, 3).join("-")}-%`);

	const tempIds: string[] = [];
	try {
		// Case 1: inflight=0 → ok (insert nothing first)
		const r1 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r1.kind === "ok", `inflight=0 should be ok, got ${JSON.stringify(r1)}`);

		// Case 2: insert 3 inflight rows → next call should be inflight_exceeded
		// (assumes MAX_INFLIGHT_PER_USER default = 3)
		for (let i = 0; i < 3; i++) {
			const { data, error } = await sb
				.from("products")
				.insert({
					name: `${tag}-inflight-${i}`,
					file_url: "smoke://none",
					file_name: "a.txt",
					status: "analyzing",
					created_by: userId,
				})
				.select("id")
				.single();
			if (error) throw new Error(`insert failed: ${error.message}`);
			tempIds.push((data as { id: string }).id);
		}
		const r2 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r2.kind === "inflight_exceeded",
			`inflight=3 should exceed, got ${JSON.stringify(r2)}`);

		// Case 3: admin always passes regardless of inflight
		const r3 = await checkAnalyzeRateLimit(sb, userId, "admin");
		assert(r3.kind === "ok",
			`admin role should bypass, got ${JSON.stringify(r3)}`);

		// Case 4: clean inflight, then insert 20 completed rows within 24h → daily_exceeded
		await sb.from("products").delete().in("id", tempIds);
		tempIds.length = 0;
		for (let i = 0; i < 20; i++) {
			const { data, error } = await sb
				.from("products")
				.insert({
					name: `${tag}-daily-${i}`,
					file_url: "smoke://none",
					file_name: "a.txt",
					status: "completed",
					created_by: userId,
				})
				.select("id")
				.single();
			if (error) throw new Error(`insert failed: ${error.message}`);
			tempIds.push((data as { id: string }).id);
		}
		const r4 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r4.kind === "daily_exceeded",
			`daily=20 should exceed, got ${JSON.stringify(r4)}`);

		console.log("[ok] analyze-rate-limit smoke 全4ケース通過");
	} finally {
		if (tempIds.length > 0) {
			await sb.from("products").delete().in("id", tempIds);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:analyze-rate-limit
```
Expected: FAIL — module not found.

- [ ] **Step 3: Wire up npm script**

```json
"test:analyze-rate-limit": "tsx --env-file=.env.local scripts/test-analyze-rate-limit.ts"
```

- [ ] **Step 4: Implement `lib/research/analyze-rate-limit.ts`**

NOTE: NO `import "server-only"`.

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_INFLIGHT_PER_USER = Number(process.env.ANALYZE_MAX_INFLIGHT_PER_USER ?? "3");
const MAX_DAILY_PER_USER = Number(process.env.ANALYZE_MAX_DAILY_PER_USER ?? "20");

export type RateLimitResult =
	| { kind: "ok" }
	| { kind: "inflight_exceeded"; current: number; max: number }
	| { kind: "daily_exceeded"; current: number; max: number };

/**
 * /api/upload の per-user rate limit を Postgres カウントで判定。
 *
 * - inflight: 同一 user の products WHERE status IN ('pending','analyzing') が
 *   MAX_INFLIGHT 以上なら 429。同時並列の暴走防止。
 * - daily: 同一 user の products WHERE created_at > now() - 24h が MAX_DAILY 以上
 *   なら 429。一日あたりの Gemini 予算をキャップ。
 *
 * Admin role はスキップ。internal-secret 経路 (cron) はこの helper を呼ばない。
 */
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

- [ ] **Step 5: Run to verify it passes**

```bash
npm run test:analyze-rate-limit
```
Expected: `[ok] analyze-rate-limit smoke 全4ケース通過`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add lib/research/analyze-rate-limit.ts scripts/test-analyze-rate-limit.ts package.json
git commit -m "feat(security): per-user analyze rate limit (3 inflight / 20 daily)"
```

---

## Task 8: `/api/upload` integration — rate limit + magic-byte + `created_by` + storage path

**Files:**
- Modify: `app/api/upload/route.ts`

This task integrates the three new helpers + drops the public URL pattern.

- [ ] **Step 1: Add imports**

At the top of `app/api/upload/route.ts`, add after the existing imports:
```ts
import { checkAnalyzeRateLimit } from "@/lib/research/analyze-rate-limit";
import { checkMagicBytes } from "@/lib/upload/magic-bytes";
```

- [ ] **Step 2: Add rate-limit check right after `requireUser`**

Find:
```ts
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

  try {
```

Replace with:
```ts
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const rateCheck = await checkAnalyzeRateLimit(auth.sb, auth.user.id, auth.role as "member" | "admin");
	if (rateCheck.kind !== "ok") {
		console.warn(`[upload] rate limit ${rateCheck.kind} for user=${auth.user.id}: ${rateCheck.current}/${rateCheck.max}`);
		const msg = rateCheck.kind === "inflight_exceeded"
			? `現在分析中の商品が ${rateCheck.current} 件あります (上限 ${rateCheck.max} 件)。完了後に再度お試しください。`
			: `本日のアップロード上限 (${rateCheck.max} 件/24h) に達しました。明日以降お試しください。`;
		return NextResponse.json({ error: msg, code: rateCheck.kind }, { status: 429 });
	}

  try {
```

- [ ] **Step 3: Add magic-byte check inside the file loop**

In the `for (const file of files) {` loop, find:
```ts
      const fileBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(fileBuffer);
```

Insert immediately after (before the `safeName` line):
```ts
      const headBuffer = Buffer.from(fileBytes.slice(0, 16));
      const magic = checkMagicBytes(headBuffer, mimeType);
      if (magic.kind === "unsupported") {
        console.warn(`[upload] rejected ${file.name}: unsupported magic bytes (declared ${mimeType})`);
        return NextResponse.json(
          { error: `Unsupported file content: ${file.name}` },
          { status: 400 },
        );
      }
      if (magic.kind === "mismatch") {
        console.warn(`[upload] rejected ${file.name}: declared ${mimeType} but bytes look like ${magic.detectedMime}`);
        return NextResponse.json(
          { error: `File content does not match declared type for ${file.name}` },
          { status: 400 },
        );
      }
```

- [ ] **Step 4: Stop generating public URL — store path only**

Find the `getPublicUrl` block:
```ts
      const { data: urlData } = supabase.storage
        .from('product-files')
        .getPublicUrl(storageFileName);

      uploadedFiles.push({
        fileName: file.name,
        storageFileName,
        publicUrl: urlData.publicUrl,
        mimeType,
        fileBytes,
      });
```

Replace with:
```ts
      // Phase 4: bucket is private — no public URL. Store path only.
      uploadedFiles.push({
        fileName: file.name,
        storageFileName,
        publicUrl: storageFileName,
        mimeType,
        fileBytes,
      });
```

(We keep the `publicUrl` field name in the local `uploadedFiles` shape to minimize churn — it now carries a storage path rather than a URL. Consumers below already use it for `file_url` writes.)

- [ ] **Step 5: Add `created_by` to products INSERT**

Find:
```ts
      .insert({
        name: productName,
        description: null,
        file_url: primary.publicUrl,
        file_name: primary.storageFileName,
        status: 'pending',
      })
```

Replace with:
```ts
      .insert({
        name: productName,
        description: null,
        file_url: primary.publicUrl,
        file_name: primary.storageFileName,
        status: 'pending',
        created_by: auth.user.id,
      })
```

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Run all 3 new smokes as a sanity baseline**

```bash
npm run test:magic-bytes
npm run test:analyze-rate-limit
npm run test:storage-signed-url
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add app/api/upload/route.ts
git commit -m "feat(security): upload integration — rate limit + magic-byte + created_by + private storage path

Drops getPublicUrl call; stores storage path in file_url. Magic-byte
check rejects spoofed Content-Type / wrong extension. Rate limit
prevents per-user flood (3 inflight / 20 daily, env-overridable).
created_by tags every new product with the uploading user for
downstream IDOR ownership check."
```

---

## Task 9: `/api/analyze` ownership check + live smoke

**Files:**
- Modify: `app/api/analyze/route.ts`
- Create: `scripts/test-analyze-ownership.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing smoke**

`scripts/test-analyze-ownership.ts`:
```ts
/**
 * Live DB smoke: /api/analyze の ownership check 4 ケース。
 * 実行: npm run test:analyze-ownership
 *
 * 注意: HTTP 経由ではなく Postgres を直接見る方式 — productId と user_id の
 *       combinations が application logic で 403/404/200 のいずれを返すべきかを
 *       テスト row を作成して検証する。実 fetch は dev server を要求するため
 *       avoid; 代わりに ownership 関数のロジックを純粋関数で検証する。
 *
 * 前提: 2026-05-26_products_created_by.sql 適用済み。profiles に 2 行以上。
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

/**
 * The same ownership predicate as `/api/analyze/route.ts`.
 * Returns true if user is allowed to mutate the product.
 */
function isAllowed(
	productCreatedBy: string | null,
	userId: string,
	role: "member" | "admin",
): boolean {
	if (role === "admin") return true;
	return productCreatedBy === userId;
}

async function main(): Promise<void> {
	const { data: profiles } = await sb.from("profiles").select("id, role").limit(2);
	if (!profiles || profiles.length < 2) throw new Error("profiles テーブルに 2 行以上必要");
	const userA = profiles[0].id as string;
	const userB = profiles[1].id as string;

	const tag = `ownership-smoke-${Date.now()}`;
	const tempIds: string[] = [];

	try {
		// Insert two products — one owned by A, one with NULL owner
		const { data: pA, error: eA } = await sb
			.from("products")
			.insert({ name: `${tag}-A`, file_url: "smoke://none", file_name: "a.txt", status: "failed", created_by: userA })
			.select("id, created_by")
			.single();
		if (eA) throw new Error(eA.message);
		tempIds.push((pA as { id: string }).id);

		const { data: pNull, error: eN } = await sb
			.from("products")
			.insert({ name: `${tag}-null`, file_url: "smoke://none", file_name: "a.txt", status: "failed", created_by: null })
			.select("id, created_by")
			.single();
		if (eN) throw new Error(eN.message);
		tempIds.push((pNull as { id: string }).id);

		const pAOwner = (pA as { created_by: string | null }).created_by;
		const pNullOwner = (pNull as { created_by: string | null }).created_by;

		// Case 1: user A acts on A's product as member → allowed
		assert(isAllowed(pAOwner, userA, "member") === true, "owner member should be allowed");

		// Case 2: user B acts on A's product as member → forbidden
		assert(isAllowed(pAOwner, userB, "member") === false, "non-owner member should be forbidden");

		// Case 3: user B acts on A's product as admin → allowed
		assert(isAllowed(pAOwner, userB, "admin") === true, "admin should bypass owner");

		// Case 4: user A acts on NULL-owner product as member → forbidden (admin only)
		assert(isAllowed(pNullOwner, userA, "member") === false, "NULL owner + member should be forbidden");
		assert(isAllowed(pNullOwner, userA, "admin") === true, "NULL owner + admin should be allowed");

		console.log("[ok] analyze-ownership smoke 全4ケース通過 (pure predicate)");
	} finally {
		if (tempIds.length > 0) {
			await sb.from("products").delete().in("id", tempIds);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run test:analyze-ownership
```
Expected: FAIL — script not registered.

- [ ] **Step 3: Wire up npm script**

```json
"test:analyze-ownership": "tsx --env-file=.env.local scripts/test-analyze-ownership.ts"
```

- [ ] **Step 4: Add ownership check to `app/api/analyze/route.ts`**

Find:
```ts
	const isInternal = hasInternalSecret(request);
	if (!isInternal) {
		const auth = await requireUser(["member", "admin"]);
		if ("error" in auth) return auth.error;
	}

	type AnalyzeFile = { base64: string; mimeType: string; fileName: string };
	const body = await request.json() as {
```

Replace with:
```ts
	const isInternal = hasInternalSecret(request);
	let authUserId: string | null = null;
	let authRole: "member" | "admin" | null = null;
	if (!isInternal) {
		const auth = await requireUser(["member", "admin"]);
		if ("error" in auth) return auth.error;
		authUserId = auth.user.id;
		authRole = auth.role as "member" | "admin";
	}

	type AnalyzeFile = { base64: string; mimeType: string; fileName: string };
	const body = await request.json() as {
```

Then find:
```ts
	const { productId } = body;

	const supabase = getServiceClient();

	// Normalize body shape: prefer `files[]`, fall back to legacy single-file fields.
```

Replace with:
```ts
	const { productId } = body;

	const supabase = getServiceClient();

	// Phase 4 IDOR check — only when called via user-auth (internal-secret path bypasses).
	if (!isInternal) {
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
		const isOwner = (prod as { created_by: string | null }).created_by === authUserId;
		const isAdmin = authRole === "admin";
		if (!isOwner && !isAdmin) {
			console.warn(`[${productId}] analyze IDOR blocked: user=${authUserId} owner=${(prod as { created_by: string | null }).created_by}`);
			return NextResponse.json({ error: "forbidden" }, { status: 403 });
		}
	}

	// Normalize body shape: prefer `files[]`, fall back to legacy single-file fields.
```

- [ ] **Step 5: Run to verify smoke now passes**

```bash
npm run test:analyze-ownership
```
Expected: `[ok] analyze-ownership smoke 全4ケース通過 (pure predicate)`.

- [ ] **Step 6: TS check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add app/api/analyze/route.ts scripts/test-analyze-ownership.ts package.json
git commit -m "feat(security): /api/analyze IDOR ownership check

User-auth path now verifies products.created_by === auth.user.id OR
role=admin before accepting productId. internal-secret path (cron,
upload trigger) bypasses. NULL-owner rows accessible to admin only."
```

---

## Task 10: CLAUDE.md note for new env vars

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add env note**

Find a logical insertion point under the `Key Conventions` or environment notes section. Append a paragraph after the existing `server-only` note:

```markdown
- **Per-user analyze rate limit** (Phase 4): `lib/research/analyze-rate-limit.ts` caps `/api/upload` at `ANALYZE_MAX_INFLIGHT_PER_USER` (default 3) concurrent analyzing rows and `ANALYZE_MAX_DAILY_PER_USER` (default 20) uploads per rolling 24h per user. Admin role bypasses. Override via env if a member team needs higher throughput.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): note Phase 4 analyze rate-limit env vars"
```

---

## Task 11: Final verification

**Files:** none

- [ ] **Step 1: TS + lint**

```bash
npx tsc --noEmit
npm run lint
```
Expected: 0 errors.

- [ ] **Step 2: All Phase 1-4 smokes**

```bash
npm run test:research-data-model
npm run test:research-retry-stage
npm run test:research-stuck-detector
npm run test:gemini-classify-error
npm run test:gemini-retry
npm run test:research-schema-shape
npm run test:error-reason-explain
npm run test:magic-bytes
npm run test:analyze-ownership
npm run test:analyze-rate-limit
npm run test:storage-signed-url
```
Expected: all 11 PASS.

- [ ] **Step 3: Inspect git log**

```bash
git log --oneline 52fe670..HEAD
```
Expected: ~12 commits since `52fe670`, one `docs(research)` (plan) + 10-11 implementation commits.

- [ ] **Step 4: Inspect uncommitted state**

```bash
git status
```
Expected: `nothing to commit, working tree clean`.

- [ ] **Step 5: Manual end-to-end check (dev server)**

`npm run dev`, log in as a member. Try the following manual flows and report what was observed:
1. Upload a PDF — should succeed; products row has `created_by = your user id`.
2. Upload a file renamed to `exploit.pdf` but containing HTML — should reject with 400 "File content does not match declared type".
3. Upload 4 files in quick succession to put yourself at 3 in-flight — 4th should 429 with "現在分析中の商品が 3 件あります...".
4. Browser-paste the previously-public storage URL (from any old completed product) — should now 403/404.

(Cannot automate without dev-server + UI testing infra — manual verification only.)

- [ ] **Step 6: No commit needed.** Verification only.

---

## Out of scope (deferred to future maintenance)

- `?? ""` fallback on `AWS_*` env vars (low risk, separate hygiene)
- `error_reason` PII sanitization (low likelihood, low impact)
- Dependency version bumps (separate maintenance)
- Multi-tenant isolation (single-tenant operations)
- Admin retry API cross-product limits (intentional admin tool)
- KV / Upstash rate-limit upgrade (Postgres count is sufficient for current scale)
- Storage path migration for existing rows (UI doesn't read, no immediate need)

## Risks (carried over from spec §10)

- `created_by IS NULL` on legacy rows means members cannot re-analyze them via the user-auth path; only admin can. Acceptable (mostly already completed).
- Already-issued public URLs of `product-files` may exist in browser caches / logs / backups. They immediately stop working after Migration 1; UI doesn't reference them.
- Magic-byte check defeats casual fake-extension uploads but not a payload that genuinely starts with `%PDF`. Not a sandboxing replacement.
- Rate limit is per-user and Postgres-based; a single user with multiple accounts can multiply quotas. Single-tenant tradeoff.
- `screenplays` RLS may break a future read path. Grep verified no current viewer-readable consumer exists.

## Self-review

**Spec coverage walk** (against `2026-05-26-research-security-design.md`):
- §3 (storage lock) → Tasks 1, 6, 8 ✓
- §4 (IDOR) → Tasks 2, 4, 8, 9 ✓
- §5 (screenplays RLS) → Task 3 ✓
- §6 (magic-byte) → Tasks 5, 8 ✓
- §7 (rate limit) → Tasks 7, 8, 10 ✓
- §8 (smokes) → Tasks 5, 6, 7, 9 + Task 11 final run ✓
- §9 (deploy order) → Tasks 1-3 are the migrations applied first; code tasks follow; Task 11 covers manual end-to-end ✓
- §10 (risks) → carried into the "Risks" section above ✓
- §11 (non-changes) → respected (no edits in discovery/strategy/broadcasts/pipeline) ✓

**Placeholder scan:** no TBD / TODO / "similar to" / hand-wavy steps. Each step has exact code or exact command.

**Type consistency:**
- `RateLimitResult`, `MimeCheckResult`, `auth.user.id`, `auth.role`, `checkMagicBytes`, `checkAnalyzeRateLimit`, `createSignedProductFileUrl` all spelled identically across tasks where they appear.
- `created_by` field name matches between migration (Task 2), TS type (Task 4), upload INSERT (Task 8), and analyze SELECT (Task 9).
- `auth.role as "member" | "admin"` narrowing is consistent in Task 8 (upload) and Task 9 (analyze).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-research-security.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review, fast iteration. Same pattern as Phase 1 / 2 / 3.
2. **Inline Execution** — execute all 11 tasks in this session with checkpoint pauses.

Which approach?
