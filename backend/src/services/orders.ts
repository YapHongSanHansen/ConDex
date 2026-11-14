import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { amount, newId, nowIso, nowMs } from "../util.ts";
import { type Principal, getAccount, requireScope } from "./accounts.ts";
import { type Direction, type VersionRow, getVersion, isExpired } from "./insights.ts";
import { orderHash } from "../near/chain.ts";
import { ingestEvent } from "./settlement.ts";
import { listClosingOrders, tradeSummary } from "./trades.ts";

/** awaiting_approval: on NEAR, linked and checked, but the trader has not yet approved the fee on chain. */
export type OrderStatus =
  | "awaiting_approval" | "submitted" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected" | "expired";
export type SettlementStatus = "pending" | "settled" | "released";

export interface OrderRow {
  id: string; borrower_id: string; key_id: string; token_id: string; quote_id: string; market: string;
  side: "buy" | "sell"; quantity: string; limit_price: string | null; fee_yocto: string; venue: string;
  venue_order_id: string | null; status: OrderStatus; venue_status_known: number; filled_quantity: string;
  settlement_status: SettlementStatus; receipt_id: string | null; created_at: string; updated_at: string;
}

interface QuoteRow {
  id: string; token_id: string; borrower_id: string; fee_yocto: string; expires_at: string;
  order_id: string | null; created_at: string;
}

export const TERMINAL_STATUSES: OrderStatus[] = ["filled", "cancelled", "rejected", "expired"];

/** The side that opens a trade in the direction of the thesis. */
export const OPENING_SIDE: Record<Direction, "buy" | "sell"> = { long: "buy", short: "sell" };

