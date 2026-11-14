import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { badRequest, forbidden, notFound, unauthorized } from "../errors.ts";
import type { KeyCheckMode } from "../near/accessKeys.ts";
// Sessions and API keys run on real time (systemNowIso), so replaying a past market window never locks anyone out.
import { newId, sha256Hex, systemNowIso } from "../util.ts";

/**
 * What a credential may do. A wallet session has all three; an API key has the ones it was issued with.
 * Managing keys and the profile is not a scope: it needs the wallet session itself (requireSession),
 * so every API key traces back to a wallet sign-in.
 */
export const SCOPES = ["publish", "read", "trade"] as const;
export type Scope = (typeof SCOPES)[number];
export const ISSUABLE_SCOPES = SCOPES;

export interface AccountRow {
  id: string;
  near_account_id: string;
  display_name: string;
  /** Dev mode only: the one key allowed to sign in while keys are not checked on NEAR. */
  dev_public_key: string | null;
  created_at: string;
}
type KeyCheck = KeyCheckMode;

interface KeyRow {
  id: string; account_id: string; key_hash: string; key_prefix: string; label: string; scopes: string;
  token_ids: string | null; key_check: KeyCheck; expires_at: string | null; revoked_at: string | null;
  last_used_at: string | null; created_at: string;
}

export interface Principal {
  account: AccountRow;
  /** "session": signed in with a NEAR wallet on the website. "api_key": an agent key issued from a session. */
  via: "session" | "api_key";
  /** API key id or session id. */
  keyId: string;
  scopes: Scope[];
  /** Tokens this key may read; null means any. */
  tokenIds: string[] | null;
  /** How the wallet sign-in behind this credential was checked. API keys inherit it from their session. */
  keyCheck: KeyCheck;
}

const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function assertNearAccountId(value: string, field = "near_account_id"): void {
  if (value.length < 2 || value.length > 64 || !NEAR_ACCOUNT_RE.test(value)) {
    throw badRequest("invalid_near_account", `${field} is not a valid NEAR account id: ${value}`);
  }
}

export function updateDisplayName(ctx: Ctx, principal: Principal, displayName: string) {
  requireSession(principal);
  const name = displayName.trim();
  if (!name || name.length > 80) throw badRequest("invalid_display_name", "display_name must be 1-80 characters");
  ctx.db.prepare("UPDATE accounts SET display_name = ? WHERE id = ?").run(name, principal.account.id);
  return accountView(getAccount(ctx, principal.account.id));
}

export function issueKey(
  ctx: Ctx,
  principal: Principal,
  input: { scopes: Scope[]; label?: string; tokenIds?: string[] | null; expiresInSeconds?: number | null },
) {
  requireSession(principal);
  if (input.scopes.length === 0) throw badRequest("invalid_scopes", "A key needs at least one scope");
  for (const s of input.scopes) {
    if (!(ISSUABLE_SCOPES as readonly string[]).includes(s)) {
      throw badRequest("invalid_scopes", `Scope "${s}" cannot be issued. Use ${ISSUABLE_SCOPES.join(", ")}.`);
    }
  }
  const expiresAt = input.expiresInSeconds ? new Date(Date.now() + input.expiresInSeconds * 1000).toISOString() : null;
  return insertKey(ctx, principal.account.id, {
    scopes: [...new Set(input.scopes)],
    label: input.label ?? input.scopes.join("+"),
    tokenIds: input.tokenIds?.length ? input.tokenIds : null,
    keyCheck: principal.keyCheck,
    expiresAt,
  });
}

export function listKeys(ctx: Ctx, principal: Principal) {
  requireSession(principal);
  const rows = ctx.db.prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at").all(principal.account.id) as unknown as KeyRow[];
  return rows.map(keyView);
}

export function revokeKey(ctx: Ctx, principal: Principal, keyId: string) {
  requireSession(principal);
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE id = ? AND account_id = ?").get(keyId, principal.account.id) as KeyRow | undefined;
  if (!row) throw notFound("API key");
  if (!row.revoked_at) {
    row.revoked_at = systemNowIso();
    ctx.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(row.revoked_at, row.id);
  }
  return keyView(row);
}

const CONNECT_WALLET = "Connect your NEAR wallet first: sign in on the website, then use the session or an API key it issued.";

