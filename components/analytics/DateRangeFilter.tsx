'use client';

import { Calendar } from 'lucide-react';
import { useLocale } from 'next-intl';

type Props = {
  years: number[];
  selectedYears: number[];
  period: 'weekly' | 'monthly';
  onYearsChange: (years: number[]) => void;
  onPeriodChange: (period: 'weekly' | 'monthly') => void;
};

export default function DateRangeFilter({
  years,
  selectedYears,
  period,
  onYearsChange,
  onPeriodChange,
}: Props) {
  const isKo = useLocale() === 'ko';

  const toggleYear = (year: number) => {
    if (selectedYears.includes(year)) {
      if (selectedYears.length > 1) {
        onYearsChange(selectedYears.filter((y) => y !== year));
      }
    } else {
      onYearsChange([...selectedYears, year].sort());
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1.5">
        <Calendar size={14} className="text-muted-foreground" />
        <span className="font-mono text-[9px] font-semibold tracking-[0.08em] text-muted-foreground">
          {isKo ? '기간' : '期間'}
        </span>
        <div className="flex gap-1">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => toggleYear(y)}
              className={`min-h-8 rounded-lg border px-2.5 font-mono text-[10px] font-semibold transition-colors ${
                selectedYears.includes(y)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 rounded-lg bg-muted p-0.5">
        {(['weekly', 'monthly'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPeriodChange(p)}
            className={`min-h-8 rounded-md px-3 text-xs font-medium transition-colors ${
              period === p ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            {p === 'weekly' ? (isKo ? '주간' : '週次') : (isKo ? '월간' : '月次')}
          </button>
        ))}
      </div>
    </div>
  );
}
