import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { amount, canonicalJson, newId, nowIso, parseNear, sha256Hex } from "../util.ts";
import type { ResolvedExpiry } from "./expiry.ts";
import { type AccountRow, type Principal, accountView, assertNearAccountId, getAccount, requireScope } from "./accounts.ts";

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at?: string;
}

/** The thesis conditions in the creator's own words. Preserved exactly as published: they are part of the content hash. */
export interface Conditions {
  /** long opens with a buy, short with a sell. */
  direction: "long" | "short" | null;
  entry: string | null;
  invalidation: string | null;
  /** Optional: when to take profit or close. */
  exit: string | null;
}

export interface PublishInput {
  title: string;
  market?: string | null;
  summary?: string | null;
  conditions?: Conditions | null;
  /** Already resolved by `resolveExpiry`: the creator's own, or the one ConDex's AI set. */
  expiry: ResolvedExpiry;
  feeNear: string;
  payoutAccount?: string | null;
  messages: Message[];
}

export interface VersionRow {
  token_id: string; insight_id: string; version: number; creator_id: string; payout_account: string;
  fee_yocto: string; title: string; market: string | null; summary: string | null; expires_at: string | null;
  expiry_source: "creator" | "ai" | null; expiry_reason: string | null; conditions: string | null; messages: string; content_hash: string; mint_tx: string; created_at: string;
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
  const account = ctx.db.prepare("SELECT * FROM accounts WHERE near_account_id = ?").get(nearAccountId) as AccountRow | undefined;
  if (!account) throw notFound(`Publisher ${nearAccountId}`);
  const { n: insightCount } = ctx.db.prepare("SELECT COUNT(*) AS n FROM insights WHERE creator_id = ?").get(account.id) as { n: number };
  // A receipt exists once an order linked to one of their insights got its first confirmed fill (even a
  // partial one): that is when the fee was paid, to the payout account set on that insight version.
  const receipts = ctx.db.prepare("SELECT fee_yocto, payout_account FROM receipts WHERE creator_id = ?").all(account.id) as
    Array<{ fee_yocto: string; payout_account: string }>;
  const { n: readCount } = ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM reads r JOIN insight_versions v ON v.token_id = r.token_id WHERE v.creator_id = ?",
  ).get(account.id) as { n: number };
  return {
    publisher: accountView(account),
    stats: {
      insights: insightCount,
      reads: readCount,
      /** Linked orders that got at least one confirmed fill, so their fee was paid. */
      paid_orders: receipts.length,
      /** Total of those fees, paid to the payout accounts below (which may differ from the publisher). */
      fees_paid: amount(receipts.reduce((sum, r) => sum + BigInt(r.fee_yocto), 0n)),
      payout_accounts: [...new Set(receipts.map((r) => r.payout_account))],
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
    conditions: conditionsOf(row),
    messages: JSON.parse(row.messages) as Message[],
    integrity: integrity(row),
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

/** The conditions as published, or null for a thesis published without any. */
export function conditionsOf(r: VersionRow): Conditions | null {
  return r.conditions ? (JSON.parse(r.conditions) as Conditions) : null;
}

/** The exact object that is hashed. Rebuilt from the stored row, so the fingerprint can be re-checked at any time. */
function contentOf(r: VersionRow) {
  return {
    token_id: r.token_id,
    insight_id: r.insight_id,
    version: r.version,
    title: r.title,
    market: r.market,
    summary: r.summary,
    conditions: conditionsOf(r),
    expires_at: r.expires_at,
    expiry_source: r.expiry_source,
    expiry_reason: r.expiry_reason,
    messages: JSON.parse(r.messages) as Message[],
  };
}

/** Recomputes the fingerprint from what is stored and compares it with the one minted on the ledger. */
function integrity(r: VersionRow) {
  const recomputed = sha256Hex(canonicalJson(contentOf(r)));
  return { content_hash: r.content_hash, recomputed_hash: recomputed, matches: recomputed === r.content_hash };
}

/**
 * Proof of thesis plus every proof of trade linked to it. Public: it holds what the NFT records on NEAR, and
 * never the conversation or the conditions, only their fingerprint.
 */
export function thesisProof(ctx: Ctx, tokenId: string) {
  const row = getVersion(ctx, tokenId);
  const trades = ctx.db.prepare(
    `SELECT r.id AS receipt_id, r.fee_yocto, r.evidence_source, r.settle_tx, r.created_at AS proven_at,
            o.id AS order_id, o.market, o.side, o.quantity, o.filled_quantity, o.status, o.created_at AS authorised_at,
            a.near_account_id AS trader, e.quantity AS fill_quantity, e.price AS fill_price, e.received_at AS fill_at
       FROM receipts r
       JOIN orders o ON o.id = r.order_id
       JOIN accounts a ON a.id = r.borrower_id
       LEFT JOIN execution_events e ON e.id = r.first_fill_event_id
      WHERE r.token_id = ? ORDER BY r.created_at, r.rowid`,
  ).all(tokenId) as unknown as Array<{
    receipt_id: string; fee_yocto: string; evidence_source: string; settle_tx: string; proven_at: string; order_id: string;
    market: string; side: "buy" | "sell"; quantity: string; filled_quantity: string; status: string; authorised_at: string;
    trader: string; fill_quantity: string | null; fill_price: string | null; fill_at: string | null;
  }>;
  const creator = accountView(getAccount(ctx, row.creator_id));
  return {
    proof_of_thesis: {
      token_id: row.token_id,
      insight_id: row.insight_id,
      version: row.version,
      creator,
      published_at: row.created_at,
      expires_at: row.expires_at,
      expiry: { set_by: row.expiry_source, reason: row.expiry_reason },
      content_hash: row.content_hash,
      /** True while the stored conditions and conversation still hash to the minted fingerprint. */
      preserved: integrity(row).matches,
      usage_fee_per_filled_trade: amount(row.fee_yocto),
      payout_account: row.payout_account,
      mint: { ledger: ctx.ledger.kind, tx: row.mint_tx },
    },
    proofs_of_trade: trades.map((t) => ({
      receipt_id: t.receipt_id,
      thesis: { token_id: row.token_id, content_hash: row.content_hash },
      trader: t.trader,
      role: t.trader === creator.near_account_id ? "creator" : "borrower",
      order: { id: t.order_id, market: t.market, side: t.side, quantity: t.quantity, authorised_at: t.authorised_at, status: t.status },
      fill: { at: t.fill_at, price: t.fill_price, quantity: t.fill_quantity, source: t.evidence_source },
      fee_paid: amount(t.fee_yocto),
      settlement: { ledger: ctx.ledger.kind, tx: t.settle_tx },
      // Closing fills are not tracked yet, so no result is calculated.
      closing_fill: null,
      proven_at: t.proven_at,
    })),
  };
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
    conditions: input.conditions ?? null,
    expires_at: input.expiry.expiresAt,
    expiry_source: input.expiry.source,
    expiry_reason: input.expiry.reason,
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
       summary, expires_at, expiry_source, expiry_reason, conditions, messages, content_hash, mint_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenId, insightId, version, principal.account.id, payoutAccount, feeYocto.toString(), input.title,
    content.market, content.summary, content.expires_at,
    content.expiry_source, content.expiry_reason, content.conditions ? JSON.stringify(content.conditions) : null, JSON.stringify(input.messages), contentHash, tx, createdAt,
  );
  return previewView(ctx, getVersion(ctx, tokenId));
}

function validate(input: PublishInput) {
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
    conditions_set: r.conditions !== null,
    direction: conditionsOf(r)?.direction ?? null,
    published_at: r.created_at,
    expires_at: r.expires_at,
    expiry: { set_by: r.expiry_source, reason: r.expiry_reason },
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
