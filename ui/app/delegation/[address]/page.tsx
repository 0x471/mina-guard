'use client';

import dynamic from 'next/dynamic';

/**
 * `_view.tsx` imports o1js + contracts at module scope for the Poseidon
 * delegation-key check. Next.js App Router's SSR phase tries to emit the
 * o1js plonk_wasm chunk on the server and fails (pkg.pr.new o1js@2701 WASM
 * chunk isn't server-loadable). Wrapping via next/dynamic with ssr:false
 * skips SSR entirely for this route — client-side rendering handles it,
 * and curls to the route return a clean 200 instead of a stack trace.
 */
const DelegationView = dynamic(() => import('./_view'), { ssr: false });

export default function DelegationPage() {
  return <DelegationView />;
}
