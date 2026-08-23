import { getRequestConfig } from 'next-intl/server';
import { appConfig } from './config/app';
import { isAppLocale } from './lib/i18n/locale-path';

export default getRequestConfig(async ({ requestLocale }) => {
  const requestedLocale = await requestLocale;
  const locale = isAppLocale(requestedLocale)
    ? requestedLocale
    : appConfig.i18n.defaultLocale;
  return {
    locale,
    messages: (await import(`./messages/${locale}.json`)).default
  };
});
