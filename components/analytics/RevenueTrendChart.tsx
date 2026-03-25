'use client';

import { useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type TrendData = {
  date: string;
  revenue: number;
  profit: number;
  quantity: number;
  marginRate: number;
};

function formatYenShort(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`;
  if (value >= 10_000) return `${Math.round(value / 10_000)}万`;
  return value.toLocaleString();
}

function formatDate(date: string): string {
  const parts = date.slice(5).split('-');
  return `${parseInt(parts[0])}/${parseInt(parts[1])}`;
}

export default function RevenueTrendChart({
  data,
  period,
}: {
  data: TrendData[];
  period: 'weekly' | 'monthly';
}) {
  const [showProfit, setShowProfit] = useState(true);
  const [showCost, setShowCost] = useState(false);

  const chartData = data.map((d) => ({ ...d, cost: d.revenue - d.profit }));

  return (
    <Card className="border-gray-200">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">売上推移</CardTitle>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowProfit(!showProfit)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                showProfit ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
              }`}
            >
              粗利表示
            </button>
            <button
              type="button"
              onClick={() => setShowCost(!showCost)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                showCost ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'
              }`}
            >
              原価表示
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400">
          {period === 'weekly' ? '週次' : '月次'} | {data.length}期間
        </p>
      </CardHeader>
      <CardContent>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <defs>
                <linearGradient id="colorRevenue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorProfit" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22c55e" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorCost" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f97316" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis
                dataKey="date"
                tickFormatter={period === 'weekly' ? formatDate : (v) => v.slice(5)}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={{ stroke: '#e5e7eb' }}
              />
              <YAxis
                tickFormatter={formatYenShort}
                tick={{ fontSize: 11, fill: '#9ca3af' }}
                axisLine={{ stroke: '#e5e7eb' }}
                width={55}
              />
              <Tooltip
                formatter={(value: unknown, name: unknown) => {
                  const labels: Record<string, string> = { revenue: '売上', profit: '粗利', cost: '原価' };
                  return [`¥${Number(value).toLocaleString()}`, labels[name as string] ?? name];
                }}
                labelFormatter={(label) =>
                  period === 'weekly' ? `Week: ${label}` : `Month: ${label}`
                }
                contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e5e7eb' }}
              />
              <Legend
                formatter={(value) => {
                  const labels: Record<string, string> = { revenue: '売上', profit: '粗利', cost: '原価' };
                  return labels[value] ?? value;
                }}
                wrapperStyle={{ fontSize: 12 }}
              />
              <Area
                type="monotone"
                dataKey="revenue"
                stroke="#3b82f6"
                fill="url(#colorRevenue)"
                strokeWidth={2}
              />
              {showProfit && (
                <Area
                  type="monotone"
                  dataKey="profit"
                  stroke="#22c55e"
                  fill="url(#colorProfit)"
                  strokeWidth={2}
                />
              )}
              {showCost && (
                <Area
                  type="monotone"
                  dataKey="cost"
                  stroke="#f97316"
                  fill="url(#colorCost)"
                  strokeWidth={2}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
