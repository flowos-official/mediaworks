# 新規リサーチパイプライン — 出力品質 (Phase 3)

> **作成日**: 2026-05-26
> **ブランチ**: `research/output-quality`
> **上位ロードマップ**: Phase 1 (データモデル整理) → Phase 2 (信頼性・運用, `3dccf1c` マージ完了) → **Phase 3 (本書, 出力品質)** → Phase 4 (セキュリティ, オプション)

## 1. 背景 / 問題

Phase 2 が信頼性 (stuck 検出 + admin 復旧) を確保した。残るのは **出力そのものの品質** — Gemini からどれだけ正確・一貫・想定形式のデータを引き出せるか。Exploration で見つかった現状の品質リスク:

- **Multi-file の silent discard**: `/api/upload` は `files[]` を受けて全ファイルを Storage に保存するが、`/api/analyze` には `uploadedFiles[0]` のみ渡している。残りのファイルは分析に使われない。
- **抽出プロンプトに出力言語の指定なし**: モデルが入力言語を推測する。韓国語/英語入力のとき出力が日本語にならない可能性。
- **synthesize に `responseSchema` 未適用**: ~400 行の prose template で ~20 トップレベルフィールドを自然言語指示。型/必須/列挙の強制はモデル任せ。
- **コンテキスト挿入順が逆**: 検索結果 + broadcast context が schema template の **後** に挿入され、grounding が出力指示より遅れる。
- **Retry が弱い**: 2 attempts、backoff なし、エラー種別の区別なし。safety block / 429 / 5xx / parse fail がすべて同じ catch に流れる。
- **`error_reason` taxonomy の粒度が低い**: Phase 2 で `trigger_not_invoked` / `analysis_timeout` / `cron_secret_missing` / `extract_failed:` / `synthesis_failed:` は導入したが、後者2つは prefix のみで原因が "原因不明 + 切り詰めメッセージ"。
- **`loadBroadcastContext` の例外を完全に飲み込む**: DB 障害が起きても synthesize は context なしで進行、`error_reason` に痕跡なし。
- **`analyzeExpansionStrategy` は retry なし + weak JSON extractor**: 1 回失敗で即 throw。
- **ProductCard / ProductList の polling に上限なし**: status が pending/analyzing の row が 1 つでもあれば 5 秒ごとに永遠に polling。経過時間も実装エラーメッセージも見えない。

## 2. 目標 / 非目標

### 目標
1. Multi-file extract: アップロードされたすべてのファイルを 1 回の Gemini call にまとめて送信。
2. Synthesize に full `responseSchema` を適用し、~20+ フィールドの型/必須/範囲を強制。
3. Gemini 呼び出しに exponential backoff + 3 attempts + error kind 分類を適用。
4. `error_reason` taxonomy を細分化: `safety_blocked` / `rate_limited` / `parse_failed` / `server_error` / `extract_empty` / `schema_validation_failed` / `context_load_failed` 等。
5. ProductCard / ProductList の polling に 12 分上限、経過時間表示、status=failed 時 `error_reason` ベースの日本語/韓国語メッセージ。
6. `loadBroadcastContext` の silent swallow を排除。失敗時は `context_load_failed` を soft-mark、synthesize 自体は context なしで継続。
7. `analyzeExpansionStrategy` にも同 retry helper を適用。

### 非目標 (Phase 4 以降に持ち越し)
- Gemini Pro fallback の導入 (ユーザ明示除外)
- 5 秒 polling を SSE/Realtime に置換 (別 spec)
- Vercel Queue / durable workflow への置換
- Storage バケットの public 拒否 / `/api/analyze` の internal-only 強化
- Strategy 画面側の失敗 UI (本 spec は library helper の適用のみ)
- User-side の手動 retry ボタン (Phase 2 比目標通り operator のみ)
- File size 上限の UI 表示 (今回は API 側のエラー返しのみ)

## 3. A. Multi-file extract

### 3.1 `/api/analyze` body shape の拡張

**新 (推奨)**:
```ts
type AnalyzeBody = {
  productId: string;
  files: Array<{ base64: string; mimeType: string; fileName: string }>;
};
```

**旧 (互換維持)**:
```ts
type AnalyzeBodyLegacy = {
  productId: string;
  fileBase64: string;
  mimeType: string;
  fileName: string;
};
```

