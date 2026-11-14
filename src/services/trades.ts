import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { newId, nowIso } from "../util.ts";
import { type Principal, requireScope } from "./accounts.ts";
import { type OrderRow, TERMINAL_STATUSES, type OrderStatus, loadOrder } from "./orders.ts";
import type { ExecutionEventInput } from "./settlement.ts";

/**
 * Closing a trade. A thesis trade opens with a linked order, and its proof of trade is created on the first fill.
 * The trader closes it with a closing order on the opposite side. It carries no fee and no thesis link: it only
 * brings the position back to flat. Its fills are the closing fills of the proof of trade, and from them ConDex
 * calculates the result of the trade. Closing is allowed after the thesis expired: a trade opened before the
 * expiry still records its result when it closes.
 */

export const CLOSING_PREFIX = "cls_";
const FACTOR = 10n ** 18n;

export type ClosingEffect = "closing_open" | "closing_fill" | "closing_ended" | "status_noted" | "ignored_terminal";

interface ClosingRow {
  id: string; order_id: string; borrower_id: string; side: "buy" | "sell"; quantity: string; limit_price: string | null;
  venue: string; venue_order_id: string | null; status: OrderStatus; filled_quantity: string; created_at: string; updated_at: string;
}

interface ClosingEventRow {
  id: string; closing_id: string; type: string; quantity: string | null; price: string | null; source: string;
  effect: ClosingEffect; received_at: string;
}

export const isClosingId = (id: string) => id.startsWith(CLOSING_PREFIX);

export interface CloseInput {
  /** How much of the open position to close. Defaults to all of it. */
  quantity?: string | null;
  limitPrice?: string | null;
}

