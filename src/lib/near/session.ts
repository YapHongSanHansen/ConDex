import type { NearWalletBase } from "@hot-labs/near-connect";
import { api, getSession, setSession, type StoredSession } from "@/lib/api";

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * The backend signs sign-ins for one site name (CONDEX_AUTH_RECIPIENT). A wallet signs for that name, so a different
 * site could replay the signature elsewhere. On the real site the name must be this site's own, and if it is not the
 * operator has misconfigured the backend, so say so plainly instead of failing later with an unexplained error.
 * Locally the backend names itself (localhost:8787) while the site runs on another port, so this is not enforced there.
 */
function assertRecipientIsThisSite(recipient: string) {
  if (process.env.NODE_ENV !== "production" || typeof window === "undefined") return;
  const { host, hostname } = window.location;
  if (recipient !== host && recipient !== hostname) {
    throw new Error(`ConDex's backend signs sign-ins for "${recipient}", but this site is "${host}". The operator needs to set CONDEX_AUTH_RECIPIENT=${hostname}.`);
  }
}

/** The stored session, but only if it belongs to the wallet that is connected right now. */
export function sessionFor(accountId: string | null): StoredSession | null {
  const s = getSession();
  return s && accountId && s.accountId === accountId ? s : null;
}

/**
 * Signs in to ConDex with the connected wallet (NEP-413): ConDex gives a challenge, the wallet signs it, and ConDex
 * answers with a session. Nothing is spent and no transaction is made. The session is what can issue API keys.
 */
export async function signInToBackend(wallet: Pick<NearWalletBase, "signMessage"> | null, accountId: string): Promise<StoredSession> {
  const challenge = await api.auth.challenge();
  assertRecipientIsThisSite(challenge.recipient);
  if (!wallet) throw new Error("Wallet not ready");
  const signed = await wallet.signMessage({ message: challenge.message, recipient: challenge.recipient, nonce: fromBase64(challenge.nonce) });
  if (signed.accountId !== accountId) throw new Error(`The wallet signed as ${signed.accountId}, not ${accountId}`);
  const result = await api.auth.verify({ account_id: signed.accountId, public_key: signed.publicKey, signature: signed.signature, nonce: challenge.nonce });
  const session: StoredSession = { token: result.session.token, accountId: result.account.near_account_id, expiresAt: result.session.expires_at };
  setSession(session);
  return session;
}

export async function signOutOfBackend() {
  try {
    if (getSession()) await api.auth.logout();
  } catch {
    /* the session may already have ended */
  }
  setSession(null);
}
