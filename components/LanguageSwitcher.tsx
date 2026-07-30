'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter, usePathname } from 'next/navigation';
import { Globe } from 'lucide-react';

export default function LanguageSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('language');

  const switchLocale = (newLocale: string) => {
    // Strip any locale prefix, then add one only for the non-default Japanese route.
    const stripped = pathname.replace(/^\/(ja|ko)(?=\/|$)/, '') || '/';
    const target = newLocale === 'ko' ? stripped : `/${newLocale}${stripped === '/' ? '' : stripped}`;
    router.push(target);
  };

  return (
    <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
      <Globe size={14} className="text-muted-foreground ml-1" />
      {['ja', 'ko'].map((loc) => (
        <button
          type="button"
          key={loc}
          onClick={() => switchLocale(loc)}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-all ${
            locale === loc
              ? 'bg-card text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t(loc)}
        </button>
      ))}
    </div>
  );
}
