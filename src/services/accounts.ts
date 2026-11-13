import { randomBytes } from "node:crypto";
import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../errors.ts";
import { newId, nowIso, sha256Hex } from "../util.ts";

export const SCOPES = ["admin", "publish", "read", "trade"] as const;
export type Scope = (typeof SCOPES)[number];
/** Scopes an owner can put on a new key. `admin` is only on the owner key created with the account. */
export const ISSUABLE_SCOPES = ["publish", "read", "trade"] as const;

export interface AccountRow { id: string; near_account_id: string; display_name: string; created_at: string }
interface KeyRow {
  id: string; account_id: string; key_hash: string; key_prefix: string; label: string; scopes: string;
  token_ids: string | null; expires_at: string | null; revoked_at: string | null; last_used_at: string | null;
  created_at: string;
}

export interface Principal {
  account: AccountRow;
  keyId: string;
  scopes: Scope[];
  /** Tokens this key may read; null means any. */
  tokenIds: string[] | null;
}

const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function assertNearAccountId(value: string, field = "near_account_id"): void {
  if (value.length < 2 || value.length > 64 || !NEAR_ACCOUNT_RE.test(value)) {
    throw badRequest("invalid_near_account", `${field} is not a valid NEAR account id: ${value}`);
  }
}

export function createAccount(ctx: Ctx, input: { nearAccountId: string; displayName: string }) {
  assertNearAccountId(input.nearAccountId);
  return transaction(ctx.db, () => {
    const taken = ctx.db.prepare("SELECT 1 FROM accounts WHERE near_account_id = ?").get(input.nearAccountId);
    if (taken) throw conflict("account_exists", `${input.nearAccountId} already has a ConDex account`);
    const account: AccountRow = {
      id: newId("acct"),
      near_account_id: input.nearAccountId,
      display_name: input.displayName,
      created_at: nowIso(),
    };
    ctx.db.prepare("INSERT INTO accounts (id, near_account_id, display_name, created_at) VALUES (?, ?, ?, ?)")
      .run(account.id, account.near_account_id, account.display_name, account.created_at);
    const ownerKey = insertKey(ctx, account.id, { scopes: [...SCOPES], label: "owner", tokenIds: null, expiresAt: null });
    return { account: accountView(account), owner_key: ownerKey };
  });
}

export function issueKey(
  ctx: Ctx,
  principal: Principal,
  input: { scopes: Scope[]; label?: string; tokenIds?: string[] | null; expiresInSeconds?: number | null },
) {
  requireScope(principal, "admin");
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
    expiresAt,
  });
}

export function listKeys(ctx: Ctx, principal: Principal) {
  requireScope(principal, "admin");
  const rows = ctx.db.prepare("SELECT * FROM api_keys WHERE account_id = ? ORDER BY created_at").all(principal.account.id) as unknown as KeyRow[];
  return rows.map(keyView);
}

export function revokeKey(ctx: Ctx, principal: Principal, keyId: string) {
  requireScope(principal, "admin");
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE id = ? AND account_id = ?").get(keyId, principal.account.id) as KeyRow | undefined;
  if (!row) throw notFound("API key");
  if (row.id === principal.keyId) throw badRequest("cannot_revoke_self", "Use a different admin key to revoke this one");
  if (!row.revoked_at) {
    row.revoked_at = nowIso();
    ctx.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").run(row.revoked_at, row.id);
  }
  return keyView(row);
}

export function authenticate(ctx: Ctx, rawKey: string | undefined): Principal {
  if (!rawKey) throw unauthorized();
  const row = ctx.db.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(sha256Hex(rawKey)) as KeyRow | undefined;
  if (!row) throw unauthorized();
  if (row.revoked_at) throw unauthorized("This API key has been revoked");
  if (row.expires_at && row.expires_at <= nowIso()) throw unauthorized("This API key has expired");
  const account = ctx.db.prepare("SELECT * FROM accounts WHERE id = ?").get(row.account_id) as unknown as AccountRow;
  ctx.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return {
    account,
    keyId: row.id,
    scopes: JSON.parse(row.scopes),
    tokenIds: row.token_ids ? JSON.parse(row.token_ids) : null,
  };
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope)) {
    throw forbidden("missing_scope", `This API key lacks the "${scope}" scope`);
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
  k: { scopes: Scope[]; label: string; tokenIds: string[] | null; expiresAt: string | null },
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
    expires_at: k.expiresAt,
    revoked_at: null,
    last_used_at: null,
    created_at: nowIso(),
  };
  ctx.db.prepare(
    `INSERT INTO api_keys (id, account_id, key_hash, key_prefix, label, scopes, token_ids, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.account_id, row.key_hash, row.key_prefix, row.label, row.scopes, row.token_ids, row.expires_at, row.created_at);
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
