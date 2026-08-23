// app/[locale]/page.tsx
import { redirect } from 'next/navigation';
import { localePath } from '@/lib/i18n/locale-path';
import { appConfig } from '@/config/app';

export default async function RootRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  // Middleware (proxy.ts) already redirects unauthenticated → /login and viewer → /analytics/products.
  // Anyone reaching this component is admin or member.
  redirect(localePath(locale, appConfig.navigation.memberLanding));
}
