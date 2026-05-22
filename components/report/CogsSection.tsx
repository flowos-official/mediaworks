import { useTranslations } from 'next-intl';
import { DollarSign, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  cogs_estimate: {
    items: Array<{
      supplier: string;
      estimated_cost: string;
      moq: string;
      link?: string;
    }>;
    summary: string;
    margin_analysis?: string;
  };
}

export default function CogsSection({ cogs_estimate }: Props) {
  const t = useTranslations('report');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <DollarSign size={20} className="text-green-600" />
          {t('cogsAnalysis')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 pr-4 text-muted-foreground font-medium">{t('supplier')}</th>
                <th className="text-left py-2 pr-4 text-muted-foreground font-medium">{t('estimatedCost')}</th>
                <th className="text-left py-2 pr-4 text-muted-foreground font-medium">{t('moq')}</th>
                <th className="text-left py-2 text-muted-foreground font-medium">{t('link')}</th>
              </tr>
            </thead>
            <tbody>
              {cogs_estimate.items.map((item, i) => (
                <tr key={i} className="border-b border-border hover:bg-muted">
                  <td className="py-3 pr-4 font-medium text-foreground">{item.supplier}</td>
                  <td className="py-3 pr-4 text-green-700 dark:text-green-400 font-semibold">{item.estimated_cost}</td>
                  <td className="py-3 pr-4 text-muted-foreground">{item.moq}</td>
                  <td className="py-3">
                    {item.link ? (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-blue-600 hover:text-blue-800"
                      >
                        <ExternalLink size={12} />
                        Link
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-muted-foreground bg-green-600/10 p-3 rounded-lg">{cogs_estimate.summary}</p>
        {cogs_estimate.margin_analysis && (
          <div className="bg-yellow-600/10 p-3 rounded-lg">
            <p className="text-xs font-semibold text-yellow-700 dark:text-yellow-400 mb-1">
              マージン分析 / Margin Analysis
            </p>
            <p className="text-sm text-yellow-900 dark:text-yellow-200">{cogs_estimate.margin_analysis}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
