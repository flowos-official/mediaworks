'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { BarChart3 } from 'lucide-react';
import Navbar from '@/components/Navbar';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';

// ---------------------------------------------------------------------------
// Filter context — shared by overview/products pages, ignored by expansion/live-commerce
// ---------------------------------------------------------------------------

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
  if (!ctx) throw new Error('useAnalyticsFilter must be used inside analytics layout');
  return ctx;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type TabKey = 'overview' | 'products' | 'expansion' | 'live-commerce' | 'discovery';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview', label: '概要' },
  { key: 'products', label: '商品分析' },
  { key: 'expansion', label: '拡大戦略' },
  { key: 'live-commerce', label: 'ライブコマース' },
  { key: 'discovery', label: '新商品発掘' },
];

export default function AnalyticsLayout({ children }: { children: ReactNode }) {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();

  const [selectedYears, setSelectedYears] = useState<number[]>([2025, 2026]);
  const [period, setPeriod] = useState<Period>('weekly');

  // Derive active tab from pathname: /<locale>/analytics/<tab>[/...]
  const activeTab: TabKey | null = (() => {
    const parts = pathname.split('/').filter(Boolean); // [locale, 'analytics', tab?, ...]
    const tab = parts[2];
    if (!tab) return null;
    if (TABS.some((t) => t.key === tab)) return tab as TabKey;
    return null;
  })();

  const showFilter = activeTab === 'overview' || activeTab === 'products';

  return (
    <AnalyticsFilterContext.Provider
      value={{ selectedYears, setSelectedYears, period, setPeriod }}
    >
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-1">
              <BarChart3 size={20} className="text-blue-600" />
              <h1 className="text-2xl font-bold text-gray-900">売上分析</h1>
            </div>
            <p className="text-sm text-gray-500">
              TXDレギュラー受注データに基づく販売実績分析
            </p>
          </div>

          <div className="space-y-6">
            {/* Tab bar + filters */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm">
                {TABS.map((tab) => {
                  const href = `/${locale}/analytics/${tab.key}`;
                  const isActive = activeTab === tab.key;
                  return (
                    <Link
                      key={tab.key}
                      href={href}
                      prefetch
                      className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                        isActive
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-gray-500 hover:text-gray-800'
                      }`}
                    >
                      {tab.label}
                    </Link>
                  );
                })}
              </div>

              {showFilter && (
                <DateRangeFilter
                  years={[2025, 2026]}
                  selectedYears={selectedYears}
                  period={period}
                  onYearsChange={setSelectedYears}
                  onPeriodChange={setPeriod}
                />
              )}
            </div>

            {children}
          </div>
        </main>
      </div>
    </AnalyticsFilterContext.Provider>
  );
}
