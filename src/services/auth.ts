import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { ApiError, unauthorized } from "../errors.ts";
import { verifyNep413 } from "../near/nep413.ts";
import { newId, nowIso, sha256Hex } from "../util.ts";
import { type AccountRow, accountView, assertNearAccountId } from "./accounts.ts";

interface ChallengeRow { nonce: string; message: string; recipient: string; expires_at: string; used_at: string | null }

/**
 * Challenges are handed out to anyone without a wallet, so their number is capped. Expired ones are
 * deleted first; with the default 5-minute lifetime this allows about 33 new sign-ins a second.
 */
export const MAX_OPEN_CHALLENGES = 10_000;

/**
 * Step 1 of "Connect wallet": a one-time message for the wallet to sign (NEP-413).
 * The website passes `message`, `nonce` (32 bytes, base64) and `recipient` to the wallet's signMessage.
 */
export function createChallenge(ctx: Ctx) {
  ctx.db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?").run(nowIso());
  const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get() as { n: number };
  if (n >= MAX_OPEN_CHALLENGES) {
    throw new ApiError(429, "too_many_sign_ins", "Too many sign-ins are in progress. Try again in a few minutes.");
  }
  const nonce = newNonce();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ctx.config.challengeTtlSeconds * 1000).toISOString();
  // One line with no quotes, so it can be pasted into a near-cli command as well as shown by a wallet.
  const message = `Sign in to ConDex. This proves you control this NEAR account and does not send a transaction or cost anything. Issued ${createdAt}`;
  ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(nonce, message, ctx.config.authRecipient, expiresAt, createdAt);
  return {
    message,
    nonce,
    recipient: ctx.config.authRecipient,
    network: ctx.config.nearNetwork,
    expires_at: expiresAt,
  };
}

/**
 * 32 random bytes as base64, never starting with "/": Git Bash on Windows rewrites an argument that
 * starts with "/" into a file path, which would break the near-cli command for 1 in 64 sign-ins.
 */
export function newNonce(): string {
  for (;;) {
    const bytes = randomBytes(32);
    if (bytes[0]! < 0xfc) return bytes.toString("base64");
  }
}

export interface SignInInput {
  accountId: string;
  publicKey: string;
  /** base64 (browser wallets) or "ed25519:<base58>" (near-cli) */
  signature: string;
  nonce: string;
  /**
   * The callbackUrl the website gave a redirect wallet (e.g. MyNearWallet). Such wallets sign it as part
   * of the NEP-413 payload; popup and extension wallets and near-cli do not.
   */
  callbackUrl?: string | null;
  displayName?: string | null;
}

/**
 * Step 2: verify the wallet's signature, confirm the key belongs to the account, then
 * create the ConDex account on first sign-in and open a website session.
 */
export async function verifySignIn(ctx: Ctx, input: SignInInput) {
  assertNearAccountId(input.accountId, "account_id");
  const challenge = ctx.db.prepare("SELECT * FROM auth_challenges WHERE nonce = ?").get(input.nonce) as ChallengeRow | undefined;
  if (!challenge) throw unauthorized("Unknown sign-in challenge. Request a new one.");
  if (challenge.used_at) throw unauthorized("This sign-in challenge was already used. Request a new one.");
  if (challenge.expires_at <= nowIso()) throw unauthorized("This sign-in challenge has expired. Request a new one.");

  // Accept the signature with or without the callbackUrl, because a website may send the callbackUrl
  // whichever way the wallet opened. Both forms are bound to this server's nonce, message and recipient.
  const payload = { message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"), recipient: challenge.recipient };
  const ok = verifyNep413(input.publicKey, input.signature, payload)
    || (input.callbackUrl != null && verifyNep413(input.publicKey, input.signature, { ...payload, callbackUrl: input.callbackUrl }));
  if (!ok) throw unauthorized("The wallet signature does not match this challenge and public key.");

  let owned: boolean;
  try {
    owned = await ctx.accessKeys.isFullAccessKey(input.accountId, input.publicKey);
  } catch (err) {
    throw new ApiError(502, "near_rpc_unavailable", `Could not check the key on NEAR: ${(err as Error).message}`);
  }
  if (!owned) {
    throw unauthorized(`${input.publicKey} is not a full-access key of ${input.accountId} on NEAR ${ctx.config.nearNetwork}.`);
  }

  return transaction(ctx.db, () => {
    // Re-check inside the transaction so two concurrent requests cannot both use the challenge.
    const used = ctx.db.prepare("UPDATE auth_challenges SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(nowIso(), challenge.nonce);
    if (used.changes === 0) throw unauthorized("This sign-in challenge was already used. Request a new one.");

    let account = ctx.db.prepare("SELECT * FROM accounts WHERE near_account_id = ?").get(input.accountId) as AccountRow | undefined;
    const isNew = !account;
    if (!account) {
      account = {
        id: newId("acct"),
        near_account_id: input.accountId,
        display_name: input.displayName?.trim() || input.accountId,
        created_at: nowIso(),
      };
      ctx.db.prepare("INSERT INTO accounts (id, near_account_id, display_name, created_at) VALUES (?, ?, ?, ?)")
        .run(account.id, account.near_account_id, account.display_name, account.created_at);
    }

    const token = `cdxs_${randomBytes(32).toString("base64url")}`;
    const session = {
      id: newId("sess"),
      expires_at: new Date(Date.now() + ctx.config.sessionTtlSeconds * 1000).toISOString(),
    };
    ctx.db.prepare(
      `INSERT INTO sessions (id, account_id, token_hash, public_key, key_check, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(session.id, account.id, sha256Hex(token), input.publicKey, ctx.accessKeys.mode, session.expires_at, nowIso());

    return {
      account: accountView(account),
      new_account: isNew,
      session: {
        id: session.id,
        token, // returned once; the website keeps it and sends it as a Bearer token
        expires_at: session.expires_at,
        wallet_public_key: input.publicKey,
        key_check: ctx.accessKeys.mode,
      },
    };
  });
}

export function signOut(ctx: Ctx, sessionId: string) {
  ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), sessionId);
  return { ok: true };
}
