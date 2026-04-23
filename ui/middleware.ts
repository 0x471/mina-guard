import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

/**
 * Gates app routes behind a NextAuth session. `AUTH_DISABLED=true` (or
 * `NEXT_PUBLIC_AUTH_DISABLED=true`) short-circuits everything for local
 * dev / lightnet / e2e. Public paths — sign-in, error, auth API, static
 * assets — are always allowed.
 *
 * Matched routes are in the `config.matcher` at the bottom.
 */
export async function middleware(req: NextRequest) {
  if (
    process.env.AUTH_DISABLED === 'true' ||
    process.env.NEXT_PUBLIC_AUTH_DISABLED === 'true'
  ) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  const isPublic =
    pathname === '/' ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/public');
  if (isPublic) return NextResponse.next();

  const token = await getToken({
    req,
    secret: process.env.NEXTAUTH_SECRET,
  });
  if (!token) {
    const signInUrl = new URL('/auth/signin', req.url);
    signInUrl.searchParams.set('callbackUrl', req.url);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Protect the custody app surface; leave `/` (marketing) + auth + api/auth
  // + next assets alone.
  matcher: [
    '/accounts/:path*',
    '/activity/:path*',
    '/delegation/:path*',
    '/transactions/:path*',
    '/settings/:path*',
  ],
};
