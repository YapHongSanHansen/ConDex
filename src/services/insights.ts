import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, forbidden, notFound } from "../errors.ts";
import { amount, canonicalJson, newId, nowIso, parseNear, sha256Hex } from "../util.ts";
import { type AccountRow, type Principal, accountView, assertNearAccountId, getAccount, requireScope } from "./accounts.ts";
import { type ExpirySetBy, type ResolvedExpiry, resolveExpiry } from "./expiry.ts";
import { loadOrder } from "./orders.ts";
import { tradeSummary } from "./trades.ts";

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at?: string;
}

export type Direction = "long" | "short";

/**
 * A thesis is the approved conversation plus its conditions. The conditions are separate fields, so they
 * can be recorded, preserved and compared with real trades.
 */
export interface PublishInput {
  title: string;
  /** What is traded, for example "ETH-USD". */
  market: string;
  direction: Direction;
  /** When to enter, in the creator's words. */
  entry: string;
  /** What would prove the idea wrong, in the creator's words. */
  invalidation: string;
  /** Optional: when to take profit or close. */
  target?: string | null;
  summary?: string | null;
  /** The last day a trade can be linked, YYYY-MM-DD (UTC). Without it, ConDex sets the expiry. */
  expiryDate?: string | null;
  /** The time on that day, HH:MM (UTC), when the thesis depends on one. Otherwise it expires at 23:59 UTC. */
  expiryTime?: string | null;
  /** Instead of a date and time: a full ISO 8601 instant. */
  expiresAt?: string | null;
  feeNear: string;
  payoutAccount?: string | null;
  messages: Message[];
}

export interface VersionRow {
  token_id: string; insight_id: string; version: number; creator_id: string; payout_account: string;
  fee_yocto: string; title: string; summary: string | null; market: string; direction: Direction; entry: string;
  invalidation: string; target: string | null; expires_at: string; expiry_time_given: number;
  expiry_set_by: ExpirySetBy; expiry_reason: string | null; messages: string; content_hash: string; mint_tx: string;
  created_at: string;
}

interface Conditions {
  market: string; direction: Direction; entry: string; invalidation: string; target: string | null;
}

/** A publish request after validation, with its expiry settled. */
interface Prepared extends Conditions {
  title: string; summary: string | null; feeYocto: bigint; payoutAccount: string; messages: Message[];
  expiry: ResolvedExpiry;
}

/** Publishes a new insight. Its first version is minted as a token. */
export async function publishInsight(ctx: Ctx, principal: Principal, input: PublishInput) {
  requireScope(principal, "publish");
  const prepared = await prepare(ctx, principal, input);
  return transaction(ctx.db, () => {
    const insightId = newId("ins");
    ctx.db.prepare("INSERT INTO insights (id, creator_id, created_at) VALUES (?, ?, ?)")
      .run(insightId, principal.account.id, nowIso());
    return insertVersion(ctx, principal, insightId, 1, prepared);
  });
}

/**
 * Publishes the next version of an existing insight. Earlier tokens stay valid and keep their own
 * conditions and expiry: changing either means publishing a version.
 */