/** Accepts a wallet session token (`cdxs_…`) or an API key (`cdx_…`). Anything else is anonymous and gets 401. */
export function authenticate(ctx: Ctx, rawKey: string | undefined): Principal {
  if (!rawKey) throw unauthorized(CONNECT_WALLET);
  return rawKey.startsWith("cdxs_") ? authenticateSession(ctx, rawKey) : authenticateApiKey(ctx, rawKey);
}

function authenticateSession(ctx: Ctx, token: string): Principal {
  const row = ctx.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256Hex(token)) as
    | { id: string; account_id: string; key_check: KeyCheck; expires_at: string; revoked_at: string | null } | undefined;
  if (!row) throw unauthorized(CONNECT_WALLET);
  if (row.revoked_at) throw unauthorized("This session has been signed out. Connect your wallet again.");
  if (row.expires_at <= systemNowIso()) throw unauthorized("This session has expired. Connect your wallet again.");
  assertCheckedOnChainIfRequired(ctx, row.key_check);
  return {
    account: getAccount(ctx, row.account_id), via: "session", keyId: row.id, scopes: [...SCOPES], tokenIds: null,
    keyCheck: row.key_check,
  };
}

function authenticateApiKey(ctx: Ctx, rawKey: string): Principal {
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(sha256Hex(rawKey)) as KeyRow | undefined;
  if (!row) throw unauthorized("Invalid API key. " + CONNECT_WALLET);
  if (row.revoked_at) throw unauthorized("This API key has been revoked");
  if (row.expires_at && row.expires_at <= systemNowIso()) throw unauthorized("This API key has expired");
  assertCheckedOnChainIfRequired(ctx, row.key_check);
  ctx.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(systemNowIso(), row.id);
  return {
    account: getAccount(ctx, row.account_id),
    via: "api_key",
    keyId: row.id,
    scopes: JSON.parse(row.scopes),
    tokenIds: row.token_ids ? JSON.parse(row.token_ids) : null,
    keyCheck: row.key_check,
  };
}

/**
 * When the server checks wallet keys on NEAR, refuse credentials from sign-ins that skipped that check
 * (dev mode). They can only exist here if a file store is reused after switching modes.
 */
function assertCheckedOnChainIfRequired(ctx: Ctx, keyCheck: KeyCheck): void {
  if (ctx.accessKeys.mode === "near-rpc" && keyCheck !== "near-rpc") {
    throw unauthorized(
      "This credential comes from a sign-in that skipped the on-chain wallet check (dev mode). Connect your wallet again.",
    );
  }
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden("missing_scope", `This API key lacks the "${scope}" scope`);
  }
}

/** Managing keys and the profile needs the wallet-signed website session, not an API key. */
export function requireSession(principal: Principal): void {
  if (principal.via !== "session") {
    throw forbidden("wallet_session_required", "Only a wallet-connected website session can do this, not an API key");
  }
}

export function getAccount(ctx: Ctx, accountId: string): AccountRow {
  const row = ctx.db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as AccountRow | undefined;
  if (!row) throw notFound("Account");
  return row;
}

export function accountView(a: AccountRow) {
  return { id: a.id, near_account_id: a.near_account_id, display_name: a.display_name, created_at: a.created_at };
}

// ---- internals ----

function insertKey(
  ctx: Ctx,
  accountId: string,
  k: { scopes: Scope[]; label: string; tokenIds: string[] | null; keyCheck: KeyCheck; expiresAt: string | null },
) {
  const secret = `cdx_${randomBytes(24).toString("base64url")}`;
  const row: KeyRow = {
    id: newId("key"),
    account_id: accountId,
    key_hash: sha256Hex(secret),
    key_prefix: secret.slice(0, 10),
    label: k.label,
    scopes: JSON.stringify(k.scopes),
    token_ids: k.tokenIds ? JSON.stringify(k.tokenIds) : null,
    key_check: k.keyCheck,
    expires_at: k.expiresAt,
    revoked_at: null,
    last_used_at: null,
    created_at: systemNowIso(),
  };
  ctx.db.prepare(
    `INSERT INTO api_keys (id, account_id, key_hash, key_prefix, label, scopes, token_ids, key_check, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.account_id, row.key_hash, row.key_prefix, row.label, row.scopes, row.token_ids, row.key_check, row.expires_at, row.created_at);
  // The secret is returned once and never stored.
  return { ...keyView(row), secret };
}

function keyView(r: KeyRow) {
  return {
    id: r.id,
    prefix: r.key_prefix,
    label: r.label,
    scopes: JSON.parse(r.scopes) as Scope[],
    token_ids: r.token_ids ? (JSON.parse(r.token_ids) as string[]) : null,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  };
}