/** Submits a closing order for the borrower's open position. */
export function closeTrade(ctx: Ctx, principal: Principal, orderId: string, input: CloseInput = {}) {
  requireScope(principal, "trade");
  const closing = transaction(ctx.db, () => {
    const order = loadOrder(ctx, orderId);
    if (order.borrower_id !== principal.account.id) throw notFound("Order");
    if (!order.receipt_id) {
      throw conflict("trade_not_open", "This order has no confirmed fill yet, so there is no trade to close");
    }
    if (activeClosing(ctx, order.id)) {
      throw conflict("closing_in_progress", "A closing order for this trade is still open. Wait for it to finish or cancel it first");
    }
    const open = openQuantity(ctx, order);
    if (open <= 0n) throw conflict("already_closed", "This trade is already fully closed");
    const quantity = input.quantity != null ? parseDecimal(input.quantity, "quantity", { positive: true }) : open;
    if (quantity > open) {
      throw badRequest("quantity_exceeds_open", `Only ${formatDecimal(open)} of this trade is open, so ${formatDecimal(quantity)} cannot be closed`);
    }
    const limitPrice = input.limitPrice != null ? formatDecimal(parseDecimal(input.limitPrice, "limit_price", { positive: true })) : null;
    const now = nowIso();
    const row: ClosingRow = {
      id: newId("cls"),
      order_id: order.id,
      borrower_id: order.borrower_id,
      side: order.side === "buy" ? "sell" : "buy",
      quantity: formatDecimal(quantity),
      limit_price: limitPrice,
      venue: ctx.venue.name,
      venue_order_id: null,
      status: "submitted",
      filled_quantity: "0",
      created_at: now,
      updated_at: now,
    };
    ctx.db.prepare(
      `INSERT INTO closing_orders (id, order_id, borrower_id, side, quantity, limit_price, venue, status, filled_quantity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.order_id, row.borrower_id, row.side, row.quantity, row.limit_price, row.venue, row.status, row.filled_quantity, now, now);
    return { row, order };
  });

  // Submit after the row is committed. The venue's answer arrives as an execution event, like for any order.
  const submitted = ctx.venue.submit({
    orderId: closing.row.id, market: closing.order.market, side: closing.row.side, quantity: closing.row.quantity,
    limitPrice: closing.row.limit_price,
  });
  ctx.db.prepare("UPDATE closing_orders SET venue_order_id = ?, updated_at = ? WHERE id = ?").run(submitted.venueOrderId, nowIso(), closing.row.id);
  ingestClosingEvent(ctx, {
    eventId: newId(ctx.venue.name === "simulated" ? "simevt" : "evt"),
    orderId: closing.row.id,
    type: submitted.accepted ? "accepted" : "rejected",
    source: ctx.venue.name,
  });
  return closingView(ctx, loadClosing(ctx, closing.row.id));
}

/** Applies a venue event to a closing order. Replays of the same event id change nothing. */
export function ingestClosingEvent(ctx: Ctx, input: ExecutionEventInput) {
  return transaction(ctx.db, () => {
    if (ctx.db.prepare("SELECT 1 FROM execution_events WHERE id = ?").get(input.eventId)) {
      throw conflict("event_id_reused", `Event ${input.eventId} was already used for a different order or type`);
    }
    const existing = ctx.db.prepare("SELECT * FROM closing_events WHERE id = ?").get(input.eventId) as ClosingEventRow | undefined;
    if (existing) {
      if (existing.closing_id !== input.orderId || existing.type !== input.type) {
        throw conflict("event_id_reused", `Event ${input.eventId} was already used for a different order or type`);
      }
      return eventResult(ctx, existing, true);
    }
    const closing = loadClosing(ctx, input.orderId);
    const { effect, quantity } = applyClosing(ctx, closing, input);
    const row: ClosingEventRow = {
      id: input.eventId,
      closing_id: closing.id,
      type: input.type,
      quantity,
      price: input.price != null ? formatDecimal(parseDecimal(input.price, "price")) : null,
      source: input.source,
      effect,
      received_at: nowIso(),
    };
    ctx.db.prepare(
      `INSERT INTO closing_events (id, closing_id, type, quantity, price, source, effect, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.id, row.closing_id, row.type, row.quantity, row.price, row.source, row.effect, row.received_at);
    return eventResult(ctx, row, false);
  });
}

/** Re-sends a stored closing event exactly as received. Returns undefined when the id is not a closing event. */
export function replayClosingEvent(ctx: Ctx, eventId: string) {
  const row = ctx.db.prepare("SELECT * FROM closing_events WHERE id = ?").get(eventId) as ClosingEventRow | undefined;
  if (!row) return undefined;
  return ingestClosingEvent(ctx, {
    eventId: row.id, orderId: row.closing_id, type: row.type as ExecutionEventInput["type"], quantity: row.quantity, price: row.price, source: row.source,
  });
}

/** Test controls for the simulated venue, for a closing order. */
export function simulateClosing(ctx: Ctx, closingId: string, type: ExecutionEventInput["type"], opts: { quantity?: string; price?: string } = {}) {
  const closing = loadClosing(ctx, closingId);
  let quantity = opts.quantity;
  if (type === "fill" && !quantity) {
    quantity = formatDecimal(parseDecimal(closing.quantity, "quantity") - parseDecimal(closing.filled_quantity, "filled"));
  }
  return ingestClosingEvent(ctx, {
    eventId: newId("simevt"), orderId: closingId, type, quantity: quantity ?? null, price: opts.price ?? null, source: "simulated",
  });
}

export function getClosingOrder(ctx: Ctx, principal: Principal, closingId: string) {
  const row = loadClosing(ctx, closingId);
  if (row.borrower_id !== principal.account.id) throw notFound("Closing order");
  return closingView(ctx, row);
}

export function listClosingOrders(ctx: Ctx, orderId: string) {
  const rows = ctx.db.prepare("SELECT * FROM closing_orders WHERE order_id = ? ORDER BY created_at, rowid").all(orderId) as unknown as ClosingRow[];
  return rows.map((r) => closingView(ctx, r));
}

// ---- the state machine for a closing order ----

function applyClosing(ctx: Ctx, c: ClosingRow, ev: ExecutionEventInput): { effect: ClosingEffect; quantity: string | null } {
  const terminal = TERMINAL_STATUSES.includes(c.status);
  const filled = parseDecimal(c.filled_quantity, "filled_quantity");
  switch (ev.type) {
    case "accepted":
      if (c.status !== "submitted") return { effect: "ignored_terminal", quantity: null };
      updateClosing(ctx, c.id, { status: "open" });
      return { effect: "closing_open", quantity: null };

    case "status_unknown":
      return { effect: terminal ? "ignored_terminal" : "status_noted", quantity: null };

    case "fill": {
      if (ev.quantity == null) throw badRequest("quantity_required", "A fill event needs quantity");
      if (ev.price == null) throw badRequest("price_required", "A closing fill needs a price: the result of the trade is calculated from it");
      const qty = parseDecimal(ev.quantity, "quantity", { positive: true });
      parseDecimal(ev.price, "price", { positive: true });
      const qtyText = formatDecimal(qty);
      if (terminal) return { effect: "ignored_terminal", quantity: qtyText };
      const total = parseDecimal(c.quantity, "quantity");
      const newFilled = filled + qty;
      if (newFilled > total) {
        throw badRequest("overfill", `Fill of ${qtyText} would exceed the closing order quantity ${c.quantity} (already filled ${c.filled_quantity})`);
      }
      updateClosing(ctx, c.id, { status: newFilled === total ? "filled" : "partially_filled", filled_quantity: formatDecimal(newFilled) });
      return { effect: "closing_fill", quantity: qtyText };
    }

    case "cancelled":
    case "expired":
    case "rejected": {
      if (terminal) return { effect: "ignored_terminal", quantity: null };
      if (filled > 0n && ev.type === "rejected") throw conflict("reject_after_fill", "A closing order with fills cannot be rejected");
      updateClosing(ctx, c.id, { status: ev.type });
      return { effect: "closing_ended", quantity: null };
    }
  }
}

function updateClosing(ctx: Ctx, id: string, fields: Partial<Pick<ClosingRow, "status" | "filled_quantity">>) {
  const entries = Object.entries(fields);
  ctx.db.prepare(`UPDATE closing_orders SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, v]) => v as string), nowIso(), id);
}

function loadClosing(ctx: Ctx, id: string): ClosingRow {
  const row = ctx.db.prepare("SELECT * FROM closing_orders WHERE id = ?").get(id) as ClosingRow | undefined;
  if (!row) throw notFound("Closing order");
  return row;
}

function activeClosing(ctx: Ctx, orderId: string): boolean {
  const rows = ctx.db.prepare("SELECT status FROM closing_orders WHERE order_id = ?").all(orderId) as Array<{ status: OrderStatus }>;
  return rows.some((r) => !TERMINAL_STATUSES.includes(r.status));
}

/** Confirmed opening fills minus confirmed closing fills. */
function openQuantity(ctx: Ctx, order: OrderRow): bigint {
  return parseDecimal(order.filled_quantity, "filled_quantity") - closedQuantity(ctx, order.id);
}

function closedQuantity(ctx: Ctx, orderId: string): bigint {
  const rows = ctx.db.prepare(
    "SELECT filled_quantity FROM closing_orders WHERE order_id = ?",
  ).all(orderId) as Array<{ filled_quantity: string }>;
  return rows.reduce((sum, r) => sum + parseDecimal(r.filled_quantity, "filled_quantity"), 0n);
}

// ---- views ----

function closingView(ctx: Ctx, r: ClosingRow) {
  const fills = closingFills(ctx, r.id);
  return {
    id: r.id,
    order_id: r.order_id,
    side: r.side,
    quantity: r.quantity,
    limit_price: r.limit_price,
    filled_quantity: r.filled_quantity,
    status: r.status,
    venue: { name: r.venue, order_id: r.venue_order_id },
    fills,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function closingFills(ctx: Ctx, closingId: string) {
  return (ctx.db.prepare(
    "SELECT id, quantity, price, source, received_at FROM closing_events WHERE closing_id = ? AND type = 'fill' AND effect = 'closing_fill' ORDER BY received_at, rowid",
  ).all(closingId) as unknown as Array<{ id: string; quantity: string; price: string; source: string; received_at: string }>)
    .map((f) => ({ event_id: f.id, at: f.received_at, price: f.price, quantity: f.quantity, source: f.source }));
}

function eventResult(ctx: Ctx, ev: ClosingEventRow, replayed: boolean) {
  const closing = loadClosing(ctx, ev.closing_id);
  return {
    replayed,
    event: ev,
    closing_order: closingView(ctx, closing),
    trade: tradeSummary(ctx, loadOrder(ctx, closing.order_id)),
  };
}

/**
 * Where a trade stands and, once any of it is closed, what it returned. Calculated only from confirmed
 * fills: the opening fills of the linked order and the fills of its closing orders.
 *
 * The result covers the closed quantity. Entry is the average price of the opening fills, exit the average
 * price of the closing fills. A buy opens a long (profit when the price rises), a sell opens a short.
 * The result is in the market's quote currency and excludes the ConDex usage fee, which is paid in NEAR.
 */
export function tradeSummary(ctx: Ctx, order: OrderRow) {
  const openedQty = parseDecimal(order.filled_quantity, "filled_quantity");
  const closings = ctx.db.prepare("SELECT id FROM closing_orders WHERE order_id = ? ORDER BY created_at, rowid").all(order.id) as Array<{ id: string }>;
  const closingFillList = closings.flatMap((c) => closingFills(ctx, c.id)).sort((a, b) => a.at.localeCompare(b.at));
  const closedQty = closingFillList.reduce((sum, f) => sum + parseDecimal(f.quantity, "quantity"), 0n);

  const openingFills = (ctx.db.prepare(
    "SELECT quantity, price FROM execution_events WHERE order_id = ? AND type = 'fill' AND effect IN ('settled', 'fill_same_receipt') ORDER BY received_at, rowid",
  ).all(order.id) as Array<{ quantity: string; price: string | null }>);

  // Closed means flat: everything that was filled is closed, and no more fills can arrive on the opening order.
  const status = closedQty === 0n ? "open"
    : closedQty === openedQty && TERMINAL_STATUSES.includes(order.status) ? "closed"
      : "partially_closed";

  return {
    status,
    direction: order.side === "buy" ? "long" : "short",
    opened_quantity: order.filled_quantity,
    closed_quantity: formatDecimal(closedQty),
    open_quantity: formatDecimal(openedQty - closedQty),
    closing_fills: closingFillList,
    /** The fill that brought the trade back to flat. Null while any of it is still open. */
    closing_fill: status === "closed" ? closingFillList[closingFillList.length - 1] ?? null : null,
    result: closedQty > 0n ? result(order, openingFills, closingFillList, closedQty) : null,
  };
}

function result(
  order: OrderRow,
  opening: Array<{ quantity: string; price: string | null }>,
  closing: Array<{ quantity: string; price: string }>,
  closedQty: bigint,
) {
  if (opening.some((f) => f.price === null)) {
    return { available: false as const, reason: "An opening fill has no price, so the entry price is unknown" };
  }
  const entry = vwap(opening.map((f) => ({ quantity: f.quantity, price: f.price as string })));
  const exit = vwap(closing);
  const sign = order.side === "buy" ? 1n : -1n;
  const pnl = sign * (exit - entry) * closedQty / FACTOR;
  const notional = entry * closedQty / FACTOR;
  const returnPct = notional === 0n ? 0n : pnl * 100n * FACTOR / notional;
  return {
    available: true as const,
    entry_price: formatDecimal(entry),
    exit_price: formatDecimal(exit),
    quantity: formatDecimal(closedQty),
    /** Profit or loss on the closed quantity, in the market's quote currency, before the ConDex usage fee. */
    pnl: signed(pnl),
    return_pct: signed(returnPct),
    outcome: pnl > 0n ? "win" as const : pnl < 0n ? "loss" as const : "flat" as const,
  };
}

/** Average price weighted by quantity, as a scaled integer. */
function vwap(fills: Array<{ quantity: string; price: string }>): bigint {
  let notional = 0n;
  let quantity = 0n;
  for (const f of fills) {
    const q = parseDecimal(f.quantity, "quantity");
    notional += q * parseDecimal(f.price, "price");
    quantity += q;
  }
  return quantity === 0n ? 0n : notional / quantity;
}

/** Signed decimal text, rounded to 8 places. */
function signed(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const unit = 10n ** 10n;
  const rounded = ((abs + unit / 2n) / unit) * unit;
  const text = formatDecimal(rounded);
  return negative && rounded !== 0n ? `-${text}` : text;
}
