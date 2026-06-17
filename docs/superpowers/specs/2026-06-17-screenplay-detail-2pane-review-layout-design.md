# 台本詳細ページ — ワイド 2-pane 検討レイアウト (Design)

Date: 2026-06-17
Status: Approved (spec review incorporated 2026-06-17)
Scope: `/[locale]/screenplays/[id]` の閲覧・検討 UX 再構成

## 背景 / 問題

現在の `ScreenplayWorkspace` は 3 列グリッド
`lg:grid-cols-[260px_minmax(0,1fr)_340px]` = `[改稿履歴 | 台本 | 改稿フォーム+試験結果]`。

実機で確認した不具合:

1. **上部ツールバーの折返し崩れ.** 中央カラムが両サイド(260+340+gap)に圧迫され ~420px しかなく、
   ビューア上部のツールバー(`前へ/次へ`・`第N稿`・日付・`7,442 文字`・`コピー`・`.md`・`Word`)が
   縦に折り返り、`コピー` が縦書きのように崩れる。
2. **sticky オーバーフロー.** 右 `<aside>` が `lg:sticky lg:top-20` かつビューアより縦に長いため、
   下部(試験結果の後半)はビューポート外に切れ、左の長い台本を最下部までスクロールしないと現れない。
3. **比較しづらい構造.** 台本(中央・狭い)と試験結果(右・340px でさらに狭い)が同一ページスクロールを
   共有し、両方とも長いため「横に並べて対照」ができない。`変更点`(diff)はビューアのトグルに埋もれている。

根本原因は同一: **長い台本 + 長い試験結果 + 改稿フォームを 3 列に詰め込み**、全カラムが狭く縦スクロールが絡む。

ユーザー方針(確定): 3 つの作業(試験結果・変更点・改稿)は**同格**で、**モード切替が滑らか**であること。
レイアウト方向は **ワイド 2-pane(台本 | 検証パネル・タブ)** を採用。

## 設計概要

```
┌──────────────────── 上部バー (全幅, sticky) ─────────────────────┐
│ ◀前へ  次へ▶   第1稿 · 2026/06/16 19:50 · 7,442字   コピー .md Word│
├─ 改稿履歴 ─┬──────────── 台本 (広め) ──────────┬── 検証パネル ──┤
│ ▸第1稿    │ アバン                              │[試験結果(5)][変更点][改稿]│
│ ▸第2稿◀   │ [インサート]…                        │ ──────────────  │
│ (slim,    │ …台本本文…                           │ 53/100  5件    │
│  <lgでDD) │ (自前スクロール)                     │ ⚠高 価格表示…   │
│           │                                      │ (自前スクロール)│
└───────────┴──────────────────────────────────┴────────────────┘
```

- グリッド(ブレークポイント):
  - `xl+`: 3 列 `[220px 履歴 | minmax(0,1fr) 台本 | minmax(380px,440px) 検証]`。
  - `lg`(1024–1279): 2 列 `[minmax(0,1fr) 台本 | minmax(360px,420px) 検証]` + 履歴は上部バーのドロップダウン
    (`lg` で 3 列を開くと中央台本が ~300px まで潰れ「検討」には狭いため)。
  - `< lg`: 縦スタック。
  - 上部バーは全幅 span。
- 中央・右の **2 pane は各々独立スクロール + sticky 高さ**。
  sticky オフセットは現行 `top-20`(5rem)を基準に、新設の全幅 sticky 上部バー高を加味した値
  (実装時に確定。例: `lg:sticky lg:top-[7rem]` + `lg:max-h-[calc(100vh-8rem)]`)+ `overflow-y-auto` + `min-h-0`。
  → 問題 2(sticky オーバーフロー)を解消。
- 幅: **v1 は `(produce)/layout.tsx` の `max-w-7xl`(1280px)を変更しない。**
  上部バー化 + 2-pane 化だけで中央台本は ~420px → ~560px に拡がり、ツールバー折返しも解消する
  (1216 usable − 履歴220 − gap48 = 948 を 台本/検証 で分配)。
  影響範囲を最小化するためレイアウト幅はいじらない。さらに広げたい場合は
  **ルート単位**(詳細ページのみ)で `max-w` を上げるのを follow-up とする(兄弟の生成/一覧は据置)。

## ユニット

### Unit 1 — バージョン別 試験結果 API (新規)

`app/api/screenplays/[id]/versions/[versionId]/check/route.ts`

既存 `app/api/screenplays/[id]/check/route.ts` は GET/POST とも `current_version_id` 固定
(`check/route.ts:24,34,64`)。過去稿を選ぶと current 稿の結果が出てしまうため、**バージョン指定**版を新設。