export async function publishVersion(ctx: Ctx, principal: Principal, insightId: string, input: PublishInput) {
  requireScope(principal, "publish");
  assertCreator(ctx, principal, insightId);
  const prepared = await prepare(ctx, principal, input);
  return transaction(ctx.db, () => {
    assertCreator(ctx, principal, insightId); // settling the expiry may have taken a moment
    const { v } = ctx.db.prepare("SELECT MAX(version) AS v FROM insight_versions WHERE insight_id = ?").get(insightId) as { v: number };
    return insertVersion(ctx, principal, insightId, v + 1, prepared);
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

/**
 * Serves the approved conversation with its conditions. Reading is always free, including after the
 * expiry. Each read is logged with a zero charge.
 */
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
    ...detailView(ctx, row),
    messages: JSON.parse(row.messages) as Message[],
    /** Whether the stored conditions, expiry and messages still hash to the minted fingerprint. */
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

/** After the expiry no fee is quoted and no new order is linked. Reading and existing orders are unaffected. */
export function isExpired(row: VersionRow, at: string = nowIso()): boolean {
  return row.expires_at <= at;
}

/**
 * Proof of thesis plus every proof of trade linked to it. Public: it holds what the NFT records on NEAR, and
 * never the conversation or the creator's entry, invalidation and target, only their fingerprint.
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
      expiry: expiryView(row),
      content_hash: row.content_hash,
      /** True while the stored conditions, expiry and conversation still hash to the minted fingerprint. */
      preserved: integrity(row).matches,
      usage_fee_per_filled_trade: amount(row.fee_yocto),
      payout_account: row.payout_account,
      mint: { ledger: ctx.ledger.kind, tx: row.mint_tx },
    },
    proofs_of_trade: trades.map((t) => {
      const trade = tradeSummary(ctx, loadOrder(ctx, t.order_id));
      return {
        receipt_id: t.receipt_id,
        thesis: { token_id: row.token_id, content_hash: row.content_hash },
        trader: t.trader,
        role: t.trader === creator.near_account_id ? "creator" : "borrower",
        order: { id: t.order_id, market: t.market, side: t.side, quantity: t.quantity, authorised_at: t.authorised_at, status: t.status },
        fill: { at: t.fill_at, price: t.fill_price, quantity: t.fill_quantity, source: t.evidence_source },
        fee_paid: amount(t.fee_yocto),
        settlement: { ledger: ctx.ledger.kind, tx: t.settle_tx },
        /** Open, partially closed or closed, with the closing fills and the result calculated from them. */
        trade,
        closing_fill: trade.closing_fill,
        proven_at: t.proven_at,
      };
    }),
  };
}

// ---- internals ----

function assertCreator(ctx: Ctx, principal: Principal, insightId: string) {
  const insight = ctx.db.prepare("SELECT creator_id FROM insights WHERE id = ?").get(insightId) as
    | { creator_id: string } | undefined;
  if (!insight) throw notFound("Insight");
  if (insight.creator_id !== principal.account.id) throw forbidden("not_creator", "Only the creator can publish a new version");
}

/** Checks everything that needs no waiting, then settles the expiry, which may ask ConDex's AI. */
async function prepare(ctx: Ctx, principal: Principal, input: PublishInput): Promise<Prepared> {
  if (input.messages.length === 0) throw badRequest("no_messages", "Select at least one message to publish");
  const required = (field: string, value: string) => {
    const text = value.trim();
    if (!text) {
      throw badRequest("condition_required", `${field} is required: a thesis records its market, direction, entry and invalidation`);
    }
    return text;
  };
  const conditions: Conditions = {
    market: required("market", input.market),
    direction: input.direction,
    entry: required("entry", input.entry),
    invalidation: required("invalidation", input.invalidation),
    target: input.target?.trim() || null,
  };
  const feeYocto = parseNear(input.feeNear, "fee_near");
  const payoutAccount = input.payoutAccount ?? principal.account.near_account_id;
  assertNearAccountId(payoutAccount, "payout_account");
  const summary = input.summary ?? null;
  const expiry = await resolveExpiry(
    ctx, principal.account.id,
    { date: input.expiryDate?.trim() || null, time: input.expiryTime?.trim() || null, instant: input.expiresAt?.trim() || null },
    { title: input.title, summary, ...conditions, messages: input.messages },
  );
  return { title: input.title, summary, ...conditions, feeYocto, payoutAccount, messages: input.messages, expiry };
}

/** The stored fields the fingerprint covers. */
type Fingerprinted = Pick<VersionRow,
  "token_id" | "insight_id" | "version" | "title" | "summary" | "market" | "direction" | "entry" | "invalidation" |
  "target" | "expires_at" | "expiry_time_given" | "expiry_set_by" | "expiry_reason" | "messages">;

/**
 * The fingerprint (content_hash) of one thesis version. It covers the conditions, the expiry with who set
 * it and why, and the approved messages. It is built the same way when publishing and when re-checking a
 * stored version, and anyone who reads the thesis can rebuild the object, hash it and compare the result
 * with the token record on the ledger.
 */
function fingerprint(r: Fingerprinted): string {
  return sha256Hex(canonicalJson({
    token_id: r.token_id,
    insight_id: r.insight_id,
    version: r.version,
    title: r.title,
    summary: r.summary,
    conditions: { market: r.market, direction: r.direction, entry: r.entry, invalidation: r.invalidation, target: r.target },
    expiry: { expires_at: r.expires_at, time_given: r.expiry_time_given === 1, set_by: r.expiry_set_by, reason: r.expiry_reason },
    messages: JSON.parse(r.messages) as Message[],
  }));
}

