import Link from 'next/link';
import { BookOpen, Globe2, Palette } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import ThemePreferenceControl from '@/components/theme/ThemePreferenceControl';
import { localePath } from '@/lib/i18n/locale-path';

export default async function PreferencesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations('admin.preferences');

  return (
    <div className="max-w-3xl space-y-4">
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
            <Globe2 size={18} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('languageTitle')}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('languageDescription')}</p>
          </div>
        </div>
        <LanguageSwitcher />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-4 flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
            <Palette size={18} />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{t('themeTitle')}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('themeDescription')}</p>
          </div>
        </div>
        <ThemePreferenceControl />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
              <BookOpen size={18} />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{t('guideTitle')}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('guideDescription')}</p>
            </div>
          </div>
          <Link
            href={localePath(locale, '/guide')}
            className="inline-flex w-fit items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-blue-300 hover:text-blue-600"
          >
            {t('guideButton')}
          </Link>
        </div>
      </section>
    </div>
  );
}
