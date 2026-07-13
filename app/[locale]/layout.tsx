import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Navbar from '@/components/Navbar';
import { AppDataCacheProvider } from '@/components/providers/AppDataCacheProvider';

const locales = ['ja', 'ko'];

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!locales.includes(locale)) notFound();

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={messages}>
      <AppDataCacheProvider>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.dataset.sidebarCollapsed=localStorage.getItem('mediaworks-sidebar-collapsed')==='true'?'true':'false'}catch{}`,
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
