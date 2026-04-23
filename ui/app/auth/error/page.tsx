'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function ErrorInner() {
  const searchParams = useSearchParams();
  const error = searchParams?.get('error') ?? 'Unknown';
  const allowedDomain =
    process.env.NEXT_PUBLIC_AUTH_ALLOWED_DOMAINS ?? 'o1labs.org';

  const message =
    error === 'AccessDenied'
      ? `Your email is not on the access list. MinaGuard is restricted to ${allowedDomain} accounts.`
      : `Sign-in failed: ${error}`;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-safe-gray border border-red-500/30 rounded-xl p-8 space-y-4">
        <h1 className="text-xl font-bold text-red-400">Access denied</h1>
        <p className="text-sm opacity-80">{message}</p>
        <Link
          href="/auth/signin"
          className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm hover:brightness-110"
        >
          Try another account
        </Link>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm opacity-70">Loading…</div>}>
      <ErrorInner />
    </Suspense>
  );
}
