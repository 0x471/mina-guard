'use client';

import dynamic from 'next/dynamic';

/**
 * `_view.tsx` imports o1js + contracts at module scope (SingleKeyDelegate
 * card, Poseidon hash checks, subaccount wizard). Next.js SSR can't resolve
 * the o1js plonk_wasm chunk server-side. Wrapping via next/dynamic with
 * ssr:false skips SSR for this route.
 */
const AccountView = dynamic(() => import('./_view'), { ssr: false });

export default function AccountPage() {
  return <AccountView />;
}
