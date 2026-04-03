# Stakeholder Feedback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve 4 stakeholder feedback items: fix PDF upload, expand distribution channels with Japanese TV stations, add product drill-down to pie chart, and add live commerce tool.

**Architecture:** Each feedback item is an independent task that can be parallelized. Tasks 1 (PDF fix) and 3 (pie chart) are UI-only changes. Task 2 (distribution channels) spans prompt + types + UI. Task 4 (live commerce) adds a new report section end-to-end.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind CSS, shadcn/ui, Recharts, Google Gemini API, Supabase, next-intl

---

## File Structure

### Modified Files
| File | Responsibility | Tasks |
|------|---------------|-------|
| `components/FileUpload.tsx` | Client-side file validation + upload UI | Task 1 |
| `lib/gemini.ts` | Gemini prompts, `ResearchOutput` type | Tasks 2, 4 |
| `components/report/DistributionChannelSection.tsx` | Distribution channel report UI | Task 2 |
| `lib/tv-channels.ts` | **New** - Japanese TV shopping channel reference data | Task 2 |
| `components/analytics/ProductMixChart.tsx` | Category pie chart | Task 3 |
| `components/analytics/AnalyticsDashboard.tsx` | Dashboard data wiring | Task 3 |
| `components/report/LiveCommerceSection.tsx` | **New** - Live commerce report section | Task 4 |
| `app/api/analyze/synthesize/route.ts` | Synthesis API - save new fields | Task 4 |
| `app/[locale]/products/[id]/page.tsx` | Report page - render new section | Task 4 |
| `messages/ja.json` | Japanese translations | Tasks 2, 4 |
| `messages/en.json` | English translations | Tasks 2, 4 |

---

## Chunk 1: PDF Upload Fix + Pie Chart Drill-Down

### Task 1: Fix PDF Upload — Client-Side MIME Validation

**Problem:** `FileUpload.tsx` line 37 filters by `ACCEPTED.includes(f.type)`, but some browsers (Safari, mobile WebViews) report empty or incorrect MIME types for PDFs. The server already has extension-based fallback (`resolveMimeType` in `upload/route.ts`), but files are rejected before reaching the server.

**Files:**
- Modify: `components/FileUpload.tsx:36-46`

- [ ] **Step 1: Add extension-based fallback to client-side validation**

In `components/FileUpload.tsx`, replace the `handleFiles` filter logic:

```tsx
// Old (line 37):
const files = Array.from(fileList).filter((f) => ACCEPTED.includes(f.type));

// New — also accept files by extension when MIME is empty/wrong:
const ACCEPTED_EXTENSIONS = new Set([
  '.pdf', '.ppt', '.pptx', '.doc', '.docx', '.xls', '.xlsx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
]);

const files = Array.from(fileList).filter((f) => {
  if (ACCEPTED.includes(f.type)) return true;
  const ext = f.name.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return ext ? ACCEPTED_EXTENSIONS.has(ext) : false;
});
```

Move `ACCEPTED_EXTENSIONS` to module scope (below the `ACCEPTED` array, around line 24).

- [ ] **Step 2: Verify the fix locally**

Run: `npm run dev`
Test: Try uploading a PDF file in the browser. If on Safari/mobile, verify that PDFs with empty MIME type are accepted.

- [ ] **Step 3: Commit**

```bash
git add components/FileUpload.tsx
git commit -m "fix: accept PDF uploads when browser reports empty MIME type

Add extension-based fallback to client-side file validation.
The server already had this fallback, but the client was rejecting
files before they reached the server."
```

---

### Task 2: Pie Chart — Add Product Drill-Down per Category

**Problem:** `ProductMixChart.tsx` shows a donut chart of category revenue but clicking a slice does nothing. Stakeholder wants to see individual products ranked by revenue within each category.

**Data availability:** `AnalyticsDashboard.tsx` already fetches `products.products` from `/api/analytics/products?limit=500` which returns `{ code, name, category, totalRevenue, totalQuantity, ... }`. This data just needs to be passed down.

**Files:**
- Modify: `components/analytics/ProductMixChart.tsx`
- Modify: `components/analytics/AnalyticsDashboard.tsx:160-163`

