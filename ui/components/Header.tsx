'use client';

import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import WalletConnect from './WalletConnect';
import TestnetFundButton from './TestnetFundButton';
import type { WalletType } from '@/lib/types';

interface HeaderProps {
  walletAddress: string | null;
  connected: boolean;
  isLoading: boolean;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  walletType: WalletType | null;
  network: string | null;
  onConnect: () => void;
  onConnectAuro: () => void;
  onConnectLedger: (accountIndex?: number) => void;
  onDisconnect: () => void;
  onNetworkChange?: (network: string, ledgerNetworkId: number) => void;
}

export default function Header({
  walletAddress,
  connected,
  isLoading,
  auroInstalled,
  ledgerSupported,
  walletType,
  network,
  onConnect,
  onConnectAuro,
  onConnectLedger,
  onDisconnect,
  onNetworkChange,
}: HeaderProps) {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-safe-border">
      <Link
        href="/"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0"
        title="Back to accounts"
      >
        <div className="w-8 h-8 bg-safe-green rounded-full flex items-center justify-center">
          <span className="text-safe-dark font-bold text-sm">M</span>
        </div>
        <span className="text-sm font-semibold hidden sm:inline">MinaGuard</span>
      </Link>
      <div className="flex items-center gap-3">
        <AuthStatus />
        {network && network !== 'mainnet' && connected && walletAddress && (
          <TestnetFundButton
            address={walletAddress}
            network={network}
            explorerUrl={process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL ?? ''}
          />
        )}
        <WalletConnect
          address={walletAddress}
          connected={connected}
          isLoading={isLoading}
          auroInstalled={auroInstalled}
          ledgerSupported={ledgerSupported}
          walletType={walletType}
          network={network}
          onConnect={onConnect}
          onConnectAuro={onConnectAuro}
          onConnectLedger={onConnectLedger}
          onDisconnect={onDisconnect}
          onNetworkChange={onNetworkChange}
        />
      </div>
    </header>
  );
}

/**
 * Shows the signed-in email + Sign Out button when a NextAuth session is
 * active. Renders nothing when AUTH_DISABLED (local/lightnet) — the whole
 * auth layer is bypassed at the middleware and the api.ts levels, so
 * there's no session to show.
 */
function AuthStatus() {
  const { data: session, status } = useSession();
  if (process.env.NEXT_PUBLIC_AUTH_DISABLED === 'true') return null;
  if (status === 'loading') return null;
  if (!session?.user?.email) return null;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="opacity-70 truncate max-w-[180px]" title={session.user.email}>
        {session.user.email}
      </span>
      <button
        onClick={() => signOut({ callbackUrl: '/auth/signin' })}
        className="opacity-60 hover:opacity-100 hover:text-red-400 transition-colors"
      >
        Sign out
      </button>
    </div>
  );
}
