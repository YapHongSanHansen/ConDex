import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { amount, canonicalJson, newId, nowIso, parseNear, sha256Hex } from "../util.ts";
import { type Principal, accountView, assertNearAccountId, getAccount, requireScope } from "./accounts.ts";

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at?: string;
}

export interface PublishInput {
  title: string;
  market?: string | null;
  summary?: string | null;
  expiresAt?: string | null;
  feeNear: string;
  payoutAccount?: string | null;
  messages: Message[];
}

export interface VersionRow {
  token_id: string; insight_id: string; version: number; creator_id: string; payout_account: string;
  fee_yocto: string; title: string; market: string | null; summary: string | null; expires_at: string | null;
  messages: string; content_hash: string; mint_tx: string; created_at: string;
}

/** Publishes a new insight. Its first version is minted as a token. */
export function publishInsight(ctx: Ctx, principal: Principal, input: PublishInput) {
  requireScope(principal, "publish");
  return transaction(ctx.db, () => {
    const insightId = newId("ins");
    ctx.db.prepare("INSERT INTO insights (id, creator_id, created_at) VALUES (?, ?, ?)")
      .run(insightId, principal.account.id, nowIso());
    return insertVersion(ctx, principal, insightId, 1, input);
  });
}

/** Publishes the next version of an existing insight. The earlier tokens stay valid. */
export function publishVersion(ctx: Ctx, principal: Principal, insightId: string, input: PublishInput) {
  requireScope(principal, "publish");
  return transaction(ctx.db, () => {
    const insight = ctx.db.prepare("SELECT * FROM insights WHERE id = ?").get(insightId) as
      | { id: string; creator_id: string } | undefined;
    if (!insight) throw notFound("Insight");
    if (insight.creator_id !== principal.account.id) throw forbidden("not_creator", "Only the creator can publish a new version");
    const { v } = ctx.db.prepare("SELECT MAX(version) AS v FROM insight_versions WHERE insight_id = ?").get(insightId) as { v: number };
    return insertVersion(ctx, principal, insightId, v + 1, input);
  });
}

/** Public catalogue: metadata only, never the messages. */
export function listPreviews(ctx: Ctx, filter: { creatorId?: string; market?: string } = {}) {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.creatorId) { clauses.push("creator_id = ?"); params.push(filter.creatorId); }
  if (filter.market) { clauses.push("market = ?"); params.push(filter.market); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = ctx.db.prepare(`SELECT * FROM insight_versions ${where} ORDER BY created_at DESC LIMIT 200`).all(...params) as unknown as VersionRow[];
  return rows.map((r) => previewView(ctx, r));
}

export function getPreview(ctx: Ctx, tokenId: string) {
  return previewView(ctx, getVersion(ctx, tokenId));
}

/** Public publisher page: who they are, what they published and how often it was traded. No message content. */
export function publisherProfile(ctx: Ctx, nearAccountId: string) {
  const account = ctx.db.prepare("SELECT * FROM accounts WHERE near_account_id = ?").get(nearAccountId) as
    | Parameters<typeof accountView>[0] | undefined;
  if (!account) throw notFound(`Publisher ${nearAccountId}`);
  const { n: insightCount } = ctx.db.prepare("SELECT COUNT(*) AS n FROM insights WHERE creator_id = ?").get(account.id) as { n: number };
  const fees = ctx.db.prepare("SELECT fee_yocto FROM receipts WHERE creator_id = ?").all(account.id) as Array<{ fee_yocto: string }>;
  const { n: readCount } = ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM reads r JOIN insight_versions v ON v.token_id = r.token_id WHERE v.creator_id = ?",
  ).get(account.id) as { n: number };
  return {
    publisher: accountView(account),
    stats: {
      insights: insightCount,
      reads: readCount,
      filled_orders: fees.length,
      fees_earned: amount(fees.reduce((sum, f) => sum + BigInt(f.fee_yocto), 0n)),
    },
    tokens: listPreviews(ctx, { creatorId: account.id }),
  };
}