- `requireUser(["member","admin"])`、`getServiceClient()`(既存 screenplay ルート踏襲)。
- `id`/`versionId` 両方 UUID 検証。
- **所有検証**: `screenplay_versions` を `.eq("id", versionId).eq("screenplay_id", id)` で取得し、
  無ければ 404(`versions/[versionId]/changes/route.ts` のテナントスコープと同パターン)。
- **GET**: 当該 version の最新 check(`screenplay_version_checks` を `version_id=versionId`、
  `created_at desc limit 1`)。**check row が無い場合のみ** 200 `{ check: null }`。
  所有検証失敗は 404、DB/クエリ失敗は 500 `{ error }`(null と明確に区別する)。
  成功形は既存 GET と同形(`{ check: { id, created_at, is_auto, lexicon_version, ...result } }`)。
- **POST**: 当該 version を再チェック。`checkScreenplay(ver.markdown, screenplay.product_info_snapshot,
  rules, references, { factSearch: true })` → `screenplay_version_checks` に `version_id=versionId`,
  `is_auto:false`, `created_by:auth.user.id` で insert。既存 POST 本体をバージョン指定に置換した形。
- 既存 `[id]/check/route.ts` は当面残す(他からの参照があれば後日整理)。

### Unit 2 — `CheckResultPanel` のバージョン対応

`components/screenplay/CheckResultPanel.tsx`

現状 `initialCheck` を `useState` 初期値にのみ使用(`:161`)→ バージョン切替で stale。

- Props を `{ screenplayId, versionId, initialCheck, initialCheckVersionId, onCheckChange }` に変更。
  SSR の `latestCheck` には `version_id` が無い(page query が select しない: `screenplays/[id]/page.tsx:38-45`)ため、
  初期 check が**どの版のものか**は別 prop で渡す。
  `initialCheckVersionId={initialScreenplay.current_version_id}` を Workspace→ReviewPanel→Panel と伝播。
- `useEffect([versionId])`:
  - `versionId === initialCheckVersionId` のときのみ初期表示に `initialCheck`(SSR 値)を使い、フェッチ省略。
  - それ以外/版変更時は `GET …/versions/[versionId]/check` を呼び `check` を入替。
    フェッチ中は busy/skeleton、**500/`error` 時は stale を消してエラー表示**、check row 無し(`{check:null}`)は null 表示。
- `recheck()` の POST 先を `…/versions/[versionId]/check` に変更(current 固定をやめる)。
- check が変わるたび親へ `onCheckChange(check)` を通知(タブ件数バッジを ReviewPanel が描画するため, 下記 Unit 4)。
- 既存の表示(スコア・法規/ファクト/品質・再現性情報)はそのまま。

### Unit 3 — `ScreenplayHeaderBar`(新規) + `ScreenplayViewer` 簡素化

新規 `components/screenplay/ScreenplayHeaderBar.tsx`:

- props: `{ markdown, title, versionLabel, createdAt, charCount, hasPrev, hasNext, onPrev, onNext, prevLabel, nextLabel }`。
- 横一列のバー: 左に `前へ/次へ` + `第N稿`・日付・文字数、右に `コピー`・`.md`・`Word`。
- ダウンロード/コピーロジック(現 `ScreenplayViewer` の `downloadMd`/`downloadDocx`/`copyMd`、
  動的 import の `buildScreenplayDocx`)を**ここへ移設**。

`components/screenplay/ScreenplayViewer.tsx`:

- **本文スクロール領域のみ**に縮小(`ScreenplayMarkdown` レンダリング)。
- 既存のツールバー(nav + コピー/.md/Word)と **`変更点/完成版` トグル(`showDiff`/`ChangeDiffView`)を撤去**。
  diff は検証パネルのタブへ移動(Unit 4)。
- `baseMarkdown`/`screenplayId`/`versionId` 等の diff 関連 props は Viewer から外す。

### Unit 4 — `ReviewPanel`(新規, タブ化)

新規 `components/screenplay/ReviewPanel.tsx`:

- `components/ui/tabs.tsx` を使用。タブ: **`試験結果` | `変更点` | `改稿`**。
- props: `{ screenplayId, version, baseMarkdown, initialCheck, isGenerating, onRefineStart }`
  (`version` は選択中の `ScreenplayVersionRow`)。
- 各タブ本文:
  - `試験結果` → `<CheckResultPanel screenplayId versionId={version.id} initialCheck initialCheckVersionId onCheckChange />`。
    **件数バッジは ReviewPanel が所有**: `onCheckChange(check)` で受け取った総件数で描画
    (CheckResultPanel 内部 state を親へ持ち上げ → バッジが recheck/版切替に追従)。
  - `変更点` → `<ChangeDiffView baseMarkdown markdown={version.markdown} screenplayId versionId={version.id} />`。
    **タブは常に有効**にし、`version.base_version_id` が無い(初稿)場合はタブ**本文に**
    「初稿のため比較対象なし」の empty state を表示(disabled tab は選択できず文言を出せないため)。
  - `改稿` → `<FeedbackForm screenplayId baseVersionId={version.id} disabled={isGenerating} onStart={onRefineStart} />`。
