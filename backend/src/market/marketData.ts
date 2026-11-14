import type { Db } from "../db.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { newId } from "../util.ts";

export interface PricePoint {
  at: string;
  price: string;
}

/**
 * Where ConDex reads market prices to evaluate a thesis. A live feed can replace the simulated one
 * without changing the evaluation; its name is recorded on every evaluation as the evidence source.
 */
export interface MarketData {
  /** Evidence source label: "simulated", or "feed:<name>" for a live feed. */
  readonly name: string;
  /** The last price at or before `at`, or null when there is none. */
  priceAt(market: string, at: string): PricePoint | null;
  /** Every price after `from` up to and including `to`, oldest first. */
  between(market: string, from: string, to: string): PricePoint[];
}

/** Prices recorded through the /v1/sim/market routes or the test page. Market names are matched in upper case, as theses store them. */
export class SimulatedMarketData implements MarketData {
  readonly name = "simulated";

  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  record(market: string, price: string, at: string): PricePoint & { market: string } {
    const point = { at, price: formatDecimal(parseDecimal(price, "price", { positive: true })) };
    this.db.prepare("INSERT INTO market_prices (id, market, price, at) VALUES (?, ?, ?, ?)")
      .run(newId("px"), key(market), point.price, point.at);
    return { market: key(market), ...point };
  }

  priceAt(market: string, at: string): PricePoint | null {
    const row = this.db.prepare(
      "SELECT at, price FROM market_prices WHERE market = ? AND at <= ? ORDER BY at DESC, rowid DESC LIMIT 1",
    ).get(key(market), at) as PricePoint | undefined;
    return row ?? null;
  }

  between(market: string, from: string, to: string): PricePoint[] {
    return this.db.prepare(
      "SELECT at, price FROM market_prices WHERE market = ? AND at > ? AND at <= ? ORDER BY at, rowid",
    ).all(key(market), from, to) as unknown as PricePoint[];
  }
}

function key(market: string): string {
  return market.trim().toUpperCase();
}