ハンドラ冒頭で `files` を優先、なければ legacy 単一フィールドを `[{ base64, mimeType, fileName }]` にラップ。

### 3.2 `extractProductInfo` 改修

```ts
export async function extractProductInfo(
  files: Array<{ base64: string; mimeType: string; fileName: string }>,
): Promise<ProductInfo>
```

Gemini API への parts 構築:
```ts
const parts = [
  { text: EXTRACT_PROMPT },
  ...files.map((f) => ({
    inlineData: { data: f.base64, mimeType: f.mimeType },
  })),
];
```

### 3.3 Extract プロンプト改訂

冒頭に追加:
```
複数のファイルが添付されている場合、すべて同一商品の異なる面 (表面/裏面/パッケージ/詳細写真/カタログPDF 等) として総合的に判断してください。複数の異なる商品が混在する場合は、最も主要な1つに絞ってください。

出力JSONのすべての値は日本語で記述してください。商品名/カテゴリ/特徴/対象市場/価格帯すべて日本語のみ。
```

### 3.4 入力サイズガード

```ts
const MAX_TOTAL_PAYLOAD_MB = 20;
const MAX_SINGLE_FILE_MB = 15;
```

- 単一ファイル > 15MB → 400 + `error_reason='file_too_large'`
- 合計 > 20MB → 大きい順に末尾を捨て、`files_truncated=true` をログ。`error_reason` には mark しない (成功するため)。
- `/api/analyze` の payload chuk: `files.length === 0` → 400 + `error_reason='no_files'`.

### 3.5 影響を受ける呼び出し元

- `app/api/analyze/route.ts` — body parse, files 配列を `extractProductInfo` に渡す
- `app/api/upload/route.ts` — `/api/analyze` 呼び出し時に全ファイルを base64 化して `files` に詰める
- `lib/discovery/enrich-worker.ts` 等の **single-file 呼び出し経路は不変**: URL から 1 画像を fetch するパスは `extractProductInfo([{ base64, mimeType, fileName: "image.jpg" }])` で 1 要素配列を渡せば動作。

## 4. B. responseSchema for synthesize

### 4.1 新ファイル `lib/gemini/research-schema.ts`

`@google/generative-ai` の `Type` を使った full schema。骨子:

```ts
import { SchemaType, type Schema } from "@google/generative-ai";

export const researchOutputSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    marketability_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
    marketability_description: { type: SchemaType.STRING },
    demographics: { type: SchemaType.OBJECT, properties: { /* age_groups, gender, lifestyle, ... */ }, required: [/* ... */] },
    seasonality: { type: SchemaType.OBJECT, properties: { /* peak_months, off_months, drivers, ... */ }, required: [/* ... */] },
    cogs_estimate: { type: SchemaType.OBJECT, properties: { /* low, mid, high, breakdown */ }, required: [/* ... */] },
    influencers: { type: SchemaType.ARRAY, items: { type: SchemaType.OBJECT, properties: { name: { type: SchemaType.STRING }, platform: { type: SchemaType.STRING }, audience_fit: { type: SchemaType.STRING } }, required: ["name", "platform", "audience_fit"] }, minItems: 3, maxItems: 8 },
    content_ideas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING }, minItems: 5, maxItems: 10 },
    competitor_analysis: { type: SchemaType.OBJECT, properties: { /* ... */ }, required: [/* ... */] },
    recommended_price_range: { type: SchemaType.STRING },
    broadcast_scripts: { type: SchemaType.OBJECT, properties: { /* opener, mid, closer */ }, required: [/* ... */] },
    japan_export_fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
    distribution_channels: { type: SchemaType.OBJECT, properties: { /* ... */ }, required: [/* ... */] },
    pricing_strategy: { type: SchemaType.OBJECT, properties: { /* ... */ }, required: [/* ... */] },
    marketing_strategy: { type: SchemaType.OBJECT, properties: { /* ... */ }, required: [/* ... */] },
    korea_market_fit: { type: SchemaType.OBJECT, properties: { fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 }, /* ... */ }, required: [/* ... */] },
    live_commerce: { type: SchemaType.OBJECT, properties: { /* ... */ }, required: [/* ... */] },
  },
  required: [
    "marketability_score", "marketability_description",
    "demographics", "seasonality", "cogs_estimate", "influencers",
    "content_ideas", "competitor_analysis", "recommended_price_range",
    "broadcast_scripts", "japan_export_fit_score",
    "distribution_channels", "pricing_strategy", "marketing_strategy",
    "korea_market_fit", "live_commerce",
  ],
};
```

