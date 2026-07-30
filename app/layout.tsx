import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
import { getLocale } from 'next-intl/server';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#DA291C',
};

export const metadata: Metadata = {
  title: 'LOTTE HOME SHOPPING · SONAR',
  description: '상품 발굴부터 리서치, 방송 편성, 대본, 심의까지 연결하는 롯데홈쇼핑 AX 운영 플랫폼',
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen">
        {/* FlowOS in-app instrumentation: auto pageview/click/error + window.flowos.track().
            First-party drop-in served from flowos-admin; collection is opt-in and gated
            server-side by the dashboard watch toggle (no key needed — Origin-matched).
            See flowos-admin/docs/instrumentation.md. */}
        <Script
          src="https://flowos-admin.vercel.app/flowos.js"
          strategy="afterInteractive"
        />
        <ThemeProvider forcedTheme="light" enableSystem={false}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
