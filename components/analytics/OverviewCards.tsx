'use client';

import { TrendingUp, TrendingDown, DollarSign, Package, BarChart3 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';

type KpiData = {
  totalRevenue: number;
  totalProfit: number;
  totalQuantity: number;
  marginRate: number;
  uniqueProducts: number;
  weekCount: number;
  yearlyKpis: Record<string, { revenue: number; profit: number; quantity: number }>;
};

function formatMoney(value: number, isKo: boolean): string {
  if (value >= 100_000_000) return `${isKo ? '₩' : '¥'}${(value / 100_000_000).toFixed(1)}${isKo ? '억' : '億'}`;
  if (value >= 10_000) return `${isKo ? '₩' : '¥'}${(value / 10_000).toFixed(0)}${isKo ? '만' : '万'}`;
  return `${isKo ? '₩' : '¥'}${value.toLocaleString()}`;
}

function YoyChange({ current, previous }: { current: number; previous: number }) {
  if (!previous) return null;
  const pct = ((current - previous) / previous) * 100;
  const isUp = pct >= 0;
  return (
    <span className={`flex items-center gap-0.5 text-xs font-medium ${isUp ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
      {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {isUp ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

export default function OverviewCards({ data }: { data: KpiData }) {
  const t = useTranslations('overviewCards');
  const isKo = useLocale() === 'ko';
  const years = Object.keys(data.yearlyKpis).map(Number).sort();
  const prev = years.length >= 2 ? data.yearlyKpis[years[0]] : null;
  const curr = years.length >= 2 ? data.yearlyKpis[years[years.length - 1]] : null;

  const cards = [
    {
      label: t('totalRevenue'),
      value: formatMoney(data.totalRevenue, isKo),
      icon: DollarSign,
      color: 'text-blue-600 bg-blue-600/10',
      yoy: prev && curr ? { current: curr.revenue, previous: prev.revenue } : null,
    },
    {
      label: t('totalProfit'),
      value: formatMoney(data.totalProfit, isKo),
      icon: TrendingUp,
      color: 'text-green-600 bg-green-600/10',
      yoy: prev && curr ? { current: curr.profit, previous: prev.profit } : null,
    },
    {
      label: t('totalQuantity'),
      value: data.totalQuantity.toLocaleString(),
      icon: Package,
      color: 'text-orange-600 bg-orange-600/10',
      yoy: prev && curr ? { current: curr.quantity, previous: prev.quantity } : null,
    },
    {
      label: t('productCount'),
      value: data.uniqueProducts.toString(),
      icon: BarChart3,
      color: 'text-cyan-600 bg-cyan-600/10',
      yoy: null,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label} className="relative overflow-hidden">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{card.label}</span>
              <div className={`p-1.5 rounded-lg ${card.color}`}>
                <card.icon size={14} />
              </div>
            </div>
            <div className="font-mono text-xl font-semibold tracking-[-0.04em] tabular-nums text-foreground sm:text-2xl">{card.value}</div>
            {card.yoy && <YoyChange current={card.yoy.current} previous={card.yoy.previous} />}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