実装者が個別 sub-schema の詳細フィールドを `types ResearchOutput` (lib/gemini.ts) から手で起こす。型 ↔ schema の同期は手動で、smoke (§9-3) が dry-run 検証。

### 4.2 `synthesizeResearch` の generationConfig 拡張

```ts
generationConfig: {
  responseMimeType: "application/json",
  responseSchema: researchOutputSchema,
  // temperature 等は現状維持
}
```

### 4.3 Prompt の順序を再配置

新構成:
1. System 役割 + 分析目標 (短い)
2. 入力 ProductInfo (JSON)
3. 検索結果 (Brave + Rakuten — `## headers` で区切り)
4. Broadcast context (loadBroadcastContext から、ある場合のみ)
5. Channel reference (`buildChannelReferencePrompt`)
6. 出力ガイド (各フィールドの **ビジネス意味** + 言語ルール + 例)

旧構成では "出力ガイド" → "コンテキスト" の順で、grounding が遅れていた。

prose template から "型/JSON 構造/key 名" の説明は削除 — schema が enforce する。ビジネス意味/例/言語ルール は残す。

### 4.4 Parse 後の sanitization 維持

`parseResearchOutput(text: string): ResearchOutput`:
- schema 適用後でも Phase 1 の `korea_market_fit.fit_score` を `Math.trunc + Number.isFinite` で正規化 (DB generated column 整合保証)。
- schema が `minimum/maximum` を強制するが、defense-in-depth で保持。

### 4.5 Parse 失敗時の fallback

schema が原因で空応答や invalid JSON が返るケース:
1. 既存 `parseJsonFromModelText` の brace-balanced 復旧で再 parse。
2. それも失敗なら `kind='schema_validation_failed'` で throw — §5 の retry helper が再試行判断。

### 4.6 影響を受けるファイル

- 新: `lib/gemini/research-schema.ts`, `lib/gemini/parse-research-output.ts`
- 変更: `lib/gemini.ts::synthesizeResearch` — generationConfig, prompt 順, parser 呼び出し
- 変更: `lib/research/synthesize-product.ts` — schema_validation_failed の error_reason マッピング

## 5. C. Retry + error taxonomy

### 5.1 新ファイル `lib/gemini/errors.ts`

```ts
export type GeminiErrorKind =
  | "safety_blocked"
  | "rate_limited"
  | "server_error"
  | "parse_failed"
  | "schema_validation_failed"
  | "extract_empty"
  | "unknown";

export class GeminiCallError extends Error {
  constructor(
    public kind: GeminiErrorKind,
    public attempts: number,
    public summary: string,
    public lastError: unknown,
  ) {
    super(`${kind}: ${summary}`);
    this.name = "GeminiCallError";
  }
}

export function classifyGeminiError(err: unknown, responseText?: string): GeminiErrorKind {
  // 1. result.response.promptFeedback?.blockReason → safety_blocked
  // 2. result.response.candidates?.[0]?.finishReason === 'SAFETY' → safety_blocked
  // 3. err.status === 429 or err.message includes 'rate' → rate_limited
  // 4. err.status >= 500 or fetch error → server_error
  // 5. responseText === "" or undefined → extract_empty
  // 6. err.name === 'SyntaxError' or err.message includes 'JSON' → parse_failed
  // 7. err.message includes 'schema' or 'required field' → schema_validation_failed
  // 8. fallback → unknown
}
```

### 5.2 新ファイル `lib/gemini/retry.ts`

