'use client';

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type CategoryData = {
  category: string;
  revenue: number;
  quantity: number;
  profit: number;
};

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

export default function ProductMixChart({ data }: { data: CategoryData[] }) {
  const total = data.reduce((s, d) => s + d.revenue, 0);
  const chartData = data.map((d) => ({
    ...d,
    pct: total > 0 ? Math.round((d.revenue / total) * 1000) / 10 : 0,
  }));

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
              >
                {chartData.map((entry, i) => (
                  <Cell key={entry.category} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: unknown, name: unknown) => [`¥${formatYenShort(Number(value))}`, String(name)]}
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Category legend table */}
        <div className="mt-4 space-y-1.5">
          {chartData.map((d, i) => (
            <div key={d.category} className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                <span className="text-gray-700">{d.category}</span>
              </div>
              <div className="flex items-center gap-3 text-gray-500">
                <span className="font-mono">¥{formatYenShort(d.revenue)}</span>
                <span className="font-mono">{d.quantity.toLocaleString()}個</span>
                <span className="font-mono w-10 text-right">{d.pct}%</span>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
