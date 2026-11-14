import type { Db } from "../db.ts";
import { formatDecimal, parseDecimal } from "../quantity.ts";
import { newId } from "../util.ts";

/**
 * One price the evaluation walks over. A live feed's point is a whole candle: `price` is its close and `at`
 * the moment it closed, and `high` and `low` say how far the price went inside it. A point without them is
 * a single price.
 */
export interface PricePoint {
  at: string;
  price: string;
  high?: string;
  low?: string;
}

/** One candle as a feed serves it. `at` is when the candle starts. */
export interface Candle {
  at: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/**
 * Where ConDex reads market prices to evaluate a thesis. A live feed can replace the simulated one
 * without changing the evaluation; its name is recorded on every evaluation as the evidence source.
 *
 * `priceAt`, `between`, `covers` and `candles` are synchronous and never touch the network: a live feed
 * answers them from its local cache. Only `load` fetches.
 */
export interface MarketData {
  /** Evidence source label: "simulated", or "feed:<name>" for a live feed. */
  readonly name: string;
  /** The last price at or before `at`, or null when there is none. */
  priceAt(market: string, at: string): PricePoint | null;
  /** Every price after `from` up to and including `to`, oldest first. */
  between(market: string, from: string, to: string): PricePoint[];
  /**
   * Whether `priceAt(market, from)` and `between(market, from, to)` would answer from complete data.
   * A thesis is only evaluated once this is true, so half-fetched prices never become a recorded outcome.
   */
  covers(market: string, from: string, to: string): boolean;
  /** Fetches whatever is still missing for that window. Throws when the feed cannot be reached. */
  load(market: string, from: string, to: string): Promise<void>;
  /** The candles that start at or after `from` and have closed by `to`, oldest first. */
  candles(market: string, from: string, to: string): Candle[];
  /** Whether `candles(market, from, to)` would be complete. */
  hasCandles(market: string, from: string, to: string): boolean;
  /** Fetches whatever `candles(market, from, to)` still lacks. Throws when the feed cannot be reached. */
  loadCandles(market: string, from: string, to: string): Promise<void>;
  /**
   * A live feed only: the newest price it can get right now, asked for afresh. It is what a simulated order
   * fills at. It is not kept as market data, because the candle it comes from may still be changing.
   */
  latest?(market: string): Promise<PricePoint | null>;
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

  /** Whatever was typed in is all there is: nothing more can arrive from anywhere. */
  covers(): boolean {
    return true;
  }

  async load(): Promise<void> {}

  /** Each recorded price as a candle with no range. */
  candles(market: string, from: string, to: string): Candle[] {
    const rows = this.db.prepare(
      "SELECT at, price FROM market_prices WHERE market = ? AND at >= ? AND at <= ? ORDER BY at, rowid",
    ).all(key(market), from, to) as unknown as PricePoint[];
    return rows.map((p) => ({ at: p.at, open: p.price, high: p.price, low: p.price, close: p.price, volume: "0" }));
  }

  hasCandles(): boolean {
    return true;
  }

  async loadCandles(): Promise<void> {}
}

/** One spelling per market, as theses store them. */
export function key(market: string): string {
  return market.trim().toUpperCase();
}
