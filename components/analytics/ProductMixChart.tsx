'use client';

import { useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useLocale } from 'next-intl';

type CategoryData = {
  category: string;
  revenue: number;
  quantity: number;
  profit: number;
};

type ProductData = {
  code: string;
  name: string;
  category: string | null;
  totalRevenue: number;
  totalQuantity: number;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: { name?: string; value?: number }[];
  products: ProductData[];
  isKo: boolean;
};

const KO_CATEGORY_LABELS: Record<string, string> = {
  '医療機器': '의료기기',
  '家電・雑貨': '가전·생활',
  'ゴルフ': '골프',
  '掃除・洗濯': '청소·세탁',
  'キッチン': '주방',
  '美容・運動': '뷰티·운동',
  '靴・バッグ': '신발·가방',
  '化粧品': '화장품',
  'アパレル': '패션',
  '防災・防犯': '안전·보안',
  '食品': '식품',
  '宝飾': '주얼리',
  'その他': '기타',
  '寝具': '침구',
};

function categoryLabel(category: string | null, isKo: boolean): string {
  if (!category) return isKo ? '미분류' : '未分類';
  return isKo ? (KO_CATEGORY_LABELS[category] ?? category) : category;
}

function CategoryTooltip({ active, payload, products, isKo }: CustomTooltipProps) {
  if (!active || !payload || !payload[0]) return null;

  const category = payload[0].name ?? '';
  const revenue = payload[0].value ?? 0;
  const topProducts = products
    .filter((p) => categoryLabel(p.category, isKo) === category)
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
  const top10 = topProducts.slice(0, 10);

  return (
    <div className="bg-card rounded-lg border border-border shadow-lg p-3 text-xs max-w-[280px]">
      <div className="flex items-center justify-between gap-4 mb-2 pb-2 border-b border-border">
        <span className="font-semibold text-foreground">{category}</span>
        <span className="font-mono text-foreground">{isKo ? '₩' : '¥'}{formatMoneyShort(revenue, isKo)}</span>
      </div>
      {top10.length > 0 ? (
        <div className="space-y-1">
          {top10.map((p, i) => (
            <div key={p.code} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-4 text-right text-muted-foreground font-mono flex-shrink-0">{i + 1}</span>
                <span className="text-foreground truncate">{p.name}</span>
              </div>
              <span className="font-mono text-muted-foreground flex-shrink-0">{isKo ? '₩' : '¥'}{formatMoneyShort(p.totalRevenue, isKo)}</span>
            </div>
          ))}
          {topProducts.length > 10 && (
            <div className="text-[10px] text-muted-foreground pl-5 pt-0.5">
              +{topProducts.length - 10}{isKo ? '개' : '件'}
            </div>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground">{isKo ? '데이터 없음' : 'データなし'}</div>
      )}
    </div>
  );
}

const COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#6366f1',
  '#84cc16', '#a855f7',
];

function formatMoneyShort(v: number, isKo: boolean): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}${isKo ? '억' : '億'}`;
  if (v >= 10_000) return `${Math.round(v / 10_000)}${isKo ? '만' : '万'}`;
  return v.toLocaleString();
}

export default function ProductMixChart({
  data,
  products = [],
}: {
  data: CategoryData[];
  products?: ProductData[];
}) {
  const isKo = useLocale() === 'ko';
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const total = data.reduce((s, d) => s + d.revenue, 0);
  const chartData = data.map((d) => ({
    ...d,
    displayCategory: categoryLabel(d.category, isKo),
    pct: total > 0 ? Math.round((d.revenue / total) * 1000) / 10 : 0,
  }));

  const toggleCategory = (category: string) => {
    setExpandedCategory(expandedCategory === category ? null : category);
  };

  return (
    <Card className="border-border">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">{isKo ? '카테고리별 매출 구성' : 'カテゴリ別売上構成'}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="revenue"
                nameKey="displayCategory"
                cx="50%"
                cy="50%"
                outerRadius={90}
                innerRadius={50}
                paddingAngle={2}
                label={({ name, percent }: { name?: string; percent?: number }) =>
                  `${name ?? ''} ${percent ? Math.round(percent * 1000) / 10 : 0}%`
                }
                labelLine={{ stroke: '#d1d5db', strokeWidth: 1 }}
                onClick={(_: unknown, index: number) => {
                  const entry = chartData[index];
                  if (entry) toggleCategory(entry.category);
                }}
                style={{ cursor: 'pointer' }}
              >
                {chartData.map((entry, i) => (
                  <Cell key={entry.category} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip content={<CategoryTooltip products={products} isKo={isKo} />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Category legend with drill-down */}
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
                  onClick={() => hasProducts && toggleCategory(d.category)}
                  className={`w-full flex items-center justify-between text-xs py-1.5 px-2 rounded-lg transition-colors ${
                    hasProducts ? 'hover:bg-muted cursor-pointer' : 'cursor-default'
                  } ${isExpanded ? 'bg-muted' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="text-foreground">{d.displayCategory}</span>
                    {hasProducts && (
                      isExpanded
                        ? <ChevronUp size={12} className="text-muted-foreground" />
                        : <ChevronDown size={12} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <span className="font-mono">{isKo ? '₩' : '¥'}{formatMoneyShort(d.revenue, isKo)}</span>
                    <span className="font-mono">{d.quantity.toLocaleString()}{isKo ? '개' : '個'}</span>
                    <span className="font-mono w-10 text-right">{d.pct}%</span>
                  </div>
                </button>

                {isExpanded && categoryProducts.length > 0 && (
                  <div className="ml-5 mt-1 mb-2 border-l-2 border-border pl-3 space-y-1">
                    {categoryProducts.slice(0, 10).map((p, rank) => (
                      <div key={p.code} className="flex items-center justify-between text-[11px] text-muted-foreground py-0.5">
                        <div className="flex items-center gap-2">
                          <span className="w-4 text-right text-muted-foreground font-mono">{rank + 1}</span>
                          <span className="text-foreground truncate max-w-[180px]">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-mono">{isKo ? '₩' : '¥'}{formatMoneyShort(p.totalRevenue, isKo)}</span>
                          <span className="font-mono">{p.totalQuantity.toLocaleString()}{isKo ? '개' : '個'}</span>
                        </div>
                      </div>
                    ))}
                    {categoryProducts.length > 10 && (
                      <div className="text-[10px] text-muted-foreground pl-6">
                        +{categoryProducts.length - 10}{isKo ? '개' : '件'}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
