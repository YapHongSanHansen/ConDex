"use client";

import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/near/connector";

/**
 * One place for "you need a wallet and a ConDex session first". It shows only the step that is missing:
 * connect the wallet, then sign ConDex's message (free, no transaction). Renders nothing once signed in.
 */
export function SignInGate({ why, children }: { why: string; children?: React.ReactNode }) {
  const { accountId, signedIn, signingIn, signIn, connect, connecting, ready } = useWallet();
  if (signedIn && accountId) return <>{children}</>;
  return (
    <div className="space-y-3 rounded-md border border-dashed border-border p-5">
      <p className="flex items-center gap-2 font-medium"><Wallet className="h-4 w-4 text-accent" aria-hidden />{accountId ? "Sign in to continue" : "Connect your wallet to continue"}</p>
      <p className="text-sm text-muted">
        {accountId ? `Sign ConDex's message with ${accountId} ${why}. It costs nothing and sends no transaction.` : `Connect a NEAR testnet wallet ${why}.`}
      </p>
      {accountId ? (
        <Button variant="primary" loading={signingIn} onClick={() => signIn()}>Sign in</Button>
      ) : (
        <Button variant="primary" loading={connecting} disabled={!ready} onClick={() => connect()}>Connect wallet</Button>
      )}
    </div>
  );
}
