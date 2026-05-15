import type { Metadata, Viewport } from 'next';
import { Inter, Noto_Sans_JP, JetBrains_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Navbar from '@/components/Navbar';
import '../globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });
const notoSansJp = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700', '900'],
  variable: '--font-jp',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'MediaWorks — Home Shopping Research Platform',
  description: 'Automated home shopping marketing research powered by AI',
};

const locales = ['en', 'ja'];

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
    <html lang={locale}>
      <body className={`${inter.variable} ${notoSansJp.variable} ${jetbrainsMono.variable} font-sans bg-gray-50 min-h-screen`}>
        <NextIntlClientProvider messages={messages}>
          <Navbar />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
