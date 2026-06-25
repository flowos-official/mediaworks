import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import Script from 'next/script';
import { ThemeProvider } from '@/components/theme/ThemeProvider';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'MediaWorks — Home Shopping Research Platform',
  description: 'Automated home shopping marketing research powered by AI',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body className={`${inter.className} min-h-screen`}>
        {/* FlowOS in-app instrumentation: auto pageview/click/error + window.flowos.track().
            First-party drop-in served from flowos-admin; collection is opt-in and gated
            server-side by the dashboard watch toggle (no key needed — Origin-matched).
            See flowos-admin/docs/instrumentation.md. */}
        <Script
          src="https://flowos-admin.vercel.app/flowos.js"
          strategy="afterInteractive"
        />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
