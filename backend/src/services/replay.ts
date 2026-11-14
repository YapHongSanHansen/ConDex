import type { Ctx } from "../context.ts";
import { badRequest, conflict } from "../errors.ts";
import { parseDecimal } from "../quantity.ts";
import { clearReplayClock, nowIso, replayClock, setReplayClock } from "../util.ts";
import { sweepEvaluations } from "./evaluationSweep.ts";
import { loadOrder } from "./orders.ts";
import { simulate } from "./settlement.ts";
import { CLOSING_PREFIX, closingMarket } from "./trades.ts";

// Dev mode only: replaying a past market window. The presenter freezes ConDex's business clock at a past
// moment and steps it forward. Publishing, quotes, orders, fills, closes and the evaluation then happen at
// those moments, against the real prices of that window, and every thesis published this way is labelled as
// a replay. Sign-in, API keys and subscriptions stay on real time (see util.ts).

export function clockView() {
  return { mode: replayClock() === null ? "real" as const : "replay" as const, now: nowIso() };
}

/** For the presenter: a market's last price at the clock's current moment, from the feed's cache. null: none there. */
export function priceNow(ctx: Ctx, market: string) {
  const point = ctx.market.priceAt(market, nowIso());
  return { market: market.trim().toUpperCase(), source: ctx.market.name, price: point?.price ?? null, at: point?.at ?? null };
}

/**
 * Freezes the business clock at a past moment, then lets the simulated venue and the evaluation catch up
 * with it (see `replayTick`). Only on the mock ledger: NEAR's own clock cannot be moved, and its contract
 * refuses a trader's approval once a thesis has expired by that clock.
 */
export function setClock(ctx: Ctx, at: string) {
  if (ctx.chain) {
    throw conflict("replay_needs_mock_ledger", "The replay clock only works on the mock ledger, because NEAR's clock cannot be moved. Start the API with CONDEX_LEDGER=mock");
  }
  const ms = Date.parse(at);
  if (!(ms <= Date.now())) throw badRequest("clock_in_future", "The replay clock can only be set to a past moment");
  setReplayClock(ms);
  return { ...clockView(), ...replayTick(ctx) };
}

export function resetClock() {
  clearReplayClock();
  return clockView();
}

interface Resting { id: string; market: string; side: "buy" | "sell"; limit_price: string | null; updated_at: string }

/**
 * What the market does when replayed time moves on. Each order and closing order resting on the simulated
 * venue fills at the close of the first candle that closed after the order was placed, and the fill is
 * timed at that candle, not at the moment the presenter stepped the clock. A limit order waits for a close
 * at or better than its limit. Then every thesis whose deadline has now passed is evaluated.
 */
export function replayTick(ctx: Ctx) {
  const target = nowIso();
  const resting = [
    ...ctx.db.prepare(
      `SELECT id, market, side, limit_price, updated_at FROM orders
        WHERE venue = 'simulated' AND status IN ('open', 'partially_filled') ORDER BY created_at, rowid`,
    ).all() as unknown as Resting[],
    ...ctx.db.prepare(
      `SELECT c.id, o.market, c.side, c.limit_price, c.updated_at FROM closing_orders c JOIN orders o ON o.id = c.order_id
        WHERE c.venue = 'simulated' AND c.status IN ('open', 'partially_filled') ORDER BY c.created_at, c.rowid`,
    ).all() as unknown as Resting[],
  ];
  const due = resting.flatMap((order) => {
    const limit = order.limit_price === null ? null : parseDecimal(order.limit_price, "limit_price");
    const candle = ctx.market.between(order.market, order.updated_at, target).find((p) => {
      const close = parseDecimal(p.price, "price");
      return limit === null || (order.side === "buy" ? close <= limit : close >= limit);
    });
    return candle ? [{ order, candle }] : [];
  }).sort((a, b) => a.candle.at.localeCompare(b.candle.at));

  const fills: Array<{ order_id: string; at: string; price: string }> = [];
  try {
    for (const { order, candle } of due) {
      setReplayClock(Date.parse(candle.at)); // the fill happened when that candle closed
      try {
        simulate(ctx, order.id, "fill", { price: candle.price });
        fills.push({ order_id: order.id, at: candle.at, price: candle.price });
      } catch (err) {
        console.warn(`replay: ${order.id} was not filled: ${(err as Error).message}`);
      }
    }
  } finally {
    setReplayClock(Date.parse(target));
  }
  return { fills, evaluated: sweepEvaluations(ctx) };
}

/**
 * The price the simulated venue fills or closes at when none is given and the feed is a real one, so a
 * simulated fill is still made at a real market price. In real time that is the newest price the feed has,
 * asked for afresh: the candles kept for the evaluation are a few minutes behind, and a fill priced from
 * them would disagree with the evaluation of the same moment. In a replay it is the replayed moment's price.
 */
export async function feedPriceFor(ctx: Ctx, orderId: string): Promise<string> {
  const market = orderId.startsWith(CLOSING_PREFIX) ? closingMarket(ctx, orderId) : loadOrder(ctx, orderId).market;
  if (replayClock() === null && ctx.market.latest) {
    const fresh = await ctx.market.latest(market).catch(() => null);
    if (fresh) return fresh.price;
  }
  const now = nowIso();
  // Best effort: the cache or a saved snapshot may already hold it, and then no network is needed.
  if (!ctx.market.covers(market, now, now)) await ctx.market.load(market, now, now).catch(() => undefined);
  const point = ctx.market.priceAt(market, now);
  if (!point) {
    throw conflict("no_market_price", `The market data feed has no recent price for ${market}. Give a price, or try again in a minute`);
  }
  return point.price;
}
