# 考査ツール v2 — 検索・根拠グラウンディング設計

- Date: 2026-06-04
- Status: approved (brainstorming) → pending spec review
- Builds on: `2026-06-02-screenplay-check-tool-design.md` (v1), PR #91 / #93

## 1. 問題（現状ギャップ）

現行の考査ツール (`lib/screenplay/compliance/check.ts`) は **検索を一切行わない**。判定の根拠は次の 2 つだけ:

1. `compliance_rules`（手動シードの NG/許容パターン辞書）
2. 商品 `product_info_snapshot`（ProductBrief）+ Gemini の内部知識

このため:

- **fact 軸**は「台本の主張が brief で裏付けられるか」しか見ず、外部の実データで検証しない（No.1・効能・価格・順位などの主張を実出典で確認できない）。
- **legal 軸**の辞書は手動かつ不完全で、カテゴリ別に「ホームショッピングで言ってよい/だめな表現」の権威的根拠を引いていない。
- どの finding にも**実出典 URL がない**ため追跡できない。

オペレーターの要件: 「事実に根拠し、カテゴリごとに実データを参照して用語の可否を判定すべき。検索もすべき。参照する実データが存在すべき。」

## 2. ゴール / 非ゴール

**ゴール**
- 法規・カテゴリ基準の**実参照コーパスを構築**し、判定に根拠として注入する（構造的検索、埋め込みなし）。
- fact 軸で**実時間 Web 検索**（Brave）を行い、主張を実出典で検証、finding に出典 URL を付す。
- 自動チェック（生成直後）と手動「再チェック」の**両方**でフル（コーパス+検索）を実行（分離しない）。コスト・遅延は bound + non-fatal で管理。

**非ゴール（将来）**
- ベクトル RAG（pgvector + 埋め込み）。v1 は構造的検索のみ。必要性が明確化したら別途アップグレード。
- 日本提供の公式文書の取り込み（現時点で提供物なし → 公開出典から自作）。

## 3. データモデル — `compliance_references`（新規テーブル）

`compliance_rules`（決定論フラグ用の NG/許容パターン辞書）とは**役割を分離**する。`compliance_references` は LLM 判定に注入する**根拠資料スニペット**。

```sql
CREATE TABLE compliance_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  law            text NOT NULL CHECK (law IN ('yakkiho','keihyo','kenzo','other')),
  category_scope text[] NOT NULL DEFAULT '{}',  -- empty = all categories
  topic          text NOT NULL,                 -- e.g. "化粧品56効能", "No.1表示の根拠要件"
  body           text NOT NULL,                 -- 実際のガイド本文スニペット
  keywords       text[] NOT NULL DEFAULT '{}',  -- 構造的検索用トークン
  citation       text NOT NULL DEFAULT '',      -- 出典名
  source_url     text NOT NULL DEFAULT '',      -- 原文 URL（追跡可能性）
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_references_active_idx ON compliance_references (active) WHERE active;
```

- RLS（`compliance_rules` と同一）: read = member|admin、write = admin のみ。
- 全項目に `source_url` を付け、本文冒頭または別カラムに「審査補助資料であり法的権威ではない」旨を明記（コーパス全体の免責は doc/シードコメントに記載）。

## 4. コーパス構築（実装者が自作）

日本提供文書がないため、**公開権威出典を Web 調査して seed を構築**する。seed migration `supabase/migrations/2026-06-04_compliance_references_seed.sql`。

対象出典（公開）:
- 厚労省 **化粧品の効能の範囲 56 項目**
- 東京都 **化粧品等の適正広告ガイドライン** / **医薬品等適正広告基準**
- 消費者庁 **景品表示法**運用基準（No.1 表示・打消し表示・二重価格・優良誤認・有利誤認）
- **健康増進法** 誇大表示（食品の健康保持増進効果）

対象カテゴリ（ホームショッピング基準）: 化粧品 / 医薬部外品 / 健康食品 / 医療機器 / 食品 / 家電 ほか。

各 reference は `topic` 単位の短いスニペット（`body`）+ `keywords` + `citation` + `source_url`。実装時に WebSearch/WebFetch で出典を確認しつつ作成。**作り話の出典は禁止** — URL は実在するもののみ。確認できない出典は載せない。

## 5. 検索（構造的・埋め込みなし）

`lib/screenplay/compliance/reference-retrieval.ts`（新規、サーバ専用 import なし＝テスト可能）:

```
selectReferences(scriptText, category, refs, K) -> ComplianceReference[]
```

- `category_scope` がカテゴリに一致（または空）の active な reference に絞る。
- スコア = その reference の `keywords` のうち**台本テキストに substring として出現する数**（日本語は空白分割しないため、トークン化ではなく出現判定）。同点は `topic` 昇順で安定ソート。上位 K（既定 8）を返す。
- 決定論的（同入力→同出力）でテスト可能。

選ばれた reference は LLM プロンプトに「根拠資料（出典付き）」として注入する。

