import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Navbar from '@/components/Navbar';
import { AppDataCacheProvider } from '@/components/providers/AppDataCacheProvider';
import { appConfig } from '@/config/app';

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!(appConfig.i18n.locales as readonly string[]).includes(locale)) notFound();

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages}>
      <AppDataCacheProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.dataset.sidebarCollapsed=localStorage.getItem(${JSON.stringify(appConfig.storage.sidebarCollapsedKey)})==='true'?'true':'false'}catch{}`,
          }}
        />
        <div className="min-h-screen">
          <Navbar />
          <div className="mw-content-frame">{children}</div>
        </div>
      </AppDataCacheProvider>
    </NextIntlClientProvider>
  );
}
