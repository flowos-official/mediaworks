import { useTranslations } from 'next-intl';
import { Star, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface Props {
  influencers: Array<{
    name: string;
    platform: string;
    followers: string;
    match_reason: string;
    profile_url?: string;
  }>;
}

const platformColors: Record<string, string> = {
  YouTube: 'bg-red-100 text-red-700',
  Instagram: 'bg-pink-100 text-pink-700',
  TikTok: 'bg-gray-100 text-gray-700',
  Twitter: 'bg-sky-100 text-sky-700',
  X: 'bg-gray-100 text-gray-700',
};

export default function InfluencersSection({ influencers }: Props) {
  const t = useTranslations('report');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Star size={20} className="text-yellow-600" />
          {t('influencers')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {influencers.map((inf, i) => (
            <div key={i} className="flex items-start gap-4 p-4 bg-gray-50 rounded-xl">
              <div className="w-10 h-10 bg-gradient-to-br from-yellow-400 to-orange-500 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold text-sm">
                {inf.name.charAt(0).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-900">{inf.name}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${platformColors[inf.platform] || 'bg-gray-100 text-gray-700'}`}>
                    {inf.platform}
                  </span>
                  <span className="text-xs text-gray-500">{inf.followers} followers</span>
                  {inf.profile_url && (
                    <a
                      href={inf.profile_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-1">{inf.match_reason}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