- [ ] **Step 1: Update ProductMixChart props to accept product-level data**

In `components/analytics/ProductMixChart.tsx`, update the types and add state:

```tsx
// Add to imports
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

// Add product type
type ProductData = {
  code: string;
  name: string;
  category: string | null;
  totalRevenue: number;
  totalQuantity: number;
};

// Update component signature
export default function ProductMixChart({
  data,
  products = [],
}: {
  data: CategoryData[];
  products?: ProductData[];
}) {
```

- [ ] **Step 2: Add category expansion state and drill-down UI**

After the existing legend table (`<div className="mt-4 space-y-1.5">`), replace it with a clickable version:

```tsx
const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

// Replace the legend section (lines 68-83) with:
<div className="mt-4 space-y-1">
  {chartData.map((d, i) => {
    const isExpanded = expandedCategory === d.category;
    const categoryProducts = products
      .filter((p) => p.category === d.category)
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
    const hasProducts = categoryProducts.length > 0;

    return (
      <div key={d.category}>
        <button
          type="button"
          onClick={() => hasProducts && setExpandedCategory(isExpanded ? null : d.category)}
          className={`w-full flex items-center justify-between text-xs py-1.5 px-2 rounded-lg transition-colors ${
            hasProducts ? 'hover:bg-gray-50 cursor-pointer' : 'cursor-default'
          } ${isExpanded ? 'bg-gray-50' : ''}`}
        >
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
            <span className="text-gray-700">{d.category}</span>
            {hasProducts && (
              isExpanded
                ? <ChevronUp size={12} className="text-gray-400" />
                : <ChevronDown size={12} className="text-gray-400" />
            )}
          </div>
          <div className="flex items-center gap-3 text-gray-500">
            <span className="font-mono">{'\u00A5'}{formatYenShort(d.revenue)}</span>
            <span className="font-mono">{d.quantity.toLocaleString()}個</span>
            <span className="font-mono w-10 text-right">{d.pct}%</span>
          </div>
        </button>

        {isExpanded && categoryProducts.length > 0 && (
          <div className="ml-5 mt-1 mb-2 border-l-2 border-gray-200 pl-3 space-y-1">
            {categoryProducts.slice(0, 10).map((p, rank) => (
              <div key={p.code} className="flex items-center justify-between text-[11px] text-gray-500 py-0.5">
                <div className="flex items-center gap-2">
                  <span className="w-4 text-right text-gray-400 font-mono">{rank + 1}</span>
                  <span className="text-gray-700 truncate max-w-[180px]">{p.name}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono">{'\u00A5'}{formatYenShort(p.totalRevenue)}</span>
                  <span className="font-mono">{p.totalQuantity.toLocaleString()}個</span>
                </div>
              </div>
            ))}
            {categoryProducts.length > 10 && (
              <div className="text-[10px] text-gray-400 pl-6">
                +{categoryProducts.length - 10}件
              </div>
            )}
          </div>
        )}
      </div>
    );
  })}
</div>
```

- [ ] **Step 3: Pass products data from AnalyticsDashboard**

In `components/analytics/AnalyticsDashboard.tsx`, update line 160-163:

```tsx
// Old:
<ProductMixChart
  data={(overview as { categoryBreakdown: Parameters<typeof ProductMixChart>[0]['data'] }).categoryBreakdown ?? []}
/>

// New:
<ProductMixChart
  data={(overview as { categoryBreakdown: Parameters<typeof ProductMixChart>[0]['data'] }).categoryBreakdown ?? []}
  products={(products?.products as { code: string; name: string; category: string | null; totalRevenue: number; totalQuantity: number }[]) ?? []}
/>
```

- [ ] **Step 4: Also make pie slices clickable to expand**

Add an `onClick` handler to the Pie component:

```tsx
<Pie
  data={chartData}
  dataKey="revenue"
  nameKey="category"
  cx="50%"
  cy="50%"
  outerRadius={90}
  innerRadius={50}
  paddingAngle={2}
  onClick={(entry: { category?: string }) => {
    if (entry?.category) {
      setExpandedCategory(
        expandedCategory === entry.category ? null : entry.category
      );
    }
  }}
  style={{ cursor: 'pointer' }}
  // ... keep existing label and labelLine props
>
```

