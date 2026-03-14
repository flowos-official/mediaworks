import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
  content_ideas: Array<{
    title: string;
    description: string;
    format: string;
  }>;
}

const formatColors: Record<string, string> = {
  Video: 'bg-red-100 text-red-700',
  Blog: 'bg-blue-100 text-blue-700',
  'Social Post': 'bg-pink-100 text-pink-700',
  Reel: 'bg-purple-100 text-purple-700',
  Story: 'bg-orange-100 text-orange-700',
  Infographic: 'bg-teal-100 text-teal-700',
};

export default function ContentIdeasSection({ content_ideas }: Props) {
  const t = useTranslations('report');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Lightbulb size={20} className="text-amber-600" />
          {t('contentIdeas')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {content_ideas.map((idea, i) => (
            <div key={i} className="flex items-start gap-4 p-4 border border-gray-200 rounded-xl hover:border-blue-200 hover:bg-blue-50/30 transition-colors">
              <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0 text-amber-700 font-bold text-sm">
                {i + 1}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-semibold text-gray-900">{idea.title}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${formatColors[idea.format] || 'bg-gray-100 text-gray-700'}`}>
                    {idea.format}
                  </span>
                </div>
                <p className="text-sm text-gray-600">{idea.description}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
