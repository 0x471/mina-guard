'use client';

import { signIn } from 'next-auth/react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function SignInInner() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams?.get('callbackUrl') ?? '/';
  const allowedDomain =
    process.env.NEXT_PUBLIC_AUTH_ALLOWED_DOMAINS ?? 'o1labs.org';

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm w-full bg-safe-gray border border-safe-border rounded-xl p-8 space-y-4">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold">MinaGuard</h1>
          <p className="text-sm opacity-70">
            Sign in with your {allowedDomain} Google account to access the
            custody dashboard.
          </p>
        </div>
        <button
          onClick={() => signIn('google', { callbackUrl })}
          className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all"
        >
          Sign in with Google
        </button>
        <p className="text-xs text-safe-text opacity-60 text-center">
          Only {allowedDomain} emails are accepted.
        </p>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm opacity-70">Loading…</div>}>
      <SignInInner />
    </Suspense>
  );
}