- [ ] **Step 5: Verify locally**

Run: `npm run dev`
Navigate to analytics page. Click pie chart slices and category legend items — verify products list expands with rankings.

- [ ] **Step 6: Commit**

```bash
git add components/analytics/ProductMixChart.tsx components/analytics/AnalyticsDashboard.tsx
git commit -m "feat: add product drill-down to category pie chart

Click a pie slice or category legend item to expand and see
individual products ranked by revenue within that category.
Shows top 10 products per category."
```

---

## Chunk 2: Distribution Channels — Japanese TV Stations

### Task 3: Add Japanese TV Shopping Channel Reference Data

**Files:**
- Create: `lib/tv-channels.ts`

- [ ] **Step 1: Create the TV channel reference data file**

Create `lib/tv-channels.ts`:

```ts
export interface TVChannel {
  name: string;
  url: string;
  type: 'TV通販' | 'EC' | 'カタログ通販' | 'クラウドファンディング' | 'その他';
  broadcaster?: string;
  description: string;
}

export const JP_TV_SHOPPING_CHANNELS: TVChannel[] = [
  { name: 'ショップチャンネル', url: 'https://www.shopch.jp/', type: 'TV通販', broadcaster: 'Jupiter Shop Channel', description: '日本最大のTVショッピング専門チャンネル。24時間生放送。' },
  { name: 'QVC Japan', url: 'https://qvc.jp/', type: 'TV通販', broadcaster: 'QVC', description: '米国QVC傘下。ライブ感のある商品紹介が強み。' },
  { name: '日テレポシュレ', url: 'https://shop.ntv.co.jp/s/tvshopping/', type: 'TV通販', broadcaster: '日本テレビ', description: '日テレ通販。バラエティ番組連動商品が多い。' },
  { name: 'TBSショッピング', url: 'https://www.tbs.co.jp/shopping/', type: 'TV通販', broadcaster: 'TBS', description: 'TBS系列の通販。情報番組との連動。' },
  { name: 'ディノス', url: 'https://www.dinos.co.jp/tv/', type: 'TV通販', broadcaster: 'フジテレビ', description: 'フジテレビ系列。カタログ通販からTV通販まで幅広い。' },
  { name: 'ロッピングライフ', url: 'https://ropping.tv-asahi.co.jp/', type: 'TV通販', broadcaster: 'テレビ朝日', description: 'テレ朝系通販。じゅん散歩等の番組連動。' },
  { name: 'せのぶら本舗', url: 'https://shop.asahi.co.jp/category/SENOBURA/', type: 'TV通販', broadcaster: '朝日放送', description: '朝日放送系列の通販番組。' },
  { name: 'いちばん本舗', url: 'https://shop.tokai-tv.com/shop/', type: 'TV通販', broadcaster: '東海テレビ', description: '東海テレビの通販番組。中部地方メイン。' },
  { name: 'カチモ', url: 'https://kachimo.jp/', type: 'TV通販', broadcaster: 'テレビ東京', description: 'テレビ東京の通販サイト。' },
  { name: '関テレショッピング', url: 'https://ktvolm.jp/', type: 'TV通販', broadcaster: '関西テレビ', description: '関西テレビ系列。関西圏メイン。' },
];

export const JP_OTHER_SHOPPING_SITES: TVChannel[] = [
  { name: '梶原産業', url: 'https://www.kajihara.co.jp/business/', type: 'その他', description: '卸売・流通業者。' },
  { name: 'カタログハウス', url: 'http://www.cataloghouse.co.jp/', type: 'カタログ通販', description: '老舗カタログ通販。通販生活。' },
  { name: 'ニッセン', url: 'https://www.nissen.co.jp/', type: 'カタログ通販', description: '大手カタログ通販。' },
  { name: 'Makuake', url: 'https://www.makuake.com/', type: 'クラウドファンディング', description: '応援購入型クラファン。新商品ローンチに最適。' },
  { name: 'ビックカメラ', url: 'https://www.biccamera.com/', type: 'EC', description: '大手家電量販店EC。' },
  { name: 'ファミリーライフ', url: 'http://family-life.biz/', type: 'EC', description: '生活用品EC。' },
  { name: '通販歳時記', url: 'https://www.tsuhan-saijiki.jp/', type: 'その他', description: '通販業界情報サイト。' },
];

/** Build a prompt-friendly list of all channels for Gemini */
export function buildChannelReferencePrompt(): string {
  const tvLines = JP_TV_SHOPPING_CHANNELS.map(
    (ch) => `- ${ch.name} (${ch.broadcaster ?? ''}): ${ch.url} — ${ch.description}`
  ).join('\n');

  const otherLines = JP_OTHER_SHOPPING_SITES.map(
    (ch) => `- ${ch.name} [${ch.type}]: ${ch.url} — ${ch.description}`
  ).join('\n');

  return `=== 日本TV通販チャンネル一覧 ===\n${tvLines}\n\n=== その他ショッピングサイト ===\n${otherLines}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/tv-channels.ts
