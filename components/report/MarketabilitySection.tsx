import { useTranslations, useLocale } from 'next-intl';
import { TrendingUp, AlertTriangle, Clock, BarChart2, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

interface Competitor {
  name: string;
  price_range: string;
}

interface Props {
  score: number;
  description: string;
  market_size?: string;
  competitors?: Competitor[];
  usp_points?: string[];
  risk_analysis?: string;
  recommended_sales_timing?: string;
  expected_roi?: string;
}

export default function MarketabilitySection({
  score,
  description,
  market_size,
  competitors,
  usp_points,
  risk_analysis,
  recommended_sales_timing,
  expected_roi,
}: Props) {
  const t = useTranslations('report');
  const locale = useLocale();
  const isJa = locale === 'ja';

  const scoreColor =
    score >= 75 ? 'text-green-600' : score >= 50 ? 'text-yellow-600' : 'text-red-600';
  const barColor =
    score >= 75 ? 'bg-green-500' : score >= 50 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="space-y-4">
      {/* Main Score Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <TrendingUp size={20} className="text-blue-600" />
            {t('marketability')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4">
            <div className={`text-5xl font-bold ${scoreColor}`}>{score}</div>
            <div className="flex-1">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>{t('score')}</span>
                <span>{score}/100</span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${barColor}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
          </div>
          <p className="text-gray-600 leading-relaxed">{description}</p>

          {/* Market Size */}
          {market_size && (
            <div className="bg-blue-50 p-4 rounded-xl">
              <p className="text-xs font-semibold text-blue-700 mb-1 flex items-center gap-1">
                <BarChart2 size={14} />
                {isJa ? '市場規模' : 'Market Size'}
              </p>
              <p className="text-sm text-blue-900">{market_size}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Competitors */}
      {competitors && competitors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 size={18} className="text-purple-600" />
              {isJa ? '競合ブランド分析' : 'Competitor Analysis'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {competitors.map((c, i) => (
                <div key={i} className="bg-purple-50 rounded-lg p-3">
                  <p className="font-semibold text-purple-900 text-sm">{c.name}</p>
                  <p className="text-xs text-purple-600 mt-1">
                    {isJa ? '価格帯: ' : 'Price: '}{c.price_range}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* USP Points */}
      {usp_points && usp_points.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp size={18} className="text-green-600" />
              {isJa ? 'ホームショッピング成功のUSP' : 'Home Shopping USP Points'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {usp_points.map((pt, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                  <span className="mt-0.5 flex-shrink-0 w-5 h-5 bg-green-100 text-green-700 rounded-full text-xs flex items-center justify-center font-bold">
                    {i + 1}
                  </span>
                  {pt}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Risk Analysis */}
      {risk_analysis && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldAlert size={18} className="text-red-500" />
              {isJa ? 'リスク分析' : 'Risk Analysis'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-gray-700 leading-relaxed bg-red-50 p-4 rounded-xl">
              {risk_analysis}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Timing & ROI */}
      {(recommended_sales_timing || expected_roi) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {recommended_sales_timing && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock size={18} className="text-orange-500" />
                  {isJa ? '推奨販売時期' : 'Recommended Sales Timing'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 leading-relaxed">{recommended_sales_timing}</p>
              </CardContent>
            </Card>
          )}
          {expected_roi && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <AlertTriangle size={18} className="text-yellow-500" />
                  {isJa ? '予想ROI・収益性' : 'Expected ROI'}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-gray-700 leading-relaxed">{expected_roi}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