```ts
import { GeminiCallError, type GeminiErrorKind, classifyGeminiError } from "./errors";

export interface RetryOptions {
  maxAttempts?: number;        // default 3
  baseDelayMs?: number;        // default 1000
  onAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => void;
  // attempt 2 以降に prompt を強化したい場合に override
  promptForAttempt?: (attempt: number, lastKind?: GeminiErrorKind) => string | null;
}

const NO_RETRY_KINDS: ReadonlySet<GeminiErrorKind> = new Set(["safety_blocked"]);

const BACKOFF_MULTIPLIER: Record<GeminiErrorKind, number> = {
  rate_limited: 1.5,
  server_error: 2.0,
  parse_failed: 1.5,
  schema_validation_failed: 1.5,
  extract_empty: 1.5,
  unknown: 1.5,
  safety_blocked: 1.0, // unused (no retry)
};

export async function callGeminiWithRetry<T>(
  invoker: (attempt: number, promptOverride?: string | null) => Promise<{ result: T; responseText?: string }>,
  options: RetryOptions = {},
): Promise<T> {
  const max = options.maxAttempts ?? 3;
  const base = options.baseDelayMs ?? 1000;

  let lastKind: GeminiErrorKind | undefined;
  let lastSummary = "";
  let lastError: unknown;

  for (let attempt = 1; attempt <= max; attempt++) {
    const promptOverride = options.promptForAttempt?.(attempt, lastKind) ?? null;
    options.onAttempt?.(attempt, lastKind);

    try {
      const { result, responseText } = await invoker(attempt, promptOverride);
      // 成功でも空応答は extract_empty として classify (1 回まで retry)
      if (responseText !== undefined && responseText.trim().length === 0) {
        throw new Error("empty model response");
      }
      return result;
    } catch (err) {
      lastError = err;
      // responseText が catch 直前にあれば classify が活用
      lastKind = classifyGeminiError(err);
      lastSummary = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);

      if (NO_RETRY_KINDS.has(lastKind)) break;
      if (attempt >= max) break;

      const delay = Math.round(base * Math.pow(BACKOFF_MULTIPLIER[lastKind] ?? 1.5, attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new GeminiCallError(
    lastKind ?? "unknown",
    max,
    `${lastSummary} after ${max} attempts`,
    lastError,
  );
}
```

### 5.3 attempt-2 prompt 補強

- `parse_failed` 時: `\n\n出力はJSONオブジェクト1個のみ。コードフェンス・前後の説明文・前後の空白文字すべて禁止。`
- `schema_validation_failed` 時: 直前のエラーの "missing required: X" を抽出して `\n\n以下のフィールドが必須です: X` を appendix。
- `extract_empty` 時: `\n\nすべての必須キーを必ず明示的に生成してください。空文字列禁止。`

### 5.4 synthesize / extract / expansion への適用

各呼び出し元で:
```ts
const research = await callGeminiWithRetry(async (attempt, override) => {
  const prompt = override ? basePrompt + override : basePrompt;
  const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig });
  const text = result.response.text();
  return { result: parseResearchOutput(text), responseText: text };
}, {
  promptForAttempt: (n, kind) => buildAttemptOverride(kind),
});
```

### 5.5 `synthesize-product.ts` の catch 改修

```ts
} catch (error) {
  let reason: string;
  if (error instanceof GeminiCallError) {
    reason = error.message; // "kind: summary" 形式
  } else if (error instanceof Error) {
    reason = `synthesis_failed: ${error.message.slice(0, 500)}`;
  } else {
    reason = "synthesis_failed: unknown";
  }
  await markProductStatus(sb, productId, "failed", reason);
  throw new ProductResearchSynthesisError(500, "Synthesis failed", error);
}
```

`app/api/analyze/route.ts` の extract catch も同パターン。

### 5.6 Admin UI の error_reason 表示マッピング

`app/[locale]/(admin)/admin/research-pipeline/page.tsx` に kind→ 日本語ラベルマップを追加:

```ts
const ERROR_REASON_LABELS: Record<string, string> = {
  safety_blocked: "セーフティブロック",
  rate_limited: "レート制限",
  server_error: "サーバーエラー",
  parse_failed: "JSON解析失敗",
  schema_validation_failed: "スキーマ検証失敗",
  extract_empty: "空応答",
  context_load_failed: "コンテキスト読込失敗",
  cron_secret_missing: "CRON_SECRET未設定",
  trigger_not_invoked: "トリガー未起動",
  analysis_timeout: "分析タイムアウト",
  extract_failed: "抽出失敗",
  synthesis_failed: "合成失敗",
  file_too_large: "ファイルサイズ超過",
  no_files: "ファイル未添付",
  unknown: "原因不明",
};

function labelOf(reason: string | null): string {
  if (!reason) return "理由不明";
  const kind = reason.split(":")[0].trim();
  return ERROR_REASON_LABELS[kind] ?? kind;
}
```

カード表示は `<short label> · <full reason>` 形式。

## 6. D. User-side polling + 失敗 UI

