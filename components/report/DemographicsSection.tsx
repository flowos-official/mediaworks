import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
  demographics: {
    age_group: string;
    gender: string;
    interests: string[];
    income_level: string;
  };
}

export default function DemographicsSection({ demographics }: Props) {
  const t = useTranslations('report');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Users size={20} className="text-purple-600" />
          {t('demographics')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{t('ageGroup')}</p>
            <p className="text-gray-900 font-semibold">{demographics.age_group}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{t('gender')}</p>
            <p className="text-gray-900 font-semibold">{demographics.gender}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">{t('income')}</p>
            <p className="text-gray-900 font-semibold">{demographics.income_level}</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-2">{t('interests')}</p>
            <div className="flex flex-wrap gap-1">
              {demographics.interests.map((interest, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {interest}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