## 6. fact 軸 — 実時間 Web 検索（Brave）

`lib/screenplay/compliance/fact-search.ts`（新規）:

1. **主張抽出（ヒューリスティック、LLM 追加呼び出しなし）**: 台本から検証対象になりうる文を抽出 — 数値・割合（`\d+%`, `\d+円`, `\d+倍`）、最上級/No.1 系語（`No\.?1`, `業界初`, `日本一`, `最` …）、効能断定を含む文。
2. 各主張から検索クエリを生成し、`braveSearchItems(query, 5)` で `{title,description,url}[]` を取得。
3. 上限: `CHECK_FACT_MAX_QUERIES`（既定 5）。各クエリ 10s タイムアウト（Brave 既存）。並列 `Promise.allSettled`。
4. 取得スニペット（URL 付き）を LLM プロンプトに「事実確認用の検索結果」として注入。

Provider は既存 `lib/brave.ts::braveSearchItems` を再利用（コスト・挙動が予測可能、API キー無し/402 時は graceful に空配列）。

## 7. エンジン変更 — `check.ts`

`checkScreenplay` のパイプライン（順序）:

1. **決定論パス**（既存 `matchLexicon`、`compliance_rules`）— 常時、最初に実行。
2. **コーパス取得**（`selectReferences`）— 構造的。
3. **fact 検索**（`fact-search`、Brave）— bound + best-effort。失敗時は空で続行。
4. **LLM 判定**（1 回）— プロンプトに〔商品 brief〕〔根拠資料（コーパス, 出典付き）〕〔事実確認検索結果（URL 付き）〕を注入し、3 軸 finding を出力。各 finding に可能なら出典 URL を付す。

2–4 は **best-effort**: 例外は握りつぶし、最低でも決定論パスの結果は返す（既存の堅牢性を維持）。

## 8. 結果スキーマ変更（`Finding`）

`lib/screenplay/compliance/types.ts` に**後方互換の追加**:

```ts
export interface FindingSource { title: string; url: string; }
export interface Finding {
  // ...既存...
  source: "lexicon" | "llm" | "corpus";   // "corpus" を追加
  references?: FindingSource[];            // 実出典（コーパス source_url / 検索 URL）
}
```

`screenplay_version_checks.result`（JSONB）は追加のみなので migration 不要。`lexicon_version` は `rules:N` から `rules:N refs:M` に拡張。

## 9. トリガ（自動・手動とも同一フル実行）

- **自動**: `screenplay.workflow.ts::checkStep` — 生成直後。コーパス + fact 検索を含むフル実行。**non-fatal**（チェック失敗は生成を絶対に壊さない）。
- **手動**: `POST /api/screenplays/[id]/check` — 同じフル実行。
- 遅延対策: fact 検索は上限クエリ数 + 並列 + タイムアウトで bound。`POST` の `maxDuration` は 90s 据え置き。ワークフローの `checkStep` も bound 内に収める。

## 10. 管理 UI

`/admin/compliance-rules` に**タブ追加**（「NGルール」/「参照資料」）または兄弟ページ `/admin/compliance-references`。CRUD は `compliance_rules` 管理と同型（API: `GET/POST /api/admin/compliance-references` + `PATCH/DELETE /[id]`、admin only、`validate` は law/category/url 形式）。v1 はシードで足りるため、管理 UI は薄く（一覧 + 追加/編集/無効化）。

## 11. コスト・遅延と env ノブ

- `CHECK_FACT_SEARCH_ENABLED`（既定 true）— fact 検索の全体スイッチ。
- `CHECK_FACT_MAX_QUERIES`（既定 5）。
- `CHECK_REFERENCE_TOP_K`（既定 8）。
- Brave キー無し/quota 切れ時は空で続行（degrade to v1 挙動）。

## 12. テスト

- `test:compliance-reference-retrieval`（DB 無し）: `selectReferences` のカテゴリ絞り込み・キーワード重複スコア・上位 K・決定論。
- `test:compliance-fact-extract`（DB 無し）: 主張抽出ヒューリスティック（数値・No.1・効能文を拾い、無関係文を拾わない）。
- 既存 `test:compliance-lexicon` / `test:compliance-rule-input` は回帰として維持。
- ライブ統合（skip-guarded, `.env.local`）: `checkScreenplay` が検索結果・コーパスを注入して finding に URL が付くこと。

## 13. 適用メモ（手動マイグレーション運用）

- `compliance_references` テーブル + seed は手動適用（既存ワークフロー）。
- env ノブは Vercel 環境変数に追加（`BRAVE_SEARCH_API_KEY` は既存）。

## 14. スコープ外・将来

- ベクトル RAG（pgvector + 埋め込み）へのアップグレード。
- 主張抽出の LLM 化（ヒューリスティック → 構造化抽出）。
- 参照資料の自動鮮度チェック（source_url のリンク切れ検知）。
- Gemini Google Search grounding への切替（現状 Brave 採用）。
