"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { toast } from "sonner";
import { setAuthAccount } from "@/lib/api/client";
import { NEAR_NETWORK } from "@/lib/config";

interface WalletState {
  accountId: string | null;
  ready: boolean;
  connecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  /** Returns the connected wallet or throws if none. */
  getWallet: () => Promise<NearWalletBase>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const connectorRef = useRef<NearConnector | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Loaded client-side only: the library touches window/IndexedDB.
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (cancelled) return;
      const connector = new NearConnector({ network: NEAR_NETWORK });
      connectorRef.current = connector;

      connector.on("wallet:signIn", (e) => {
        // VERIFIED in the library README: account id lives at accounts[0].accountId
        const id = e.accounts[0]?.accountId ?? null;
        setAccountId(id);
        setAuthAccount(id);
        if (id) toast.success(`Wallet connected: ${id}`);
      });
      connector.on("wallet:signOut", () => {
        setAccountId(null);
        setAuthAccount(null);
        toast("Wallet disconnected");
      });

      try {
        const existing = await connector.getConnectedWallet();
        const id = existing.accounts[0]?.accountId ?? null;
        if (!cancelled) {
          setAccountId(id);
          setAuthAccount(id);
        }
      } catch {
        /* not signed in yet */
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
      connectorRef.current?.removeAllListeners();
    };
  }, []);

  const connect = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) return;
    setConnecting(true);
    try {
      await c.connect();
    } catch {
      /* modal dismissed: do nothing, no error */
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) return;
    try {
      const wallet = await c.wallet();
      await c.disconnect(wallet);
    } catch {
      setAccountId(null);
      setAuthAccount(null);
    }
  }, []);

  const getWallet = useCallback(async () => {
    const c = connectorRef.current;
    if (!c) throw new Error("Wallet not ready");
    return c.wallet();
  }, []);

  const value = useMemo(
    () => ({ accountId, ready, connecting, connect, disconnect, getWallet }),
    [accountId, ready, connecting, connect, disconnect, getWallet],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
