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
        <Calendar size={14} className="text-gray-400" />
        <span className="text-xs font-medium text-gray-500">期間:</span>
        <div className="flex gap-1">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => toggleYear(y)}
              className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
                selectedYears.includes(y)
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-1 p-0.5 bg-gray-100 rounded-lg">
        {(['weekly', 'monthly'] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPeriodChange(p)}
            className={`text-xs px-3 py-1 rounded-md transition-colors ${
              period === p ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            {p === 'weekly' ? '週次' : '月次'}
          </button>
        ))}
      </div>
    </div>
  );
}
