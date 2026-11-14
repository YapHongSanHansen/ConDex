import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import type { PricePoint } from "../market/marketData.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { nowIso } from "../util.ts";
import type { VersionRow } from "./insights.ts";
import { TERMINAL_STATUSES, loadOrder } from "./orders.ts";
import { closingFillsOf } from "./trades.ts";

// Step 5 of the flow: after the deadline, ConDex evaluates the thesis against market data and records
// whether its stated conditions were met. Closed trades give each thesis its verified results, and both
// add up to the creator's score. Nothing here is entered by hand.

export type Outcome =
  | "target_hit"          // the target price was reached before the invalidation price
  | "invalidated"         // the invalidation price was reached first
  | "not_triggered"       // the entry price was never reached, so the thesis was never in play
  | "target_missed"       // entered, but neither the target nor the invalidation was reached by the deadline
  | "in_direction"        // no target price: at the deadline the price had moved in the thesis's direction
  | "against_direction"   // no target price: at the deadline it had moved the other way, or not at all
  | "already_reached"     // the target or invalidation was already passed when the thesis was published
  | "no_data";            // the market data feed had no price for this market

const OUTCOME_TEXT: Record<Outcome, string> = {
  target_hit: "The target price was reached before the invalidation price.",
  invalidated: "The invalidation price was reached before the target price.",
  not_triggered: "The entry price was never reached before the deadline.",
  target_missed: "The thesis was entered, but the target price was not reached by the deadline.",
  in_direction: "No target price was set. At the deadline the price had moved in the thesis's direction.",
  against_direction: "No target price was set. At the deadline the price had not moved in the thesis's direction.",
  already_reached: "The price was already past the target or invalidation when the thesis was published, so it is not judged.",
  no_data: "The market data feed had no price for this market, so the thesis could not be evaluated.",
};

/** The evaluation of one thesis version, recorded once and never changed. */
export interface EvaluationRow {
  token_id: string; outcome: Outcome; conditions_met: number | null; reference_price: string | null;
  final_price: string | null; entered_at: string | null; target_hit_at: string | null; invalidated_at: string | null;
  prices_used: number; source: string; deadline: string; evaluated_at: string; evaluation_tx: string | null;
}

/**
 * Returns the evaluation of a thesis, recording it the first time it is asked for after the deadline.
 * Before the deadline there is none (null), because the price can still reach any level.
 */
