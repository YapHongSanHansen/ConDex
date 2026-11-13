import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { ApiError, badRequest, unauthorized } from "../errors.ts";
import { verifyNep413 } from "../near/nep413.ts";
import { newId, nowIso, sha256Hex } from "../util.ts";
import { type AccountRow, accountView, assertNearAccountId } from "./accounts.ts";

interface ChallengeRow { nonce: string; message: string; recipient: string; expires_at: string; used_at: string | null }

/**
 * Anyone can ask for a sign-in challenge, so three limits keep that from being used to lock others out
 * or to fill memory: new challenges per client per minute (config.signInsPerMinute), unfinished
 * challenges per client, and unfinished challenges in total. One client can no longer reach the total.
 */
export const MAX_OPEN_CHALLENGES_PER_CLIENT = 20;
export const MAX_OPEN_CHALLENGES = 10_000;

const tooMany = (message: string) => new ApiError(429, "too_many_sign_ins", message);
const count = (ctx: Ctx, sql: string, ...params: string[]) => (ctx.db.prepare(sql).get(...params) as { n: number }).n;

/**
 * Step 1 of "Connect wallet": a one-time message for the wallet to sign (NEP-413).
 * The website passes `message`, `nonce` (32 bytes, base64) and `recipient` to the wallet's signMessage.
 * `client` is the caller's network address, used only for the limits above.
 */
export function createChallenge(ctx: Ctx, client: string) {
  const now = Date.now();
  const nowText = new Date(now).toISOString();
  const minuteAgo = new Date(now - 60_000).toISOString();
  // Rows stay at least a minute, so the per-minute count is right even with a short challenge lifetime.
  ctx.db.prepare("DELETE FROM auth_challenges WHERE expires_at <= ? AND created_at <= ?").run(nowText, minuteAgo);

  if (count(ctx, "SELECT COUNT(*) AS n FROM auth_challenges WHERE client = ? AND created_at > ?", client, minuteAgo) >= ctx.config.signInsPerMinute) {
    throw tooMany("Too many sign-in attempts from your network. Wait a minute and try again.");
  }
  const open = "used_at IS NULL AND expires_at > ?";
  if (count(ctx, `SELECT COUNT(*) AS n FROM auth_challenges WHERE client = ? AND ${open}`, client, nowText) >= MAX_OPEN_CHALLENGES_PER_CLIENT) {
    throw tooMany("You have too many unfinished sign-ins. Finish one, or wait a few minutes for them to expire.");
  }
  if (count(ctx, `SELECT COUNT(*) AS n FROM auth_challenges WHERE ${open}`, nowText) >= MAX_OPEN_CHALLENGES) {
    throw tooMany("Too many sign-ins are in progress. Try again in a few minutes.");
  }

  const nonce = newNonce();
  const recipient = ctx.config.authRecipient;
  const expiresAt = new Date(now + ctx.config.challengeTtlSeconds * 1000).toISOString();
  // The site's domain is in the text so a user can tell when a look-alike site asks them to sign in.
  // One line with no quotes, so it can be pasted into a near-cli command as well as shown by a wallet.
  const message = `Sign in to ConDex at ${recipient}. This proves you control this NEAR account and does not send a transaction or cost anything. Issued ${nowText}`;
  ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, client, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(nonce, message, recipient, client, expiresAt, nowText);
  return { message, nonce, recipient, network: ctx.config.nearNetwork, expires_at: expiresAt };
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
   * of the NEP-413 payload; popup and extension wallets and near-cli do not. It must be on this site.
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
  if (input.callbackUrl != null && !isAllowedCallback(ctx, input.callbackUrl)) {
    throw badRequest("callback_not_allowed", "callback_url must point to this website (see CONDEX_ALLOWED_ORIGINS)");
  }
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
    throw new ApiError(502, "near_rpc_unavailable", `Could not check the key on NEAR, try again: ${(err as Error).message}`);
  }
  if (!owned) {
    throw unauthorized(`${input.publicKey} is not a full-access key of ${input.accountId} on NEAR ${ctx.config.nearNetwork}.`);
  }
  const pinKeys = ctx.accessKeys.mode === "none";

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
        dev_public_key: pinKeys ? input.publicKey : null,
        created_at: nowIso(),
      };
      ctx.db.prepare("INSERT INTO accounts (id, near_account_id, display_name, dev_public_key, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(account.id, account.near_account_id, account.display_name, account.dev_public_key, account.created_at);
    } else if (pinKeys) {
      // Without the on-chain check anyone can produce a valid signature for any name, so after the
      // first sign-in only that same key may sign in as this account.
      if (account.dev_public_key && account.dev_public_key !== input.publicKey) {
        throw unauthorized(
          `${input.accountId} was first connected with a different key. While the server skips the on-chain key ` +
          "check (dev mode), only that key can sign in as this account. Use the same wallet, or reset the data.",
        );
      }
      if (!account.dev_public_key) {
        ctx.db.prepare("UPDATE accounts SET dev_public_key = ? WHERE id = ?").run(input.publicKey, account.id);
      }
    }

    ctx.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
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

function isAllowedCallback(ctx: Ctx, callbackUrl: string): boolean {
  try {
    return ctx.config.allowedOrigins.includes(new URL(callbackUrl).origin);
  } catch {
    return false;
  }
}

export function signOut(ctx: Ctx, sessionId: string) {
  ctx.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), sessionId);
  return { ok: true };
}