/** Recomputes the fingerprint from what is stored and compares it with the one minted on the ledger. */
function integrity(r: VersionRow) {
  const recomputed = fingerprint(r);
  return { content_hash: r.content_hash, recomputed_hash: recomputed, matches: recomputed === r.content_hash };
}

function insertVersion(ctx: Ctx, principal: Principal, insightId: string, version: number, p: Prepared) {
  const tokenId = `${insightId}-v${version}`;
  const stored: Fingerprinted = {
    token_id: tokenId, insight_id: insightId, version, title: p.title, summary: p.summary,
    market: p.market, direction: p.direction, entry: p.entry, invalidation: p.invalidation, target: p.target,
    expires_at: p.expiry.expiresAt, expiry_time_given: p.expiry.timeGiven ? 1 : 0, expiry_set_by: p.expiry.setBy,
    expiry_reason: p.expiry.reason, messages: JSON.stringify(p.messages),
  };
  const contentHash = fingerprint(stored);
  const createdAt = nowIso();
  const { tx } = ctx.ledger.mintToken({
    tokenId,
    owner: principal.account.near_account_id,
    payoutAccount: p.payoutAccount,
    feeYocto: p.feeYocto,
    contentHash,
    issuedAt: createdAt,
    expiresAt: p.expiry.expiresAt,
    expirySetBy: p.expiry.setBy,
  });
  ctx.db.prepare(
    `INSERT INTO insight_versions (token_id, insight_id, version, creator_id, payout_account, fee_yocto, title, summary,
       market, direction, entry, invalidation, target, expires_at, expiry_time_given, expiry_set_by, expiry_reason,
       messages, content_hash, mint_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenId, insightId, version, principal.account.id, p.payoutAccount, p.feeYocto.toString(), p.title, p.summary,
    p.market, p.direction, p.entry, p.invalidation, p.target, p.expiry.expiresAt, p.expiry.timeGiven ? 1 : 0,
    p.expiry.setBy, p.expiry.reason, stored.messages, contentHash, tx, createdAt,
  );
  const row = getVersion(ctx, tokenId);
  // The creator is told when ConDex had to set the expiry, so they can publish a version with their own.
  return { ...detailView(ctx, row), ...(row.expiry_set_by === "creator" ? {} : { notice: expiryNotice(row) }) };
}

function expiryNotice(r: VersionRow): string {
  const who = r.expiry_set_by === "condex_ai" ? "ConDex's AI" : "ConDex";
  const when = `${r.expires_at.slice(0, 10)} ${r.expires_at.slice(11, 16)} UTC`;
  return `No expiry date was given, so ${who} set it to ${when}. To choose another, publish a new version with ` +
    "expiry_date (and expiry_time if the thesis depends on a time).";
}

function expiryView(r: VersionRow) {
  return {
    expires_at: r.expires_at,
    date: r.expires_at.slice(0, 10),
    /** UTC. When no time was set, this is the end of the day. */
    time: r.expires_at.slice(11, 19),
    time_given: r.expiry_time_given === 1,
    set_by: r.expiry_set_by,
    /** Why ConDex chose it. null when the creator set it. */
    reason: r.expiry_reason,
  };
}

/** Public: what was published, in which market and direction, and until when. No entry, invalidation or messages. */
function previewView(ctx: Ctx, r: VersionRow) {
  const creator = getAccount(ctx, r.creator_id);
  return {
    token_id: r.token_id,
    insight_id: r.insight_id,
    version: r.version,
    title: r.title,
    market: r.market,
    direction: r.direction,
    summary: r.summary,
    published_at: r.created_at,
    expires_at: r.expires_at,
    expired: isExpired(r),
    expiry: expiryView(r),
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

/** For the creator and connected readers: the preview plus the full conditions. */
function detailView(ctx: Ctx, r: VersionRow) {
  return {
    ...previewView(ctx, r),
    conditions: { market: r.market, direction: r.direction, entry: r.entry, invalidation: r.invalidation, target: r.target },
  };
}
