'use client';

import { useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChevronDown, ChevronUp } from 'lucide-react';

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
};

function CategoryTooltip({ active, payload, products }: CustomTooltipProps) {
  if (!active || !payload || !payload[0]) return null;

  const category = payload[0].name ?? '';
  const revenue = payload[0].value ?? 0;
  const topProducts = products
    .filter((p) => p.category === category)
    .sort((a, b) => b.totalRevenue - a.totalRevenue);
  const top10 = topProducts.slice(0, 10);

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-lg p-3 text-xs max-w-[280px]">
      <div className="flex items-center justify-between gap-4 mb-2 pb-2 border-b border-gray-100">
        <span className="font-semibold text-gray-800">{category}</span>
        <span className="font-mono text-gray-600">&yen;{formatYenShort(revenue)}</span>
      </div>
      {top10.length > 0 ? (
        <div className="space-y-1">
          {top10.map((p, i) => (
            <div key={p.code} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-4 text-right text-gray-400 font-mono flex-shrink-0">{i + 1}</span>
                <span className="text-gray-700 truncate">{p.name}</span>
              </div>
              <span className="font-mono text-gray-500 flex-shrink-0">&yen;{formatYenShort(p.totalRevenue)}</span>
            </div>
          ))}
          {topProducts.length > 10 && (
            <div className="text-[10px] text-gray-400 pl-5 pt-0.5">
              +{topProducts.length - 10}件
            </div>
          )}
        </div>
      ) : (
        <div className="text-gray-400">データなし</div>
      )}
    </div>
  );
}

const COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#f97316', '#14b8a6', '#6366f1',
  '#84cc16', '#a855f7',
];

function formatYenShort(v: number): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${Math.round(v / 10_000)}万`;
  return v.toLocaleString();
}

export default function ProductMixChart({
  data,
  products = [],
}: {
  data: CategoryData[];
  products?: ProductData[];
}) {
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  const total = data.reduce((s, d) => s + d.revenue, 0);
  const chartData = data.map((d) => ({
    ...d,
    pct: total > 0 ? Math.round((d.revenue / total) * 1000) / 10 : 0,
  }));

  const toggleCategory = (category: string) => {
    setExpandedCategory(expandedCategory === category ? null : category);
  };

  return (
    <Card className="border-gray-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">カテゴリ別売上構成</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={chartData}
                dataKey="revenue"
                nameKey="category"
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
              <Tooltip content={<CategoryTooltip products={products} />} />
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
                    <span className="font-mono">&yen;{formatYenShort(d.revenue)}</span>
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
                          <span className="font-mono">&yen;{formatYenShort(p.totalRevenue)}</span>
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
      </CardContent>
    </Card>
  );
}
