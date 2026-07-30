const DEFAULT_LOCALE = 'ko';

export function localePath(locale: string, path: string = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  if (locale === DEFAULT_LOCALE) return p;
  if (p === '/') return `/${locale}`;
  return `/${locale}${p}`;
}
