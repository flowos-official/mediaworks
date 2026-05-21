'use client';

import { Calendar } from 'lucide-react';

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
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex items-center gap-1.5">
        <Calendar size={14} className="text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">期間:</span>
        <div className="flex gap-1">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => toggleYear(y)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedYears.includes(y)
                  ? 'bg-blue-600 text-white'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 p-0.5 bg-muted rounded-lg">
        {(['weekly', 'monthly'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPeriodChange(p)}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${
              period === p ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            {p === 'weekly' ? '週次' : '月次'}
          </button>
        ))}
      </div>
    </div>
  );
}