/** Step 1 of a linked trade: fix the fee for this insight version so the borrower can see it before authorising. */
export function createQuote(ctx: Ctx, principal: Principal, tokenId: string) {
  requireScope(principal, "trade");
  const version = getVersion(ctx, tokenId);
  assertNotSelfLink(ctx, principal, version.creator_id, version.payout_account);
  assertNotExpired(version);
  const quote: QuoteRow = {
    id: newId("quote"),
    token_id: tokenId,
    borrower_id: principal.account.id,
    fee_yocto: version.fee_yocto,
    expires_at: new Date(nowMs() + ctx.config.quoteTtlSeconds * 1000).toISOString(),
    order_id: null,
    created_at: nowIso(),
  };
  ctx.db.prepare("INSERT INTO quotes (id, token_id, borrower_id, fee_yocto, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(quote.id, quote.token_id, quote.borrower_id, quote.fee_yocto, quote.expires_at, quote.created_at);
  return {
    quote_id: quote.id,
    token_id: tokenId,
    fee: amount(quote.fee_yocto),
    fee_rule: "Charged once, on this order's first confirmed fill. Released if the order ends with no fills.",
    payout_account: version.payout_account,
    content_hash: version.content_hash,
    expires_at: quote.expires_at,
  };
}

export interface PlaceOrderInput {
  quoteId: string;
  side: "buy" | "sell";
  quantity: string;
  /** Optional. When given it must be the market of the thesis. */
  market?: string | null;
  limitPrice?: string | null;
  /** Must be true: the borrower explicitly authorises reserving the quoted fee. */
  authoriseFee: boolean;
}

/**
 * Step 2: check the order against the thesis, reserve the quoted fee on the ledger, then submit the
 * order to the execution venue. An order that does not match the thesis is refused before anything is reserved.
 */
export function placeOrder(ctx: Ctx, principal: Principal, input: PlaceOrderInput) {
  requireScope(principal, "trade");
  if (input.authoriseFee !== true) {
    throw badRequest("fee_not_authorised", "Set authorise_fee to true to reserve the quoted fee for this order");
  }
  const quantity = parseDecimal(input.quantity, "quantity", { positive: true });
  const limitPrice = input.limitPrice != null ? formatDecimal(parseDecimal(input.limitPrice, "limit_price", { positive: true })) : null;

  const order = transaction(ctx.db, () => {
    const quote = ctx.db.prepare("SELECT * FROM quotes WHERE id = ?").get(input.quoteId) as QuoteRow | undefined;
    if (!quote || quote.borrower_id !== principal.account.id) throw notFound("Quote");
    if (quote.order_id) throw conflict("quote_used", `Quote ${quote.id} was already used by order ${quote.order_id}`);
    if (quote.expires_at <= nowIso()) throw conflict("quote_expired", "This quote has expired. Request a new one.");

    const version = getVersion(ctx, quote.token_id);
    // One clock reading: the time checked against the expiry is the time recorded on the order.
    const now = nowIso();
    assertMatchesThesis(version, input, now);

    const row: OrderRow = {
      id: newId("ord"),
      borrower_id: principal.account.id,
      key_id: principal.keyId,
      token_id: version.token_id,
      quote_id: quote.id,
      market: version.market,
      side: input.side,
      quantity: formatDecimal(quantity),
      limit_price: limitPrice,
      fee_yocto: quote.fee_yocto,
      venue: ctx.venue.name,
      venue_order_id: null,
      // On NEAR, the order waits for the trader's own reserve_fee before it is submitted (confirmApproval).
      status: ctx.chain ? "awaiting_approval" : "submitted",
      venue_status_known: 1,
      filled_quantity: "0",
      settlement_status: "pending",
      receipt_id: null,
      created_at: now,
      updated_at: now,
    };
    ctx.db.prepare(
      `INSERT INTO orders (id, borrower_id, key_id, token_id, quote_id, market, side, quantity, limit_price, fee_yocto,
         venue, status, filled_quantity, settlement_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id, row.borrower_id, row.key_id, row.token_id, row.quote_id, row.market, row.side, row.quantity,
      row.limit_price, row.fee_yocto, row.venue, row.status, row.filled_quantity, row.settlement_status,
      row.created_at, row.updated_at,
    );
    if (!ctx.chain) {
      ctx.ledger.reserveFee({
        orderId: row.id,
        tokenId: row.token_id,
        payer: principal.account.near_account_id,
        payee: version.payout_account,
        amountYocto: BigInt(row.fee_yocto),
      });
    }
    ctx.db.prepare("UPDATE quotes SET order_id = ? WHERE id = ?").run(row.id, quote.id);
    return row;
  });

  if (ctx.chain) return getOrder(ctx, principal, order.id);
  return submitOrder(ctx, principal, order);
}

/**
 * On NEAR: checks that the trader approved this exact order on the contract (reserve_fee from their own
 * account), records that reserve, then submits the order. Calling it again after that returns the order.
 */
export async function confirmApproval(ctx: Ctx, principal: Principal, orderId: string) {
  requireScope(principal, "trade");
  const order = loadOrder(ctx, orderId);
  if (order.borrower_id !== principal.account.id) throw notFound("Order");
  if (!ctx.chain) throw conflict("not_on_chain", "Orders are approved on NEAR only when ConDex runs with CONDEX_LEDGER=near");
  if (order.status !== "awaiting_approval") return getOrder(ctx, principal, order.id);

  const reserve = await ctx.chain.reserveOf(order.id);
  if (!reserve) {
    throw conflict("approval_missing", `No approval for order ${order.id} on ${ctx.chain.client.contractId} yet. Call reserve_fee with the args in "approval" first`);
  }
  const expected = approvalOf(ctx, order).args;
  const wrong = [
    reserve.payer !== principal.account.near_account_id && `payer is ${reserve.payer}, not ${principal.account.near_account_id}`,
    reserve.token_id !== order.token_id && `token is ${reserve.token_id}, not ${order.token_id}`,
    reserve.amount !== order.fee_yocto && `fee is ${reserve.amount} yoctoNEAR, not ${order.fee_yocto}`,
    reserve.order_hash !== expected.order_hash && "the approved order is not this one (order_hash differs)",
    reserve.status !== "reserved" && `the reserve is already ${reserve.status}`,
  ].filter(Boolean);
  if (wrong.length > 0) throw conflict("approval_mismatch", `The approval on NEAR does not match this order: ${wrong.join("; ")}`);

  const version = getVersion(ctx, order.token_id);
  const confirmed = transaction(ctx.db, () => {
    const fresh = loadOrder(ctx, order.id);
    if (fresh.status !== "awaiting_approval") return null; // confirmed by a concurrent call
    ctx.chain!.ledger.mirrorReserve({
      orderId: order.id, tokenId: order.token_id, payer: reserve.payer, payee: version.payout_account, amountYocto: BigInt(reserve.amount),
    });
    ctx.db.prepare("UPDATE orders SET status = 'submitted', updated_at = ? WHERE id = ?").run(nowIso(), order.id);
    return loadOrder(ctx, order.id);
  });
  return confirmed ? submitOrder(ctx, principal, confirmed) : getOrder(ctx, principal, order.id);
}

/** The reserve_fee call the trader signs on NEAR to approve this order and its fee. */
function approvalOf(ctx: Ctx, r: OrderRow) {
  return {
    contract: ctx.chain!.client.contractId,
    method: "reserve_fee",
    args: {
      order_id: r.id, token_id: r.token_id, fee: r.fee_yocto,
      order_hash: orderHash({ orderId: r.id, tokenId: r.token_id, market: r.market, side: r.side, quantity: r.quantity }),
    },
    then: `POST /v1/orders/${r.id}/confirm-approval`,
  };
}

/** Submits an order whose fee is reserved. The venue's answer arrives as an execution event. */
function submitOrder(ctx: Ctx, principal: Principal, order: OrderRow) {
  const submitted = ctx.venue.submit({
    orderId: order.id, market: order.market, side: order.side, quantity: order.quantity, limitPrice: order.limit_price,
  });
  ctx.db.prepare("UPDATE orders SET venue_order_id = ?, updated_at = ? WHERE id = ?").run(submitted.venueOrderId, nowIso(), order.id);
  ingestEvent(ctx, {
    eventId: newId(ctx.venue.name === "simulated" ? "simevt" : "evt"),
    orderId: order.id,
    type: submitted.accepted ? "accepted" : "rejected",
    source: ctx.venue.name,
  });
  return getOrder(ctx, principal, order.id);
}

export function getOrder(ctx: Ctx, principal: Principal, orderId: string) {
  const row = loadOrder(ctx, orderId);
  if (row.borrower_id !== principal.account.id) throw notFound("Order");
  return orderView(ctx, row);
}

export function listOrders(ctx: Ctx, principal: Principal) {
  const rows = ctx.db.prepare("SELECT * FROM orders WHERE borrower_id = ? ORDER BY created_at DESC").all(principal.account.id) as unknown as OrderRow[];
  return rows.map((r) => orderView(ctx, r));
}

export function loadOrder(ctx: Ctx, orderId: string): OrderRow {
  const row = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!row) throw notFound("Order");
  return row;
}

export function orderView(ctx: Ctx, r: OrderRow) {
  const reserve = ctx.ledger.getReserve(r.id);
  const version = getVersion(ctx, r.token_id);
  const events = ctx.db.prepare(
    "SELECT id, type, quantity, price, source, effect, receipt_id, received_at FROM execution_events WHERE order_id = ? ORDER BY received_at, rowid",
  ).all(r.id);
  return {
    id: r.id,
    token_id: r.token_id,
    quote_id: r.quote_id,
    market: r.market,
    side: r.side,
    quantity: r.quantity,
    limit_price: r.limit_price,
    filled_quantity: r.filled_quantity,
    status: r.status,
    venue: { name: r.venue, order_id: r.venue_order_id, status_known: r.venue_status_known === 1 },
    /** What was checked against the thesis when the order was authorised. An order that failed a check was never linked. */
    thesis_match: {
      token_id: r.token_id,
      content_hash: version.content_hash,
      market: version.market,
      direction: version.direction,
      opens_with: r.side,
      thesis_expires_at: version.expires_at,
      authorised_at: r.created_at,
      checked: ["market", "direction", "authorised_before_expiry"],
    },
    fee: amount(r.fee_yocto),
    /** On NEAR, until the trader approves: the contract call to sign. */
    approval: r.status === "awaiting_approval" && ctx.chain ? approvalOf(ctx, r) : null,
    settlement: {
      status: r.settlement_status,
      receipt_id: r.receipt_id,
      ledger: ctx.ledger.kind,
      reserve: reserve
        ? { status: reserve.status, payer: reserve.payer, payee: reserve.payee, reserve_tx: reserve.reserveTx, final_tx: reserve.finalTx }
        : null,
    },
    /** Where the trade stands and, once any of it is closed, what it returned. Null until the first fill. */
    trade: r.receipt_id ? tradeSummary(ctx, r) : null,
    closing_orders: listClosingOrders(ctx, r.id),
    execution_events: events,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function assertNotExpired(version: VersionRow, at: string = nowIso()) {
  if (isExpired(version, at)) {
    throw conflict("insight_expired", `Insight ${version.token_id} expired at ${version.expires_at}, so no new trade can be linked to it`);
  }
}

/**
 * A trade counts as a trade of the thesis only if it is in the thesis's market, opens in its direction
 * and is authorised before it expires. Entry and invalidation are the creator's own words, so they are
 * not judged here.
 */
function assertMatchesThesis(version: VersionRow, input: PlaceOrderInput, authorisedAt: string) {
  assertNotExpired(version, authorisedAt);
  const market = input.market?.trim();
  if (market && market.toUpperCase() !== version.market.toUpperCase()) {
    throw conflict("market_mismatch", `This thesis is about ${version.market}, so an order in ${market} cannot be linked to it`);
  }
  const opens = OPENING_SIDE[version.direction];
  if (input.side !== opens) {
    throw conflict(
      "direction_mismatch",
      `This thesis is ${version.direction}, so a linked order must open with a ${opens}, not a ${input.side}`,
    );
  }
}

/** The creator earns from other traders' orders, so an order may not link to the borrower's own insight. */
function assertNotSelfLink(ctx: Ctx, principal: Principal, creatorId: string, payoutAccount: string) {
  const creator = getAccount(ctx, creatorId);
  if (creatorId === principal.account.id || payoutAccount === principal.account.near_account_id || creator.near_account_id === principal.account.near_account_id) {
    throw forbidden("self_link", "An order cannot be linked to your own insight");
  }
}
