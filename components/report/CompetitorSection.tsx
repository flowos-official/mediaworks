'use client';

import { Swords } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  competitor_analysis: Array<{
    name: string;
    price: string;
    platform: string;
    key_difference: string;
  }>;
}

export default function CompetitorSection({ competitor_analysis }: Props) {
  if (!competitor_analysis?.length) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Swords size={20} className="text-orange-600" />
          競合分析
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 pr-4 text-gray-500 font-medium">商品名</th>
                <th className="text-left py-2 pr-4 text-gray-500 font-medium">価格</th>
                <th className="text-left py-2 pr-4 text-gray-500 font-medium">プラットフォーム</th>
                <th className="text-left py-2 text-gray-500 font-medium">差別化ポイント</th>
              </tr>
            </thead>
            <tbody>
              {competitor_analysis.map((item, i) => (
                <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3 pr-4 font-medium text-gray-900">{item.name}</td>
                  <td className="py-3 pr-4 text-orange-700 font-semibold">{item.price}</td>
                  <td className="py-3 pr-4 text-gray-600">{item.platform}</td>
                  <td className="py-3 text-gray-600">{item.key_difference}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