git commit -m "feat: add Japanese TV shopping channel reference data

10 TV shopping channels + 7 other shopping sites from stakeholder's
reference Excel file. Includes URLs, broadcaster names, descriptions."
```

---

### Task 4: Update Gemini Prompt to Analyze Each TV Station

**Files:**
- Modify: `lib/gemini.ts:59-67` (ResearchOutput type — distribution_channels)
- Modify: `lib/gemini.ts:224-234` (synthesis prompt — distribution_channels section)

- [ ] **Step 1: Add `url` and `broadcaster` fields to distribution_channels type**

In `lib/gemini.ts`, update the `distribution_channels` array item type (lines 59-67):

```ts
distribution_channels?: Array<{
  channel_name: string;
  channel_type: string;
  primary_age_group: string;
  fit_score: number;
  reason: string;
  monthly_visitors?: string;
  commission_rate?: string;
  url?: string;
  broadcaster?: string;
}>;
```

- [ ] **Step 2: Update the synthesis prompt to include TV channel reference data**

In `lib/gemini.ts`, add import at top:

```ts
import { buildChannelReferencePrompt } from "@/lib/tv-channels";
```

In the `synthesizeResearch` function, update the prompt. Before the `Web Search Results:` section (~line 162), add:

```ts
${buildChannelReferencePrompt()}
```

Update the distribution_channels JSON instruction (lines 224-234) to:

```
  "distribution_channels": [
    {
      "channel_name": "<channel name>",
      "channel_type": "<TV通販 | EC | SNSコマース | カタログ通販 | クラウドファンディング | オフライン>",
      "primary_age_group": "<e.g. 40-60代女性>",
      "fit_score": <0-100>,
      "reason": "<why this channel fits the product in Japanese>",
      "monthly_visitors": "<optional, e.g. 月間5,000万人>",
      "commission_rate": "<optional, e.g. 10-15%>",
      "url": "<channel URL>",
      "broadcaster": "<TV broadcaster name, if applicable>"
    }
  ],
```

Update the IMPORTANT section at the bottom (~line 288) to change:
```
- Provide 4-6 distribution_channels relevant to Japan market
```
to:
```
- Provide 10-15 distribution_channels. MUST include ALL 10 Japanese TV shopping channels listed above with individual fit_score for each. Also include 3-5 EC/other channels.
```

- [ ] **Step 3: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat: update Gemini prompt to analyze all Japanese TV shopping channels

Now requires Gemini to score all 10 TV shopping channels individually,
plus EC and other channels. Adds url and broadcaster fields."
```

---

### Task 5: Update DistributionChannelSection UI — Group by Type + Show URLs

**Files:**
- Modify: `components/report/DistributionChannelSection.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: Add translation keys for channel grouping**

In `messages/ja.json`, update the `distribution` object:

```json
"distribution": {
  "title": "流通チャネル分析",
  "fitScore": "適合度",
  "visitors": "訪問者:",
  "commission": "手数料:",
  "tvShopping": "TV通販",
  "ec": "EC・オンラインモール",
  "sns": "SNSコマース",
  "other": "その他チャネル",
  "visitSite": "サイトを見る"
}
```

In `messages/en.json`, update the `distribution` object:

```json
"distribution": {
  "title": "Distribution Channel Analysis",
  "fitScore": "Fit Score",
  "visitors": "Visitors:",
  "commission": "Commission:",
  "tvShopping": "TV Shopping",
  "ec": "EC / Online Marketplace",
  "sns": "SNS Commerce",
  "other": "Other Channels",
  "visitSite": "Visit Site"
}
```

- [ ] **Step 2: Rewrite DistributionChannelSection to group channels by type**

Replace the full content of `components/report/DistributionChannelSection.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Tv, ShoppingCart, Share2, MoreHorizontal, ExternalLink } from "lucide-react";

