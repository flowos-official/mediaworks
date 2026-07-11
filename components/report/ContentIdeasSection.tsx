import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  content_ideas: Array<{
    title: string;
    description: string;
    format: string;
  }>;
}

const formatColors: Record<string, string> = {
  Video: 'bg-red-600/10 text-red-700 dark:text-red-300',
  Blog: 'bg-blue-600/10 text-blue-700 dark:text-blue-300',
  'Social Post': 'bg-pink-600/10 text-pink-700 dark:text-pink-300',
  Reel: 'bg-purple-600/10 text-purple-700 dark:text-purple-300',
  Story: 'bg-orange-600/10 text-orange-700 dark:text-orange-300',
  Infographic: 'bg-teal-600/10 text-teal-700 dark:text-teal-300',
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
            <div key={i} className="flex items-start gap-4 p-4 border border-border rounded-xl hover:border-blue-600/30 hover:bg-blue-600/10 transition-colors">
              <div className="w-8 h-8 bg-amber-600/10 rounded-lg flex items-center justify-center flex-shrink-0 text-amber-700 dark:text-amber-300 font-bold text-sm">
                {i + 1}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className="font-semibold text-foreground">{idea.title}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${formatColors[idea.format] || 'bg-muted text-muted-foreground'}`}>
                    {idea.format}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{idea.description}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
