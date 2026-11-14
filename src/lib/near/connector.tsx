"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NearConnector, NearWalletBase } from "@hot-labs/near-connect";
import { toast } from "sonner";
import { friendlyError, getSession, subscribeSession, toApiError } from "@/lib/api";
import { DEV_WALLET, NEAR_NETWORK } from "@/lib/config";
import { devWallet } from "./dev-wallet";
import { sessionFor, signInToBackend, signOutOfBackend } from "./session";

interface WalletState {
  accountId: string | null;
  /** True once ConDex has accepted the wallet's signature. Keys are managed from this session. */
  signedIn: boolean;
  signingIn: boolean;
  /** Asks the wallet to sign ConDex's challenge. Needed again after a reload, when the session has ended. */
  signIn: () => Promise<void>;
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
  // Signed in means the stored session belongs to the connected wallet. It follows the session itself, so when the backend
  // refuses it (after a restart, say) the page goes back to asking for a sign-in instead of showing errors.
  const session = useSyncExternalStore(subscribeSession, getSession, () => null);
  const signedIn = !!accountId && session?.accountId === accountId;
  const [signingIn, setSigningIn] = useState(false);

  const doSignIn = useCallback(async (id: string) => {
    setSigningIn(true);
    try {
      const wallet = DEV_WALLET ? await devWallet(id) : (await connectorRef.current?.wallet().catch(() => null)) ?? null;
      await signInToBackend(wallet, id);toast.success("Signed in to ConDex");
    } catch (err) {const f = friendlyError(toApiError(err));
      toast.error(err instanceof Error && !err.name.includes("ApiError") ? `Couldn't sign in: ${err.message}` : f.title);
    } finally {
      setSigningIn(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (DEV_WALLET) {
      // The development stand-in wallet: connected from the start, with a session from earlier in this tab if there is one.
      queueMicrotask(() => { setAccountId(DEV_WALLET); setReady(true); });
      return;
    }
    (async () => {
      // Loaded client-side only: the library touches window/IndexedDB.
      const { NearConnector } = await import("@hot-labs/near-connect");
      if (cancelled) return;
      const connector = new NearConnector({ network: NEAR_NETWORK });
      connectorRef.current = connector;

      connector.on("wallet:signIn", (e) => {
        // VERIFIED in the library README: account id lives at accounts[0].accountId
        const id = e.accounts[0]?.accountId ?? null;
        setAccountId(id);if (id) toast.success(`Wallet connected: ${id}`);
        // Connecting is followed straight away by signing ConDex's challenge, so one click gives a working session.
        if (id && !sessionFor(id)) void doSignIn(id);
      });
      connector.on("wallet:signOut", () => {
        setAccountId(null);void signOutOfBackend();
        toast("Wallet disconnected");
      });

      try {
        const existing = await connector.getConnectedWallet();
        const id = existing.accounts[0]?.accountId ?? null;
        if (!cancelled) {
          setAccountId(id);
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
  }, [doSignIn]);

  const connect = useCallback(async () => {
    if (DEV_WALLET) { setAccountId(DEV_WALLET); if (!sessionFor(DEV_WALLET)) void doSignIn(DEV_WALLET); return; }
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
  }, [doSignIn]);

  const disconnect = useCallback(async () => {
    if (DEV_WALLET) {
      // The stand-in wallet has no connector: signing out just ends the ConDex session.void signOutOfBackend();
      return;
    }
    const c = connectorRef.current;
    if (!c) return;
    try {
      const wallet = await c.wallet();
      await c.disconnect(wallet);
    } catch {
      setAccountId(null);void signOutOfBackend();
    }
  }, []);

  const getWallet = useCallback(async () => {
    if (DEV_WALLET) return (await devWallet(DEV_WALLET)) as unknown as NearWalletBase;
    const c = connectorRef.current;
    if (!c) throw new Error("Wallet not ready");
    return c.wallet();
  }, []);

  const signIn = useCallback(async () => {
    if (accountId) await doSignIn(accountId);
  }, [accountId, doSignIn]);

  const value = useMemo(
    () => ({ accountId, signedIn, signingIn, signIn, ready, connecting, connect, disconnect, getWallet }),
    [accountId, signedIn, signingIn, signIn, ready, connecting, connect, disconnect, getWallet],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside <WalletProvider>");
  return ctx;
}
