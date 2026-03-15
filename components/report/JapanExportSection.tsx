'use client';

import { Globe, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  japan_export_fit_score: number;
  recommended_price_range: string;
}

function getScoreColor(score: number) {
  if (score >= 80) return { bar: 'bg-green-500', text: 'text-green-700', bg: 'bg-green-50', label: '非常に適合' };
  if (score >= 60) return { bar: 'bg-blue-500', text: 'text-blue-700', bg: 'bg-blue-50', label: '適合' };
  if (score >= 40) return { bar: 'bg-yellow-500', text: 'text-yellow-700', bg: 'bg-yellow-50', label: '条件付き適合' };
  return { bar: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', label: '要検討' };
}

export default function JapanExportSection({ japan_export_fit_score, recommended_price_range }: Props) {
  if (japan_export_fit_score == null) return null;

  const score = getScoreColor(japan_export_fit_score);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Globe size={20} className="text-red-600" />
          日本輸出適合性
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Score gauge */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-600">輸出適合スコア</span>
            <span className={`text-2xl font-bold ${score.text}`}>
              {japan_export_fit_score}
              <span className="text-sm font-normal text-gray-400">/100</span>
            </span>
          </div>
          <div className="w-full h-3 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${score.bar}`}
              style={{ width: `${japan_export_fit_score}%` }}
            />
          </div>
          <div className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium ${score.bg} ${score.text}`}>
            <TrendingUp size={12} />
            {score.label}
          </div>
        </div>

        {/* Recommended price */}
        {recommended_price_range && (
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-sm text-gray-500 mb-1">推奨販売価格帯（日本市場）</p>
            <p className="text-xl font-bold text-gray-900">{recommended_price_range}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
