import { useTranslations } from 'next-intl';
import { Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  seasonality: Record<string, number>;
}

const MONTH_KEYS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export default function SeasonalitySection({ seasonality }: Props) {
  const t = useTranslations('report');
  const max = Math.max(...Object.values(seasonality));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Calendar size={20} className="text-orange-600" />
          {t('seasonality')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-12 gap-2">
          {MONTH_KEYS.map((month) => {
            const val = seasonality[month] ?? 0;
            const height = max > 0 ? (val / max) * 100 : 0;
            const isHigh = val >= 70;
            const isMed = val >= 40 && val < 70;

            return (
              <div key={month} className="flex flex-col items-center gap-1">
                <div className="h-20 w-full flex items-end">
                  <div
                    className={`w-full rounded-t-sm transition-all ${
                      isHigh ? 'bg-orange-500' : isMed ? 'bg-orange-300' : 'bg-orange-100'
                    }`}
                    style={{ height: `${Math.max(height, 8)}%` }}
                  />
                </div>
                <span className="text-xs text-gray-500">{t(month as 'jan')}</span>
                <span className="text-xs font-medium text-gray-700">{val}</span>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 mt-4 text-xs text-gray-500">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-orange-500 inline-block" /> High (70+)</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-orange-300 inline-block" /> Medium (40-69)</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-orange-100 inline-block" /> Low (&lt;40)</span>
        </div>
      </CardContent>
    </Card>
  );
}