interface Channel {
  channel_name: string;
  channel_type: string;
  primary_age_group: string;
  fit_score: number;
  reason: string;
  monthly_visitors?: string;
  commission_rate?: string;
  url?: string;
  broadcaster?: string;
}

const TYPE_CONFIG: Record<string, { color: string; icon: typeof Tv; groupKey: string }> = {
  "TV通販": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
  "TVホームショッピング": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
  "TV홈쇼핑": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
  "EC": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
  "カタログ通販": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
  "クラウドファンディング": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
  "SNSコマース": { color: "bg-pink-100 text-pink-800", icon: Share2, groupKey: "sns" },
  "SNS커머스": { color: "bg-pink-100 text-pink-800", icon: Share2, groupKey: "sns" },
  "オフライン": { color: "bg-orange-100 text-orange-800", icon: MoreHorizontal, groupKey: "other" },
  "오프라인": { color: "bg-orange-100 text-orange-800", icon: MoreHorizontal, groupKey: "other" },
  "その他": { color: "bg-gray-100 text-gray-800", icon: MoreHorizontal, groupKey: "other" },
};

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-green-500" :
    score >= 60 ? "bg-blue-500" :
    score >= 40 ? "bg-yellow-500" : "bg-red-400";

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs font-bold tabular-nums w-8 text-right">{score}</span>
    </div>
  );
}

