import { appConfig, type AppLocale } from '@/config/app';

export function isAppLocale(locale: string | undefined): locale is AppLocale {
  return Boolean(locale && (appConfig.i18n.locales as readonly string[]).includes(locale));
}

export function stripLocalePrefix(pathname: string): string {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const [firstSegment] = normalized.slice(1).split('/');
  if (!isAppLocale(firstSegment)) return normalized || '/';
  return normalized.slice(firstSegment.length + 1) || '/';
}

export function pathLocale(pathname: string): AppLocale {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const [firstSegment] = normalized.slice(1).split('/');
  return isAppLocale(firstSegment) ? firstSegment : appConfig.i18n.defaultLocale;
}

export function localePath(locale: string, path: string = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (locale === appConfig.i18n.defaultLocale) return p;
  if (p === '/') return `/${locale}`;
  return `/${locale}${p}`;
}
