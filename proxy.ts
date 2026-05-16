import createIntlMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';
import { isViewerAllowedPath, ROLE_LANDING } from '@/lib/auth/route-permissions';

const intl = createIntlMiddleware({
  locales: ['en', 'ja'],
  defaultLocale: 'ja',
  localePrefix: 'always',
});

const PUBLIC_SUFFIXES = [/\/login$/, /\/reset-password$/];

export default async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Defensive: api + Next internals already excluded via matcher, but skip cheaply.
  if (pathname.startsWith('/api') || pathname.startsWith('/_next')) {
    return NextResponse.next();
  }

  const { response, user, role } = await updateSession(req);
  const isPublic = PUBLIC_SUFFIXES.some((re) => re.test(pathname));

  if (isPublic) {
    const intlRes = intl(req);
    for (const c of response.cookies.getAll()) {
      const { name, value, ...options } = c;
      intlRes.cookies.set(name, value, options);
    }
    return intlRes;
  }

  if (!user) {
    return NextResponse.redirect(new URL('/ja/login', req.url));
  }

  if (role === 'viewer' && !isViewerAllowedPath(pathname)) {
    return NextResponse.redirect(new URL(`/ja${ROLE_LANDING.viewer}`, req.url));
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