function ChannelCard({ ch, t }: { ch: Channel; t: ReturnType<typeof useTranslations> }) {
  const cfg = TYPE_CONFIG[ch.channel_type] ?? TYPE_CONFIG["その他"];

  return (
    <div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold text-sm">{ch.channel_name}</h4>
          {ch.broadcaster && (
            <p className="text-[11px] text-gray-400 mt-0.5">{ch.broadcaster}</p>
          )}
          <p className="text-xs text-gray-500 mt-0.5">{ch.primary_age_group}</p>
        </div>
        <Badge className={`text-[10px] ${cfg.color}`}>
          {ch.channel_type}
        </Badge>
      </div>
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>{t("distribution.fitScore")}</span>
        </div>
        <ScoreBar score={ch.fit_score} />
      </div>
      <p className="text-xs text-gray-600 leading-relaxed">{ch.reason}</p>
      <div className="flex items-center justify-between mt-3">
        <div className="flex gap-3 text-[11px] text-gray-400">
          {ch.monthly_visitors && (
            <span>{t("distribution.visitors")} {ch.monthly_visitors}</span>
          )}
          {ch.commission_rate && (
            <span>{t("distribution.commission")} {ch.commission_rate}</span>
          )}
        </div>
        {ch.url && (
          <a
            href={ch.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
          >
            <ExternalLink size={10} />
            {t("distribution.visitSite")}
          </a>
        )}
      </div>
    </div>
  );
}

const GROUP_ORDER = ["tvShopping", "ec", "sns", "other"];

interface DistributionChannelSectionProps {
  channels: Channel[];
}

export default function DistributionChannelSection({ channels }: DistributionChannelSectionProps) {
  const t = useTranslations("report");
  if (!channels || channels.length === 0) return null;

  // Group channels by type
  const groups: Record<string, Channel[]> = {};
  for (const ch of channels) {
    const cfg = TYPE_CONFIG[ch.channel_type] ?? TYPE_CONFIG["その他"];
    const groupKey = cfg.groupKey;
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(ch);
  }

  // Sort within each group by fit_score desc
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => b.fit_score - a.fit_score);
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center gap-2 mb-5">
          <TrendingUp className="h-5 w-5 text-blue-500" />
          <h3 className="text-lg font-semibold text-gray-900">{t("distribution.title")}</h3>
        </div>

        <div className="space-y-6">
          {GROUP_ORDER.map((groupKey) => {
            const groupChannels = groups[groupKey];
            if (!groupChannels || groupChannels.length === 0) return null;

            const Icon = TYPE_CONFIG[
              Object.keys(TYPE_CONFIG).find(
                (k) => TYPE_CONFIG[k].groupKey === groupKey
              ) ?? "その他"
            ]?.icon ?? MoreHorizontal;

            return (
              <div key={groupKey}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon size={16} className="text-gray-500" />
                  <h4 className="text-sm font-semibold text-gray-700">
                    {t(`distribution.${groupKey}` as Parameters<typeof t>[0])}
                  </h4>
                  <span className="text-xs text-gray-400">({groupChannels.length})</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {groupChannels.map((ch, i) => (
                    <ChannelCard key={ch.channel_name || i} ch={ch} t={t} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Verify locally**

Run: `npm run dev`
Open an existing product report that has distribution_channels data. Verify channels are grouped by type. New reports will include all 10 TV stations.

- [ ] **Step 4: Commit**

```bash
git add components/report/DistributionChannelSection.tsx messages/ja.json messages/en.json
git commit -m "feat: group distribution channels by type, show TV station details

Channels now grouped into TV Shopping, EC, SNS, Other sections.
Each card shows broadcaster name, URL link, and fit score.
Added translation keys for group headers."
```

---

## Chunk 3: Live Commerce Tool

### Task 6: Add Live Commerce Section — Types + Prompt

**Files:**
- Modify: `lib/gemini.ts` (ResearchOutput type + synthesis prompt)

- [ ] **Step 1: Add live_commerce type to ResearchOutput**

In `lib/gemini.ts`, add to the `ResearchOutput` interface (after `korea_market_fit`, around line 106):

```ts
live_commerce?: {
  platforms: Array<{
    platform_name: string;
    platform_type: string;
    target_audience: string;
    fit_score: number;
    reason: string;
  }>;
  scripts: {
    instagram_live: string;
    tiktok_live: string;
    youtube_live: string;
  };
  talking_points: string[];
  engagement_tips: string[];
  recommended_products_angle: string;
};
```

- [ ] **Step 2: Add live_commerce section to the Gemini synthesis prompt**

In the synthesis prompt JSON structure (inside `synthesizeResearch`), add after the `korea_market_fit` section:

```
  "live_commerce": {
    "platforms": [
      {
        "platform_name": "<e.g. Instagram Live, TikTok Live, YouTube Live, 楽天ROOM LIVE>",
        "platform_type": "<SNS | EC連携 | 独自プラットフォーム>",
        "target_audience": "<e.g. 20-30代女性、美容・ファッション関心層>",
        "fit_score": <0-100>,
        "reason": "<why this platform fits the product, in Japanese>"
      }
    ],
    "scripts": {
      "instagram_live": "<3-5 minute Instagram Live script in Japanese with host cues, product demo timing, CTA>",
      "tiktok_live": "<3-5 minute TikTok Live script in Japanese, fast-paced, trend-aware, with engagement hooks>",
      "youtube_live": "<5-10 minute YouTube Live script in Japanese, detailed product review style, with Q&A prompts>"
    },
    "talking_points": ["<key selling point 1>", "<key selling point 2>", "<key selling point 3>", "<key selling point 4>", "<key selling point 5>"],
    "engagement_tips": ["<tip for boosting live viewer engagement 1>", "<tip 2>", "<tip 3>"],
    "recommended_products_angle": "<the best angle/narrative for presenting this product in live commerce, in Japanese>"
  }
```

Update the IMPORTANT section to add:
```
- live_commerce should include 3-4 platform analyses, scripts for each major platform, and 5 talking points
```

- [ ] **Step 3: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat: add live_commerce to research output type and Gemini prompt

Adds platform analysis, platform-specific scripts (Instagram/TikTok/YouTube),
talking points, engagement tips, and recommended product angle."
```

---

### Task 7: Save Live Commerce Data in Synthesize Route

**Files:**
- Modify: `app/api/analyze/synthesize/route.ts:74`

- [ ] **Step 1: Add live_commerce to raw_json save**

The `raw_json` field already stores the full `research` object (line 74-78), so `live_commerce` is already persisted there. However, the research data is read back from `raw_json.research` in the product page. Verify this by checking the products API.

Check: `app/api/products/[id]/route.ts` — confirm it returns `raw_json.research` as the research data.

If the research fields are read individually (not from raw_json), we need to check if the DB table has a column for `live_commerce`. Since the `raw_json` column stores the full research object and the product page reads from it, no route changes are needed unless the page reads individual columns.

- [ ] **Step 2: Verify how research data reaches the report page**

Read `app/api/products/[id]/route.ts` and confirm `research` data flow.

- [ ] **Step 3: Commit (if changes needed)**

```bash
git add app/api/analyze/synthesize/route.ts
git commit -m "feat: ensure live_commerce data persisted in synthesis"
```

---

### Task 8: Create LiveCommerceSection Component

**Files:**
- Create: `components/report/LiveCommerceSection.tsx`
- Modify: `messages/ja.json`
- Modify: `messages/en.json`

- [ ] **Step 1: Add translation keys**

In `messages/ja.json`, add after the `pricing` section:

```json
"liveCommerce": {
  "title": "ライブコマース戦略",
  "platforms": "プラットフォーム適合度",
  "scripts": "ライブ配信スクリプト",
  "instagramLive": "Instagram Live",
  "tiktokLive": "TikTok Live",
  "youtubeLive": "YouTube Live",
  "talkingPoints": "商品トーキングポイント",
  "engagementTips": "エンゲージメント向上Tips",
  "productAngle": "推奨プレゼン切り口"
}
```

In `messages/en.json`, add after the `pricing` section:

```json
"liveCommerce": {
  "title": "Live Commerce Strategy",
  "platforms": "Platform Fit Analysis",
  "scripts": "Live Streaming Scripts",
  "instagramLive": "Instagram Live",
  "tiktokLive": "TikTok Live",
  "youtubeLive": "YouTube Live",
  "talkingPoints": "Product Talking Points",
  "engagementTips": "Engagement Tips",
  "productAngle": "Recommended Product Angle"
}
```

- [ ] **Step 2: Create the LiveCommerceSection component**

Create `components/report/LiveCommerceSection.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Video, Lightbulb, MessageCircle, Target } from "lucide-react";

interface Platform {
  platform_name: string;
  platform_type: string;
  target_audience: string;
  fit_score: number;
  reason: string;
}

interface LiveCommerceData {
  platforms: Platform[];
  scripts: {
    instagram_live: string;
    tiktok_live: string;
    youtube_live: string;
  };
  talking_points: string[];
  engagement_tips: string[];
  recommended_products_angle: string;
}

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-green-500" :
    score >= 60 ? "bg-blue-500" :
    score >= 40 ? "bg-yellow-500" : "bg-red-400";

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums w-8 text-right">{score}</span>
    </div>
  );
}

const SCRIPT_TABS = [
  { key: "instagram_live" as const, label: "instagramLive", color: "bg-gradient-to-r from-purple-500 to-pink-500" },
  { key: "tiktok_live" as const, label: "tiktokLive", color: "bg-black" },
  { key: "youtube_live" as const, label: "youtubeLive", color: "bg-red-600" },
];

export default function LiveCommerceSection({ data }: { data: LiveCommerceData }) {
  const t = useTranslations("report");
  const [activeScript, setActiveScript] = useState<"instagram_live" | "tiktok_live" | "youtube_live">("instagram_live");

  return (
    <div className="space-y-4">
      {/* Platform Fit Analysis */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-5">
            <Video className="h-5 w-5 text-pink-500" />
            <h3 className="text-lg font-semibold text-gray-900">{t("liveCommerce.title")}</h3>
          </div>

          {/* Platforms */}
          <h4 className="text-sm font-semibold text-gray-700 mb-3">{t("liveCommerce.platforms")}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            {data.platforms.map((p, i) => (
              <div key={p.platform_name || i} className="border border-gray-100 rounded-xl p-4 bg-gray-50/50">
                <div className="flex items-start justify-between mb-2">
                  <h5 className="font-semibold text-sm">{p.platform_name}</h5>
                  <Badge className="text-[10px] bg-pink-100 text-pink-800">{p.platform_type}</Badge>
                </div>
                <p className="text-xs text-gray-500 mb-2">{p.target_audience}</p>
                <ScoreBar score={p.fit_score} />
                <p className="text-xs text-gray-600 leading-relaxed mt-2">{p.reason}</p>
              </div>
            ))}
          </div>

          {/* Product Angle */}
          {data.recommended_products_angle && (
            <div className="bg-pink-50 rounded-xl p-4 mb-6">
              <div className="flex items-center gap-2 mb-2">
                <Target size={14} className="text-pink-600" />
                <h4 className="text-sm font-semibold text-pink-800">{t("liveCommerce.productAngle")}</h4>
              </div>
              <p className="text-sm text-pink-900 leading-relaxed">{data.recommended_products_angle}</p>
            </div>
          )}

          {/* Talking Points */}
          {data.talking_points && data.talking_points.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <MessageCircle size={14} className="text-blue-600" />
                <h4 className="text-sm font-semibold text-gray-700">{t("liveCommerce.talkingPoints")}</h4>
              </div>
              <div className="space-y-2">
                {data.talking_points.map((point, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="flex-shrink-0 w-5 h-5 bg-blue-100 text-blue-700 rounded-full text-xs flex items-center justify-center font-bold mt-0.5">
                      {i + 1}
                    </span>
                    {point}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Engagement Tips */}
          {data.engagement_tips && data.engagement_tips.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <Lightbulb size={14} className="text-yellow-600" />
                <h4 className="text-sm font-semibold text-gray-700">{t("liveCommerce.engagementTips")}</h4>
              </div>
              <div className="space-y-2">
                {data.engagement_tips.map((tip, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-gray-600 bg-yellow-50 rounded-lg p-3">
                    <Lightbulb size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
                    {tip}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live Scripts */}
      <Card>
        <CardContent className="p-6">
          <h4 className="text-sm font-semibold text-gray-700 mb-4">{t("liveCommerce.scripts")}</h4>

          {/* Tab bar */}
          <div className="flex gap-2 mb-4">
            {SCRIPT_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveScript(tab.key)}
                className={`px-4 py-2 text-xs font-medium rounded-lg transition-all ${
                  activeScript === tab.key
                    ? `${tab.color} text-white shadow-sm`
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t(`liveCommerce.${tab.label}` as Parameters<typeof t>[0])}
              </button>
            ))}
          </div>

          {/* Script content */}
          <div className="bg-gray-50 rounded-xl p-5 border border-gray-100">
            <pre className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap font-sans">
              {data.scripts[activeScript]}
            </pre>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add components/report/LiveCommerceSection.tsx messages/ja.json messages/en.json
git commit -m "feat: add LiveCommerceSection component with platform analysis and scripts

Shows platform fit scores, talking points, engagement tips,
and tabbed live streaming scripts for Instagram/TikTok/YouTube."
```

---

### Task 9: Wire LiveCommerceSection into Report Page

**Files:**
- Modify: `app/[locale]/products/[id]/page.tsx`

- [ ] **Step 1: Import and render LiveCommerceSection**

Add import at top:

```tsx
import LiveCommerceSection from '@/components/report/LiveCommerceSection';
```

Add after the Korea Market section (after line 164, before the closing `</div>`):

```tsx
{/* Live Commerce */}
{research.live_commerce && (
  <LiveCommerceSection data={research.live_commerce} />
)}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add app/[locale]/products/[id]/page.tsx
git commit -m "feat: render live commerce section in product report page"
```

---

## Chunk 4: Verify + Final Commit

### Task 10: Full Build Verification

- [ ] **Step 1: Run lint**

```bash
npm run lint
```
Expected: No errors.

- [ ] **Step 2: Run build**

```bash
npm run build
```
Expected: Successful build, no TypeScript errors.

- [ ] **Step 3: Manual smoke test**

Run: `npm run dev`
Test:
1. Upload a PDF file — verify it's accepted (not rejected by MIME filter)
2. Open analytics page — click a pie chart slice — verify product drill-down shows
3. Open an existing product report — verify distribution channels are grouped
4. Trigger a new product analysis — verify the report includes live commerce section and all 10 TV stations in distribution channels

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address any remaining issues from smoke test"
```