### 6.1 Polling 12 分上限

`components/ProductList.tsx`:

```ts
const POLL_TIMEOUT_MIN = 12;

function shouldPoll(p: Product): boolean {
  if (p.status !== "pending" && p.status !== "analyzing") return false;
  const ageMin = (Date.now() - new Date(p.created_at).getTime()) / 60000;
  return ageMin < POLL_TIMEOUT_MIN;
}

useEffect(() => {
  if (!products.some(shouldPoll)) return; // 全 product が打ち切り済み → polling 停止
  const id = setInterval(() => refetch(), 5000);
  return () => clearInterval(id);
}, [products]);
```

12 分の根拠: stuck-detector 10 分しきい値 + 2 分のクロックドリフト/サイクル誤差バッファ。実際には 15 分 cron が 14 分目に走る可能性があるが、 client polling が止まっても次のページロードで反映される。

### 6.2 経過時間表示

`components/ProductCard.tsx`:

```ts
function elapsedLabel(createdAt: string): string {
  const min = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000);
  if (min < 1) return "分析中...";
  return `分析中... (${min}分経過)`;
}
```

5 分超で amber 着色 (tooltip "通常2-3分で完了します")、12 分超で "停滞検出中" 一時バッジ。

### 6.3 失敗メッセージ

`lib/research/error-reason-explain.ts`:

```ts
const MESSAGES_JA: Record<string, string> = {
  safety_blocked: "コンテンツが安全フィルタで拒否されました。内容を見直して再アップロードしてください",
  rate_limited: "AI処理が混雑しています。数分後にもう一度お試しください",
  server_error: "AIサーバーが一時的に応答していません。再アップロードをお試しください",
  parse_failed: "AIの出力解析に失敗しました。管理者が確認します",
  schema_validation_failed: "AIの出力形式に問題がありました。管理者が確認します",
  extract_empty: "AIから空の応答が返りました。再アップロードをお試しください",
  context_load_failed: "市場データの読み込みに失敗しました。再アップロードで通常は回復します",
  cron_secret_missing: "システム設定エラー — 管理者対応中",
  trigger_not_invoked: "処理が開始されませんでした。再アップロードしてください",
  analysis_timeout: "分析がタイムアウトしました。再アップロードしてください",
  extract_failed: "ファイル解析に失敗しました。ファイル形式をご確認ください (PDF/PPTX/DOCX/画像)",
  synthesis_failed: "市場調査の生成に失敗しました。再アップロードをお試しください",
  file_too_large: "ファイルサイズが上限 (15MB) を超えています",
  no_files: "ファイルが添付されていません",
  unknown: "原因不明 — 管理者にお問い合わせください",
};

export function explainErrorReason(reason: string | null, locale: "ja" | "ko" = "ja"): string {
  // 同様に MESSAGES_KO を定義。空 reason は MESSAGES_*.unknown を返す
}
```

`ProductCard` の failed 状態で `explainErrorReason(p.error_reason, locale)` 表示 + 「再アップロード」リンク (home `/[locale]` の upload タブへ anchor)。

### 6.4 i18n キー

`messages/ja.json` / `messages/ko.json` に追加:
```json
{
  "product": {
    "analyzing_label": "分析中... ({elapsed})",
    "analyzing_default": "分析中...",
    "analyzing_warning": "通常2-3分で完了します",
    "stuck_detecting": "停滞検出中",
    "reupload_link": "再アップロード"
  }
}
```

メッセージ本文 (kind→label) は `error-reason-explain.ts` 内のハードコード辞書を維持 (i18n キーで分散させない — 1 ファイルで一覧したい)。

## 7. E. 副次モジュール整理

### 7.1 `lib/research/competitor-context.ts::loadBroadcastContext`

現状の `catch { console.warn(...); return EMPTY_CONTEXT }` を廃止し、`BroadcastContextLoadError` を throw する。

`synthesize-product.ts` 側:
```ts
let broadcastContext = EMPTY_BROADCAST_CONTEXT;
try {
  broadcastContext = await loadBroadcastContext(productInfo.category);
} catch (err) {
  // non-fatal: synthesize continues without context but log + soft-mark
  console.warn(`[${productId}] broadcast context load failed:`, err);
  await sb.from("products")
    .update({ error_reason: `context_load_failed: ${err instanceof Error ? err.message.slice(0, 300) : "unknown"}` })
    .eq("id", productId);
  // markProductStatus("completed", null) で成功時に clear される
}
```

