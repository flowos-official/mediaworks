// app/[locale]/analytics/(firm)/layout.tsx
'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import FirmSubNav from '@/components/nav/FirmSubNav';

type Period = 'weekly' | 'monthly';

interface AnalyticsFilterContextValue {
  selectedYears: number[];
  setSelectedYears: (y: number[]) => void;
  period: Period;
  setPeriod: (p: Period) => void;
}

const AnalyticsFilterContext = createContext<AnalyticsFilterContextValue | null>(null);

export function useAnalyticsFilter(): AnalyticsFilterContextValue {
  const ctx = useContext(AnalyticsFilterContext);
  if (!ctx) throw new Error('useAnalyticsFilter must be used inside (firm) layout');
  return ctx;
}

export default function FirmLayout({ children }: { children: ReactNode }) {
  const [selectedYears, setSelectedYears] = useState<number[]>([2025, 2026]);
  const [period, setPeriod] = useState<Period>('weekly');

  return (
    <AnalyticsFilterContext.Provider
      value={{ selectedYears, setSelectedYears, period, setPeriod }}
    >
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={20} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">自社データ</h1>
          </div>
          <p className="text-sm text-gray-500">売上・商品・ギャラリー</p>
        </div>

        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <FirmSubNav />
            <DateRangeFilter
              years={[2025, 2026]}
              selectedYears={selectedYears}
              period={period}
              onYearsChange={setSelectedYears}
              onPeriodChange={setPeriod}
            />
          </div>
          {children}
        </div>
      </main>
    </AnalyticsFilterContext.Provider>
  );
}
