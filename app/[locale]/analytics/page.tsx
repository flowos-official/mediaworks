import { redirect } from 'next/navigation';

export default async function AnalyticsIndexPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/analytics/overview`);
}