### 7.2 `lib/gemini.ts::analyzeExpansionStrategy`

`callGeminiWithRetry` ヘルパーを適用。JSON 抽出は `parseJsonFromModelText` に統一。Strategy 側 UI の失敗表示は非目標 (helper の戻り値の throw を呼び出し元がそのまま投げる)。

## 8. データモデル変更

**マイグレーション不要**。

`products.error_reason` は Phase 2 で `text` 型として導入済み。新 kind は文字列 prefix のみ。

## 9. 検証 / smoke

新規スクリプト:

1. **`scripts/test-gemini-classify-error.ts`** (pure unit) — `classifyGeminiError` の 7 分岐検証。fakeerror, fakeresponse でテスト。
2. **`scripts/test-gemini-retry.ts`** (pure unit) — `callGeminiWithRetry` の retry 回数 / backoff 時間 / no-retry kind 確認。Promise.reject シーケンス で。
3. **`scripts/test-research-schema-shape.ts`** (pure unit) — `researchOutputSchema` を `@google/generative-ai` の `Schema` 型として受け入れ可能か (TS check + 簡易構造検証)。
4. **`scripts/test-error-reason-explain.ts`** (pure unit) — 13 kind + unknown のマッピング (JA/KO 両方)。

回帰確認:
- `npm run test:research-data-model` (Phase 1) PASS
- `npm run test:research-retry-stage` (Phase 2) PASS
- `npm run test:research-stuck-detector` (Phase 2) PASS

End-to-end (手動):
- `npm run dev` + 手動アップロード (PDF 1 + 写真 3 同時, 大ファイル 1) で multi-file path 確認

## 10. 配備順序

1. コードのみのデプロイ。マイグレーションなし。
2. 既存 `analyzing` row への影響: schema 適用後の synthesize は新しい retry / 新しい parser を使う。途中で deploy が走ったら、in-flight な呼び出しは旧 path で完了する (関数インスタンスは旧コード)。新しい呼び出しから新 path 適用。
3. 環境変数の追加: なし。

## 11. リスク / 未解決

- **responseSchema が深いネストで Gemini Flash に reject される**: schema 自体が API に拒否される可能性。**mitigation**: smoke (§9-3) で dry-run、reject されたら nested を簡略化。
- **Multi-file の 25MB inline 制限超過**: 大きい PDF 1 ファイルだけで超えるケース。`MAX_SINGLE_FILE_MB=15` で 400 を返す。Phase 3 では UI 側のサイズ事前チェックは非目標。
- **Polling 12 分 vs server 15 分 cron のドリフト**: client が polling 停止後にサーバが完了する経路あり。ユーザは次のページロードで確認。データ損失なし。
- **`safety_blocked` の繰り返し失敗**: コスメ・医療カテゴリで頻発の可能性。Phase 3 のメッセージで「内容を見直して再アップロード」を促す。プロンプト側の安全化チューニングは非目標。
- **`error_reason` taxonomy が free-text prefix**: DB CHECK なし。新 kind 追加時に admin UI と explain helper を同期する保守責任が残る (代わりに enum 化のコストを払わない)。
- **Schema 化後に既存 raw_json の蓄積データとの整合**: 新スキーマで synthesize される row は schema 強制下のため列値が "より厳格" になる。旧 row との混在は許容 (UI 側は型ガード済)。
- **`extract_empty` の 1 回 retry が空再応答を生む**: safety filter の暗黙ブロックを classify しきれない可能性。Phase 3 では retry まで、明示判定追加は将来。

## 12. 影響しない領域 (意図的非変更)

- Phase 2 の cron / admin retry / trigger-detection は変更なし。
- Discovery / Strategy / Broadcasts / Pipeline 主要モジュールは影響なし (Strategy の expansion 部分のみ retry helper 適用 — UI 不変)。
- Phase 1 のマイグレーション / カラム / 型 / smoke は変更なし。

## 13. 後続 (Phase 4 へ)

- Storage バケットの public→ 認証必須化、`/api/analyze` の internal-only 強化はセキュリティ Phase。
- SSE/Realtime による polling 排除は別 spec。
- Strategy 画面側の失敗 UI 一貫化。
- Gemini Pro fallback 検討 (現在は除外)。
