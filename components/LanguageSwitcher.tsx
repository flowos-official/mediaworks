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
    // Strip current locale prefix (only present for non-default 'ko'); then re-prefix if target is non-default.
    const stripped = pathname.replace(/^\/(ja|ko)(?=\/|$)/, '') || '/';
    const target = newLocale === 'ja' ? stripped : `/${newLocale}${stripped === '/' ? '' : stripped}`;
    router.push(target);
  };

  return (
    <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
      <Globe size={14} className="text-gray-500 ml-1" />
      {['ja', 'ko'].map((loc) => (
        <button
          key={loc}
          onClick={() => switchLocale(loc)}
          className={`px-3 py-1 rounded-md text-sm font-medium transition-all ${
            locale === loc
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t(loc)}
        </button>
      ))}
    </div>
  );
}
