import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import { appConfig } from '@/config/app';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: appConfig.brand.themeColor,
};

export const metadata: Metadata = {
  title: appConfig.brand.metadataTitle,
  description: appConfig.brand.metadataDescription,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang={appConfig.i18n.defaultLocale}
      data-app-variant={appConfig.id}
      data-market={appConfig.market.countryCode}
      suppressHydrationWarning
    >
      <body className={`${inter.className} min-h-screen`}>
        {/* FlowOS in-app instrumentation: auto pageview/click/error + window.flowos.track().
            First-party drop-in served from flowos-admin; collection is opt-in and gated
            server-side by the dashboard watch toggle (no key needed — Origin-matched).
            See flowos-admin/docs/instrumentation.md. */}
        <Script
          src="https://flowos-admin.vercel.app/flowos.js"
          strategy="afterInteractive"
        />
        <ThemeProvider
          forcedTheme={appConfig.theme.forcedTheme}
          enableSystem={appConfig.theme.enableSystem}
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
