import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { isViewerAllowedPath, ROLE_LANDING } from '@/lib/auth/route-permissions';

const intl = createIntlMiddleware({
  locales: ['ja', 'ko'],
  defaultLocale: 'ko',
  localePrefix: 'as-needed',
  // URL is the source of truth — disables Accept-Language hijack that was
  // bouncing between locale-prefixed routes and breaking <LanguageSwitcher>.
  localeDetection: false,
});

function localePath(locale: string, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return locale === 'ko' ? p : `/${locale}${p}`;
}

const PUBLIC_SUFFIXES = [/\/login$/, /\/reset-password$/];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Defensive: api + Next internals already excluded via matcher, but skip cheaply.
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  // Exposed to server components/layouts (no native pathname API in App Router).
  req.headers.set('x-pathname', pathname);

  const { response, user, role, mustChangePassword } = await updateSession(req);
  const isPublic = PUBLIC_SUFFIXES.some((re) => re.test(pathname));

  if (isPublic) {
    const intlRes = intl(req);
    for (const c of response.cookies.getAll()) {
      const { name, value, ...options } = c;
      intlRes.cookies.set(name, value, options);
    }
    return intlRes;
  }

  const pathLocale = pathname.startsWith('/ja/') || pathname === '/ja' ? 'ja' : 'ko';

  if (!user) {
    return NextResponse.redirect(new URL(localePath(pathLocale, '/login'), req.url));
  }

  // Forced password change blocks all non-public routes until the user resets
  // their admin-issued temporary password.
  if (mustChangePassword) {
    return NextResponse.redirect(new URL(localePath(pathLocale, '/reset-password?force=1'), req.url));
  }

  if (role === 'viewer' && !isViewerAllowedPath(pathname)) {
    return NextResponse.redirect(new URL(localePath(pathLocale, ROLE_LANDING.viewer), req.url));
  }

  const intlRes = intl(req);
  for (const c of response.cookies.getAll()) {
    const { name, value, ...options } = c;
    intlRes.cookies.set(name, value, options);
  }
  return intlRes;
}

export const config = {
  matcher: ['/((?!api|_next|_vercel|\\.well-known/workflow|.*\\..*).*)'],
};
