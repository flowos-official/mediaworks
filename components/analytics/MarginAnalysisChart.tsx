'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type ProductData = {
  name: string;
  totalRevenue: number;
  totalProfit: number;
  marginRate: number;
};

function formatYenShort(v: number): string {
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `${Math.round(v / 10_000)}万`;
  return v.toLocaleString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function getMarginColor(rate: number): string {
  if (rate >= 20) return '#22c55e';
  if (rate >= 15) return '#84cc16';
  if (rate >= 10) return '#f59e0b';
  return '#ef4444';
}

export default function MarginAnalysisChart({ products }: { products: ProductData[] }) {
  const top15 = [...products]
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 15);

  return (
    <Card className="border-gray-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">商品別粗利分析</CardTitle>
        <p className="text-xs text-gray-400">売上上位15商品 — バーの色は粗利率を表示</p>
      </CardHeader>
      <CardContent>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={top15}
              layout="vertical"
              margin={{ top: 5, right: 20, left: 0, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
              <XAxis
                type="number"
                tickFormatter={formatYenShort}
                tick={{ fontSize: 10, fill: '#9ca3af' }}
              />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tickFormatter={(v) => truncate(v, 12)}
                tick={{ fontSize: 10, fill: '#6b7280' }}
              />
              <Tooltip
                formatter={(value: unknown, name: unknown) => [
                  `¥${Number(value).toLocaleString()}`,
                  name === 'totalRevenue' ? '売上' : '粗利',
                ]}
                labelStyle={{ fontWeight: 600, fontSize: 12 }}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Bar dataKey="totalRevenue" name="売上" radius={[0, 4, 4, 0]} barSize={16}>
                {top15.map((entry) => (
                  <Cell key={entry.name} fill={getMarginColor(entry.marginRate)} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="flex items-center justify-center gap-4 mt-3 text-[10px] text-gray-500">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-green-500" /> 20%+</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-lime-500" /> 15-20%</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-500" /> 10-15%</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-red-500" /> &lt;10%</span>
        </div>
      </CardContent>
    </Card>
  );
}
