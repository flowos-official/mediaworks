import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Navbar from '@/components/Navbar';

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
      <script
        dangerouslySetInnerHTML={{
          __html: `try{document.documentElement.dataset.sidebarCollapsed=localStorage.getItem('mediaworks-sidebar-collapsed')==='true'?'true':'false'}catch{}`,
        }}
      />
      <div className="min-h-screen">
        <Navbar />
        <div className="mw-content-frame">{children}</div>
      </div>
    </NextIntlClientProvider>
  );
}