- パネル外枠: `lg:sticky lg:top-N self-start flex flex-col lg:max-h-[calc(100vh-Nrem)]`、
  タブヘッダ固定 + 本文 `overflow-y-auto min-h-0 flex-1`(自前スクロール)。
- 既定タブ `試験結果`。**改稿完了直後は新バージョンを選択し `変更点` タブを自動選択**(下記)。

### Unit 5 — `ScreenplayWorkspace` 骨格・状態・配線

`components/screenplay/ScreenplayWorkspace.tsx`

- レイアウトを「上部バー全幅 + `[履歴 | 台本 | 検証]` 2-pane 行」に再構成。
- `改稿履歴`(`VersionTimeline`): デスクトップは左 slim レール維持、`<lg` ではドロップダウン/上部セレクタに退避。
- 状態追加: `activeReviewTab: "check" | "diff" | "refine"`(既定 `check`)。
- `handleComplete(versionId)`: まず `refreshList(versionId)` で版リストを更新し、**refresh 後の** version row を確認。
  その version に `base_version_id` があれば `activeReviewTab="diff"`(変更点を即提示)、無ければ `"check"`。
  ※ complete 時点では新 version の `base_version_id` が未取得のことがあるため、必ず refresh 後の row で判定する。
- `ScreenplayHeaderBar` に nav/actions、`ScreenplayViewer` に本文、`ReviewPanel` に検証を委譲。
- `GenerationProgress` は従来どおり中央 pane 上部に表示。

## データフロー / 整合性

- 履歴でバージョン選択 → `selectedId` 更新 → 台本本文・`変更点`(その版 vs `base_version_id`)・
  `試験結果`(その版の check を Unit 1 経由でフェッチ)の 3 つが同期。
- diff は既存の `GET …/versions/[versionId]/changes`(computed diff + AI 理由)をそのまま使用。
- 試験結果は選択版基準に統一(stale 排除)。

## レスポンシブ

- `xl+`: 履歴レール + `[台本 | 検証]` 2 pane(独立スクロール/sticky 高さ適用)。
- `lg`(1024–1279): `[台本 | 検証]` 2 pane + 履歴ドロップダウン(2 pane の独立スクロール/sticky 適用)。
- `< lg`: 縦スタック — 上部バー → 台本 → 検証(タブ)。履歴はドロップダウン。通常フロー(sticky 無効)。

## エラー処理

- Unit 1: check row 無し → 200 `{ check: null }`(パネルは「再チェックで試験を実行」)。
  所有検証失敗 → 404、DB/API 失敗 → 500 `{ error }`(null と区別)。
- パネルのバージョン別 check フェッチ: 500/`error` 時は stale を消してエラー文言を表示。
- `変更点` の理由フェッチ失敗 → 既存どおり diff は描画、理由のみ欠落(キャッシュしない)。

## テスト / 検証

- `npx tsc --noEmit` クリーン。
- `npm run lint` クリーン(クライアント props/hooks 変更が多く、未使用 import・hook deps・JSX 規則は
  tsc では拾えないため必須)。
- 既存 `npm run test:screenplay-diff` 維持。
- Unit 1: skip-guard 付き live smoke(所有検証 404 / GET null / 別 screenplay の versionId 拒否)。
  ※ ローカル GEMINI キーは zero-quota のため POST 実チェックはデプロイ環境で確認。
- デプロイ環境ブラウザ E2E: 改稿で v2 生成 → 上部バー折返しなし・2 pane 独立スクロール・
  `試験結果/変更点/改稿` タブ切替・版切替で試験結果が当該版に追従、を目視。

## 実装順序(安全側, ユーザー推奨)

1. Unit 1: バージョン別 check API
2. Unit 2: `CheckResultPanel` バージョン対応
3. Unit 3: `ScreenplayHeaderBar` 分離 + `ScreenplayViewer` 簡素化
4. Unit 4: `ReviewPanel` タブ化
5. Unit 5: `ScreenplayWorkspace` 骨格 + grid/sticky/レスポンシブ + 配線

## スコープ外 (follow-up)

- 詳細ページのみのルート単位幅拡大(`max-w` 引上げ)。
- 指摘 → 台本該当箇所へのジャンプ/ハイライト。
- バージョン横断の試験結果比較(スコア推移など)。
- `[id]/check/route.ts`(current 固定版)の撤去/置換整理。
