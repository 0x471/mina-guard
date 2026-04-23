import type { NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { createHmac } from 'node:crypto';

/**
 * NextAuth configuration. Uses JWT session strategy (no DB adapter —
 * M0 stateless dashboard). Google is the sole identity provider;
 * non-allowlisted domains are rejected in the `signIn` callback.
 *
 * The `session` callback mints a short-lived HS256 JWT that the UI's
 * api.ts attaches as `Authorization: Bearer …` on every backend request.
 * Backend's middleware verifies the same HS256 signature (shared
 * `AUTH_JWT_SECRET`) and re-checks the email domain. Defense-in-depth:
 * rejecting the domain on sign-in is the primary gate; backend re-check
 * catches a compromised UI.
 *
 * Local dev bypasses both layers via `AUTH_DISABLED=true` on the
 * backend and `NEXT_PUBLIC_AUTH_DISABLED=true` on the UI.
 */

const AUTH_TOKEN_TTL_SECONDS = 60 * 60; // 1h — short lifetime; UI refreshes via the session endpoint.

function allowedDomains(): string[] {
  return (process.env.AUTH_ALLOWED_DOMAINS ?? 'o1labs.org')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

function emailDomainAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return allowedDomains().includes(domain);
}

function signBackendJwt(email: string): string {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error('AUTH_JWT_SECRET not configured');
  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      email,
      iat: nowSec,
      exp: nowSec + AUTH_TOKEN_TTL_SECONDS,
    }),
  ).toString('base64url');
  const sig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    }),
  ],
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    signIn({ user }) {
      return emailDomainAllowed(user.email);
    },
    jwt({ token, user }) {
      // First sign-in — `user` is present; propagate email into the token.
      if (user?.email) token.email = user.email;
      return token;
    },
    session({ session, token }) {
      const email = typeof token.email === 'string' ? token.email : null;
      if (email) {
        session.user = { ...session.user, email };
        // Attach the backend bearer token so the client can inject it on
        // api calls. Regenerated on every session fetch → tokens stay fresh.
        (session as unknown as { backendToken?: string }).backendToken =
          signBackendJwt(email);
      }
      return session;
    },
  },
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
};