export function evaluateThesis(ctx: Ctx, row: VersionRow): EvaluationRow | null {
  const deadline = row.evaluation_deadline;
  if (nowIso() < deadline) return null;
  const stored = ctx.db.prepare("SELECT * FROM thesis_evaluations WHERE token_id = ?").get(row.token_id) as EvaluationRow | undefined;
  if (stored) return stored;

  const ev = { token_id: row.token_id, ...judge(row, ctx.market.priceAt(row.market, row.created_at),
    ctx.market.between(row.market, row.created_at, deadline)), source: ctx.market.name, deadline, evaluated_at: nowIso() };
  transaction(ctx.db, () => {
    const inserted = ctx.db.prepare(
      `INSERT OR IGNORE INTO thesis_evaluations (token_id, outcome, conditions_met, reference_price, final_price, entered_at,
         target_hit_at, invalidated_at, prices_used, source, deadline, evaluated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ev.token_id, ev.outcome, ev.conditions_met, ev.reference_price, ev.final_price, ev.entered_at, ev.target_hit_at,
      ev.invalidated_at, ev.prices_used, ev.source, ev.deadline, ev.evaluated_at);
    if (inserted.changes !== 1) return;
    // The first time only: record it on the thesis token too, so the evaluation is part of the token's history.
    const { tx } = ctx.ledger.recordEvaluation(ev.token_id, {
      outcome: ev.outcome, conditionsMet: ev.conditions_met === null ? null : ev.conditions_met === 1,
      referencePrice: ev.reference_price, finalPrice: ev.final_price, enteredAt: ev.entered_at, targetHitAt: ev.target_hit_at,
      invalidatedAt: ev.invalidated_at, pricesUsed: ev.prices_used, source: ev.source,
    });
    ctx.db.prepare("UPDATE thesis_evaluations SET evaluation_tx = ? WHERE token_id = ?").run(tx, ev.token_id);
  });
  return ctx.db.prepare("SELECT * FROM thesis_evaluations WHERE token_id = ?").get(row.token_id) as unknown as EvaluationRow;
}

/**
 * Walks the prices after publishing up to the deadline. The reference (the last price at publish) is only the
 * starting point: nothing from before publishing can hit a level. The invalidation counts from the start; the
 * target counts only once the thesis is entered (at its entry price, or at publish when it has none).
 */
function judge(row: VersionRow, reference: PricePoint | null, later: PricePoint[]) {
  const base = {
    reference_price: reference?.price ?? null, final_price: (later.at(-1) ?? reference)?.price ?? null,
    entered_at: null as string | null, target_hit_at: null as string | null, invalidated_at: null as string | null,
    prices_used: later.length + (reference ? 1 : 0),
  };
  const result = (outcome: Outcome) => ({
    ...base, outcome,
    conditions_met: outcome === "no_data" || outcome === "not_triggered" || outcome === "already_reached" ? null
      : outcome === "target_hit" || outcome === "in_direction" ? 1 : 0,
  });
  if (!reference && later.length === 0) return result("no_data");

  const long = row.direction === "long";
  const level = (p: string | null) => (p === null ? null : parseDecimal(p, "level"));
  const entry = level(row.entry_price);
  const invalidation = level(row.invalidation_price);
  const target = level(row.target_price);
  // "Beyond" a level means past it in the direction the price must move: up for a long, down for a short.
  const reached = (price: bigint, lvl: bigint, inFavour: boolean) => (long === inFavour ? price >= lvl : price <= lvl);

  // The price the thesis was entered at: the baseline for a thesis without a target.
  let enteredPrice: bigint | null = null;
  if (reference) {
    const atPublish = parseDecimal(reference.price, "price");
    if ((target !== null && reached(atPublish, target, true)) || (invalidation !== null && reached(atPublish, invalidation, false))) {
      return result("already_reached");
    }
    // An entry already passed at publish (or no entry) means the thesis was in play from the moment it was published.
    if (entry === null || reached(atPublish, entry, true)) {
      enteredPrice = atPublish;
      base.entered_at = row.created_at;
    }
  }
  for (const p of later) {
    const price = parseDecimal(p.price, "price");
    if (enteredPrice === null && (entry === null || reached(price, entry, true))) {
      enteredPrice = price;
      base.entered_at = p.at;
    }
    if (invalidation !== null && reached(price, invalidation, false)) {
      base.invalidated_at = p.at;
      return result("invalidated");
    }
    if (enteredPrice !== null && target !== null && reached(price, target, true)) {
      base.target_hit_at = p.at;
      return result("target_hit");
    }
  }
  if (enteredPrice === null) return result("not_triggered");
  if (target !== null) return result("target_missed");
  const final = parseDecimal(base.final_price!, "price");
  return result((long ? final > enteredPrice : final < enteredPrice) ? "in_direction" : "against_direction");
}

/** Public view of an evaluation. The price levels themselves stay private with the conditions. */
export function evaluationView(ctx: Ctx, row: VersionRow, ev: EvaluationRow | null) {
  if (!ev) return { status: "pending" as const, deadline: row.evaluation_deadline, source: ctx.market.name };
  return {
    status: "evaluated" as const,
    outcome: ev.outcome,
    conditions_met: ev.conditions_met === null ? null : ev.conditions_met === 1,
    explanation: OUTCOME_TEXT[ev.outcome],
    reference_price: ev.reference_price,
    final_price: ev.final_price,
    entered_at: ev.entered_at,
    target_hit_at: ev.target_hit_at,
    invalidated_at: ev.invalidated_at,
    prices_used: ev.prices_used,
    source: ev.source,
    deadline: ev.deadline,
    evaluated_at: ev.evaluated_at,
    /** Where it is recorded on the thesis token: "pending:<id>" until the call is sent on NEAR. */
    recorded: { ledger: ctx.ledger.kind, tx: ev.evaluation_tx },
  };
}

/** Share of evaluated theses whose conditions were met. Theses that could not be judged are counted apart. */
export function accuracy(evaluations: Array<EvaluationRow | null>) {
  const judged = evaluations.filter((e): e is EvaluationRow => e !== null && e.conditions_met !== null);
  const met = judged.filter((e) => e.conditions_met === 1).length;
  return {
    evaluated: judged.length,
    met,
    accuracy_pct: judged.length ? round2((met / judged.length) * 100) : null,
    pending: evaluations.filter((e) => e === null).length,
    not_judged: evaluations.filter((e) => e !== null && e.conditions_met === null).length,
  };
}

// ---- trade results ----

export interface TradeResult {
  closed_at: string; quantity: string; entry_price: string; exit_price: string;
  entry_value_usd: number; net_profit_usd: number; net_return_pct: number;
}

interface FillEvent { quantity: string; price: string | null }

/** The unrounded figures of one closed trade, which track records add up before rounding. */
export interface RawResult { closed_at: string; profit: number; return_pct: number }

/**
 * The closing fill of a linked order and, once the position is fully closed, its result. Prices are in
 * the market's quote currency (US dollars for ETH-USD). The usage fee is paid in NEAR, so it is shown on
 * the proof of trade and not deducted here.
 */
export function tradeResult(ctx: Ctx, orderId: string): { closing_fill: object | null; result: TradeResult | null; raw: RawResult | null } {
  const order = loadOrder(ctx, orderId);
  const opens = ctx.db.prepare(
    `SELECT quantity, price FROM execution_events
      WHERE order_id = ? AND type = 'fill' AND effect IN ('settled', 'fill_same_receipt') ORDER BY received_at, rowid`,
  ).all(orderId) as unknown as FillEvent[];
  // Closing orders and close events both count (trades.ts), so a trade has one result however it was closed.
  const closes = closingFillsOf(ctx, orderId);
  if (closes.length === 0) return { closing_fill: null, result: null, raw: null };

  const exit = vwap(closes);
  const closedAt = closes.at(-1)!.at;
  const complete = TERMINAL_STATUSES.includes(order.status) && exit.quantity === parseDecimal(order.filled_quantity, "filled");
  const closingFill = {
    at: closedAt, price: formatDecimal(exit.price), quantity: formatDecimal(exit.quantity), complete, source: closes.at(-1)!.source,
  };
  // A fill reported without a price has no entry value, so its trade has no result.
  if (!complete || opens.some((o) => o.price === null)) return { closing_fill: closingFill, result: null, raw: null };

  const entry = vwap(opens);
  if (entry.price === 0n) return { closing_fill: closingFill, result: null, raw: null };
  const perUnit = order.side === "buy" ? exit.price - entry.price : entry.price - exit.price;
  const profit = toNumber((perUnit * exit.quantity) / SCALE);
  const entryValue = toNumber((entry.price * exit.quantity) / SCALE);
  const returnPct = (profit / entryValue) * 100;
  return {
    closing_fill: closingFill,
    result: {
      closed_at: closedAt, quantity: formatDecimal(exit.quantity), entry_price: formatDecimal(entry.price),
      exit_price: formatDecimal(exit.price),
      entry_value_usd: round2(entryValue), net_profit_usd: round2(profit), net_return_pct: round2(returnPct),
    },
    raw: { closed_at: closedAt, profit, return_pct: returnPct },
  };
}

/**
 * The figures for one track record, over its closed trades in the order they closed. Net return % adds up each
 * trade's return, as if the same amount went into every trade; maximum drawdown % is the largest fall of that
 * running total from its highest point (starting from zero).
 */
export function trackRecord(results: Array<RawResult | null>) {
  const closed = results.filter((r): r is RawResult => r !== null).sort((a, b) => a.closed_at.localeCompare(b.closed_at));
  let total = 0;
  let peak = 0;
  let drawdown = 0;
  for (const r of closed) {
    total += r.return_pct;
    peak = Math.max(peak, total);
    drawdown = Math.max(drawdown, peak - total);
  }
  return {
    trades: closed.length,
    net_return_pct: round2(total),
    net_profit_usd: round2(closed.reduce((sum, r) => sum + r.profit, 0)),
    max_drawdown_pct: round2(drawdown),
    costs: "Before trading costs. The usage fee is paid in NEAR and shown on each proof of trade.",
  };
}

// ---- decimals ----

const SCALE = 10n ** 18n;

/** Volume-weighted average price and total quantity, both scaled by 10^18. */
function vwap(fills: FillEvent[]) {
  let quantity = 0n;
  let value = 0n;
  for (const f of fills) {
    const q = parseDecimal(f.quantity, "quantity");
    quantity += q;
    value += q * parseDecimal(f.price ?? "0", "price");
  }
  return { quantity, price: quantity === 0n ? 0n : value / quantity };
}

function toNumber(scaled: bigint): number {
  return Number(scaled) / 1e18;
}

function round2(n: number): number {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // no "-0"
}