/** Serves the approved conversation. Reading is always free; each read is logged with a zero charge. */
export function readInsight(ctx: Ctx, principal: Principal, tokenId: string) {
  requireScope(principal, "read");
  if (principal.tokenIds && !principal.tokenIds.includes(tokenId)) {
    throw forbidden("token_not_in_scope", `This API key is limited to tokens: ${principal.tokenIds.join(", ")}`);
  }
  const row = getVersion(ctx, tokenId);
  ctx.db.prepare("INSERT INTO reads (id, token_id, reader_id, key_id, charged_yocto, created_at) VALUES (?, ?, ?, ?, '0', ?)")
    .run(newId("read"), tokenId, principal.account.id, principal.keyId, nowIso());
  // Yocto amounts exceed SQLite's 64-bit integers, so sum them as BigInt.
  const charges = ctx.db.prepare("SELECT charged_yocto FROM reads WHERE token_id = ? AND reader_id = ?")
    .all(tokenId, principal.account.id) as Array<{ charged_yocto: string }>;
  const total = charges.reduce((sum, r) => sum + BigInt(r.charged_yocto), 0n);
  return {
    ...previewView(ctx, row),
    messages: JSON.parse(row.messages) as Message[],
    charge: amount(0n),
    your_reads: { count: charges.length, total_charged: amount(total) },
  };
}

export function getVersion(ctx: Ctx, tokenId: string): VersionRow {
  const row = ctx.db.prepare("SELECT * FROM insight_versions WHERE token_id = ?").get(tokenId) as VersionRow | undefined;
  if (!row) throw notFound(`Token ${tokenId}`);
  return row;
}

export function isExpired(row: VersionRow): boolean {
  return !!row.expires_at && row.expires_at <= nowIso();
}

// ---- internals ----

function insertVersion(ctx: Ctx, principal: Principal, insightId: string, version: number, input: PublishInput) {
  validate(input);
  const feeYocto = parseNear(input.feeNear, "fee_near");
  const payoutAccount = input.payoutAccount ?? principal.account.near_account_id;
  assertNearAccountId(payoutAccount, "payout_account");
  const tokenId = `${insightId}-v${version}`;
  const content = {
    token_id: tokenId,
    insight_id: insightId,
    version,
    title: input.title,
    market: input.market ?? null,
    summary: input.summary ?? null,
    expires_at: input.expiresAt ?? null,
    messages: input.messages,
  };
  const contentHash = sha256Hex(canonicalJson(content));
  const { tx } = ctx.ledger.mintToken({
    tokenId,
    owner: principal.account.near_account_id,
    payoutAccount,
    feeYocto,
    contentHash,
  });
  const createdAt = nowIso();
  ctx.db.prepare(
    `INSERT INTO insight_versions (token_id, insight_id, version, creator_id, payout_account, fee_yocto, title, market,
       summary, expires_at, messages, content_hash, mint_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenId, insightId, version, principal.account.id, payoutAccount, feeYocto.toString(), input.title,
    content.market, content.summary, content.expires_at, JSON.stringify(input.messages), contentHash, tx, createdAt,
  );
  return previewView(ctx, getVersion(ctx, tokenId));
}

function validate(input: PublishInput) {
  if (input.expiresAt && Number.isNaN(Date.parse(input.expiresAt))) {
    throw badRequest("invalid_expiry", "expires_at must be an ISO 8601 date-time");
  }
  if (input.expiresAt && input.expiresAt <= nowIso()) {
    throw badRequest("invalid_expiry", "expires_at must be in the future");
  }
  if (input.messages.length === 0) throw badRequest("no_messages", "Select at least one message to publish");
}

function previewView(ctx: Ctx, r: VersionRow) {
  const creator = getAccount(ctx, r.creator_id);
  return {
    token_id: r.token_id,
    insight_id: r.insight_id,
    version: r.version,
    title: r.title,
    market: r.market,
    summary: r.summary,
    expires_at: r.expires_at,
    expired: isExpired(r),
    message_count: (JSON.parse(r.messages) as unknown[]).length,
    creator: accountView(creator),
    payout_account: r.payout_account,
    fee_per_filled_order: amount(r.fee_yocto),
    read_fee: amount(0n),
    content_hash: r.content_hash,
    mint: { ledger: ctx.ledger.kind, tx: r.mint_tx },
    created_at: r.created_at,
  };
}
