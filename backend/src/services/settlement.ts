import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, conflict, forbidden, notFound } from "../errors.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { amount, newId, nowIso } from "../util.ts";
import type { Principal } from "./accounts.ts";
import { getVersion } from "./insights.ts";
import { CLOSING_PREFIX, activeClosing, closedQuantity, ingestClosingEvent, replayClosingEvent, simulateClosing } from "./trades.ts";
import { type OrderRow, type OrderStatus, TERMINAL_STATUSES, loadOrder, orderView } from "./orders.ts";

export const EVENT_TYPES = ["accepted", "fill", "cancelled", "rejected", "expired", "status_unknown", "close"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface ExecutionEventInput {
  /** Supplied by the execution integration. Sending the same id again is a replay and changes nothing. */
  eventId: string;
  orderId: string;
  type: EventType;
  quantity?: string | null;
  price?: string | null;
  /** "simulated" or "venue:<name>". Stored on the receipt so a demo can show where the evidence came from. */
  source: string;
}

/** What ConDex did with an event. */
export type Effect =
  | "order_open"            // venue accepted the order
  | "settled"               // first confirmed fill: receipt created, creator paid once
  | "fill_same_receipt"     // later fill: recorded against the existing receipt, no new payout
  | "released"              // ended with no fills: reserved fee returned to the borrower
  | "closed_after_fill"     // cancelled/expired after a fill: fee was already settled
  | "settlement_pending"    // venue status unknown: nothing moves until the outcome is known
  | "ignored_terminal"      // order already finished: event recorded, nothing changes
  | "fill_after_release"    // fill reported after the reserve was released: needs manual review, no payout
  | "position_closed";      // closing fill for (part of) the filled quantity: recorded for the result, no payout

interface EventRow {
  id: string; order_id: string; type: EventType; quantity: string | null; price: string | null; source: string;
  effect: Effect; receipt_id: string | null; received_at: string;
}

interface ReceiptRow {
  id: string; order_id: string; token_id: string; borrower_id: string; creator_id: string; payout_account: string;
  fee_yocto: string; first_fill_event_id: string; evidence_source: string; settle_tx: string; created_at: string;
}

const SOURCE_RE = /^(simulated|venue:[a-z0-9_.-]{1,48})$/;

export function ingestEvent(ctx: Ctx, input: ExecutionEventInput) {
  if (!(EVENT_TYPES as readonly string[]).includes(input.type)) {
    throw badRequest("invalid_event_type", `type must be one of ${EVENT_TYPES.join(", ")}`);
  }
  if (!SOURCE_RE.test(input.source)) {
    throw badRequest("invalid_source", 'source must be "simulated" or "venue:<name>"');
  }
  if (!input.eventId || input.eventId.length > 128) throw badRequest("invalid_event_id", "event_id is required (max 128 chars)");

  // A closing order's events are handled by the trade-closing code.
  if (input.orderId.startsWith(CLOSING_PREFIX)) return ingestClosingEvent(ctx, input);

  return transaction(ctx.db, () => {
    if (ctx.db.prepare("SELECT 1 FROM closing_events WHERE id = ?").get(input.eventId)) {
      throw conflict("event_id_reused", `Event ${input.eventId} was already used for a different order or type`);
    }
    const existing = ctx.db.prepare("SELECT * FROM execution_events WHERE id = ?").get(input.eventId) as EventRow | undefined;
    if (existing) {
      if (existing.order_id !== input.orderId || existing.type !== input.type) {
        throw conflict("event_id_reused", `Event ${input.eventId} was already used for a different order or type`);
      }
      return result(ctx, existing, true);
    }

    const order = loadOrder(ctx, input.orderId);
    if (order.status === "awaiting_approval") {
      throw conflict("not_submitted", `Order ${order.id} is waiting for the trader's approval on NEAR and was never submitted`);
    }
    const { effect, receiptId, quantity } = apply(ctx, order, input);
    const row: EventRow = {
      id: input.eventId,
      order_id: order.id,
      type: input.type,
      quantity,
      price: input.price != null ? formatDecimal(parseDecimal(input.price, "price")) : null,
      source: input.source,
      effect,
      receipt_id: receiptId,
      received_at: nowIso(),
    };
    ctx.db.prepare(
      `INSERT INTO execution_events (id, order_id, type, quantity, price, source, effect, receipt_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.order_id, row.type, row.quantity, row.price, row.source, row.effect, row.receipt_id, row.received_at);
    return result(ctx, row, false);
  });
}

/** Re-sends a stored event exactly as received. Used to demonstrate that replays never pay twice. */
export function replayEvent(ctx: Ctx, eventId: string) {
  const closing = replayClosingEvent(ctx, eventId);
  if (closing) return closing;
  const row = ctx.db.prepare("SELECT * FROM execution_events WHERE id = ?").get(eventId) as EventRow | undefined;
  if (!row) throw notFound(`Execution event ${eventId}`);
  return ingestEvent(ctx, {
    eventId: row.id, orderId: row.order_id, type: row.type, quantity: row.quantity, price: row.price, source: row.source,
  });
}

/** Test controls for the simulated venue. Each call produces a fresh event labelled "simulated". */
export function simulate(ctx: Ctx, orderId: string, type: EventType, opts: { quantity?: string; price?: string } = {}) {
  if (orderId.startsWith(CLOSING_PREFIX)) return simulateClosing(ctx, orderId, type, opts);
  const order = loadOrder(ctx, orderId);
  if (order.venue !== "simulated") throw forbidden("not_simulated", "Only orders on the simulated venue can be driven by /v1/sim");
  let quantity = opts.quantity;
  if (type === "fill" && !quantity) {
    // Default: fill whatever is left.
    quantity = formatDecimal(parseDecimal(order.quantity, "quantity") - parseDecimal(order.filled_quantity, "filled"));
  }
  if (type === "close" && !quantity) {
    // Default: close whatever is still open.
    quantity = formatDecimal(parseDecimal(order.filled_quantity, "filled") - closedQuantity(ctx, order.id));
  }
  return ingestEvent(ctx, {
    eventId: newId("simevt"), orderId, type, quantity: quantity ?? null, price: opts.price ?? null, source: "simulated",
  });
}

export function listReceipts(ctx: Ctx, principal: Principal) {
  const rows = ctx.db.prepare(
    "SELECT * FROM receipts WHERE borrower_id = ? OR creator_id = ? ORDER BY created_at DESC",
  ).all(principal.account.id, principal.account.id) as unknown as ReceiptRow[];
  return rows.map((r) => receiptView(ctx, r));
}

/** A receipt can be read by the borrower and the creator of the trade it records, nobody else. */
export function getReceipt(ctx: Ctx, principal: Principal, receiptId: string) {
  const row = ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(receiptId) as ReceiptRow | undefined;
  if (!row || (row.borrower_id !== principal.account.id && row.creator_id !== principal.account.id)) throw notFound("Receipt");
  return receiptView(ctx, row);
}

// ---- the state machine ----

function apply(ctx: Ctx, order: OrderRow, ev: ExecutionEventInput): { effect: Effect; receiptId: string | null; quantity: string | null } {
  const terminal = TERMINAL_STATUSES.includes(order.status);
  const filled = parseDecimal(order.filled_quantity, "filled_quantity");

  switch (ev.type) {
    case "accepted": {
      if (order.status !== "submitted") return { effect: "ignored_terminal", receiptId: order.receipt_id, quantity: null };
      update(ctx, order.id, { status: "open", venue_status_known: 1 });
      return { effect: "order_open", receiptId: null, quantity: null };
    }

    case "status_unknown": {
      if (terminal) return { effect: "ignored_terminal", receiptId: order.receipt_id, quantity: null };
      update(ctx, order.id, { venue_status_known: 0 });
      return { effect: "settlement_pending", receiptId: order.receipt_id, quantity: null };
    }

    case "fill": {
      if (ev.quantity == null) throw badRequest("quantity_required", "A fill event needs quantity");
      const qty = parseDecimal(ev.quantity, "quantity", { positive: true });
      // A zero price would give the trade no entry value, and so no result.
      if (ev.price != null) parseDecimal(ev.price, "price", { positive: true });
      const qtyText = formatDecimal(qty);
      if (order.settlement_status === "released") {
        return { effect: "fill_after_release", receiptId: null, quantity: qtyText };
      }
      if (terminal) return { effect: "ignored_terminal", receiptId: order.receipt_id, quantity: qtyText };
      const total = parseDecimal(order.quantity, "quantity");
      const newFilled = filled + qty;
      if (newFilled > total) {
        throw badRequest("overfill", `Fill of ${qtyText} would exceed the order quantity ${order.quantity} (already filled ${order.filled_quantity})`);
      }
      const status: OrderStatus = newFilled === total ? "filled" : "partially_filled";
      if (order.receipt_id) {
        update(ctx, order.id, { status, filled_quantity: formatDecimal(newFilled), venue_status_known: 1 });
        return { effect: "fill_same_receipt", receiptId: order.receipt_id, quantity: qtyText };
      }
      const receiptId = createReceiptAndSettle(ctx, order, ev);
      update(ctx, order.id, {
        status, filled_quantity: formatDecimal(newFilled), venue_status_known: 1, settlement_status: "settled", receipt_id: receiptId,
      });
      return { effect: "settled", receiptId, quantity: qtyText };
    }

    case "cancelled":
    case "expired":
    case "rejected": {
      if (terminal) return { effect: "ignored_terminal", receiptId: order.receipt_id, quantity: null };
      if (filled > 0n) {
        if (ev.type === "rejected") throw conflict("reject_after_fill", "An order with fills cannot be rejected");
        update(ctx, order.id, { status: ev.type, venue_status_known: 1 });
        return { effect: "closed_after_fill", receiptId: order.receipt_id, quantity: null };
      }
      ctx.ledger.releaseFee(order.id);
      update(ctx, order.id, { status: ev.type, venue_status_known: 1, settlement_status: "released" });
      return { effect: "released", receiptId: null, quantity: null };
    }

    // Closing the position the order opened. Nothing is paid: the fee was settled on the first fill.
    // The closing fills give the trade its result (services/evaluation.ts).
    case "close": {
      if (filled === 0n) throw conflict("nothing_to_close", "This order has no fills, so there is no position to close");
      const open = filled - closedQuantity(ctx, order.id);
      if (open === 0n) throw conflict("nothing_to_close", "The position is already fully closed");
      // A closing order still waiting for fills could fill after this event and close more than is open.
      if (activeClosing(ctx, order.id)) {
        throw conflict("closing_in_progress", "A closing order for this trade is still open. Wait for it to finish or cancel it first");
      }
      if (ev.quantity == null || ev.price == null) throw badRequest("close_needs_fill", "A close event needs quantity and price");
      const qty = parseDecimal(ev.quantity, "quantity", { positive: true });
      parseDecimal(ev.price, "price", { positive: true });
      if (qty > open) {
        throw badRequest("overclose", `Close of ${formatDecimal(qty)} exceeds the open position ${formatDecimal(open)}`);
      }
      ctx.ledger.recordClose(order.id, {
        eventId: ev.eventId, quantity: formatDecimal(qty), price: formatDecimal(parseDecimal(ev.price, "price")),
        closedAt: nowIso(), source: ev.source,
      });
      return { effect: "position_closed", receiptId: order.receipt_id, quantity: formatDecimal(qty) };
    }
  }
}

function createReceiptAndSettle(ctx: Ctx, order: OrderRow, ev: ExecutionEventInput): string {
  const version = getVersion(ctx, order.token_id);
  const receiptId = newId("rcpt");
  const { tx } = ctx.ledger.settleFee(order.id, receiptId);
  ctx.db.prepare(
    `INSERT INTO receipts (id, order_id, token_id, borrower_id, creator_id, payout_account, fee_yocto,
       first_fill_event_id, evidence_source, settle_tx, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receiptId, order.id, order.token_id, order.borrower_id, version.creator_id, version.payout_account,
    order.fee_yocto, ev.eventId, ev.source, tx, nowIso(),
  );
  return receiptId;
}

function update(ctx: Ctx, orderId: string, fields: Partial<Pick<OrderRow,
  "status" | "filled_quantity" | "venue_status_known" | "settlement_status" | "receipt_id">>) {
  const entries = Object.entries(fields);
  const sets = entries.map(([k]) => `${k} = ?`).join(", ");
  ctx.db.prepare(`UPDATE orders SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as string | number), nowIso(), orderId);
}

function result(ctx: Ctx, ev: EventRow, replayed: boolean) {
  const order = loadOrder(ctx, ev.order_id);
  const receiptRow = ev.receipt_id
    ? (ctx.db.prepare("SELECT * FROM receipts WHERE id = ?").get(ev.receipt_id) as ReceiptRow | undefined)
    : undefined;
  return {
    replayed,
    event: ev,
    order: orderView(ctx, order),
    receipt: receiptRow ? receiptView(ctx, receiptRow) : null,
  };
}

function receiptView(ctx: Ctx, r: ReceiptRow) {
  return {
    id: r.id,
    order_id: r.order_id,
    token_id: r.token_id,
    borrower_id: r.borrower_id,
    creator_id: r.creator_id,
    payout_account: r.payout_account,
    fee: amount(r.fee_yocto),
    first_fill_event_id: r.first_fill_event_id,
    evidence_source: r.evidence_source,
    evidence_label: r.evidence_source === "simulated" ? "Simulated fill (not a live venue)" : `Live venue confirmation (${r.evidence_source})`,
    settlement: { ledger: ctx.ledger.kind, tx: r.settle_tx },
    created_at: r.created_at,
  };
}
