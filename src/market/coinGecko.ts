import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Db, transaction } from "../db.ts";
import { type Candle, type MarketData, type PricePoint, key } from "./marketData.ts";

// A live market data feed: one-minute candles of a DEX pool from CoinGecko's onchain API (the data also shown
// on GeckoTerminal). It is the only CoinGecko endpoint that serves minute candles for a past window.
//
// Fetched candles are kept in SQLite (market_candles, market_coverage). Everything the evaluation calls reads
// that cache and nothing else, so no read path and no database transaction ever waits on the network, and a
// failed or partial fetch can never turn into a recorded outcome: `covers` stays false until the whole window
// is in the cache.

export const COINGECKO_SOURCE = "feed:coingecko";
/** CoinGecko's Demo plan requires this next to the data. */
export const ATTRIBUTION = "Data provided by CoinGecko";

const INTERVAL_S = 60;
/** How far before a moment the last traded price may lie and still count as the price at that moment. */
const LOOKBACK_S = 30 * 60;
/** A candle is stored only once it has been closed this long, so a late trade cannot change it afterwards. */
const SETTLE_S = 3 * 60;
/** Within this distance of the present, a minute with no candle may only mean the feed has not indexed it yet. */
const RECENT_S = 60 * 60;
const PAGE_LIMIT = 1000;
const MAX_PAGES_PER_LOAD = 12;
const BACKOFF_MS = 60_000;
/** How long a window CoinGecko refused is left alone, so one unanswerable thesis does not hold up the others. */
const REFUSED_RETRY_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;

/**
 * CoinGecko answered, and said no to this request (for example a window older than the plan's history).
 * Unlike a timeout or a rate limit, asking again soon will not help, and other windows may still work.
 */
class FeedRefusal extends Error {}

export interface Pool {
  /** CoinGecko's network id, e.g. "eth". */
  network: string;
  address: string;
  /** For people: which pair on which exchange. */
  pair: string;
}

/** Which pool prices each market. A market that is not here has no price on this feed. */
export const POOLS: Record<string, Pool> = {
  "ETH-USD": { network: "eth", address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", pair: "WETH/USDC 0.05% (Uniswap v3, Ethereum)" },
};

/** A saved set of candles, so a past window can be evaluated or replayed without the network. */
export interface CandleSnapshot {
  market: string;
  source: string;
  attribution: string;
  network: string;
  pool: string;
  pair: string;
  interval_seconds: number;
  /** The window the candles cover, ISO 8601: every candle starting at or after `from` and before `to`. */
  from: string;
  to: string;
  fetched_at: string;
  /** [start (Unix seconds), open, high, low, close, volume in USD], oldest first. */
  candles: Array<[number, string, string, string, string, string]>;
}

interface CandleRow { start_s: number; open: string; high: string; low: string; close: string; volume: string }

const seconds = (iso: string) => Date.parse(iso) / 1000;
const alignDown = (s: number) => Math.floor(s / INTERVAL_S) * INTERVAL_S;
const iso = (s: number) => new Date(s * 1000).toISOString();

export class CoinGeckoMarketData implements MarketData {
  readonly name = COINGECKO_SOURCE;

  private readonly db: Db;
  private readonly apiKey: string | null;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;
  /** Fetches run one at a time, so two readers never download the same window twice. */
  private queue: Promise<unknown> = Promise.resolve();
  /** After a timeout, a rate limit or a server error, nothing is asked until this moment (real time, ms). */
  private failedUntil = 0;
  /** Windows CoinGecko refused, and when each may be asked for again. */
  private readonly refusedUntil = new Map<string, number>();

  /** Without an API key the feed still answers from its cache and from snapshots; only `load` fails. */
  constructor(db: Db, apiKey: string | null, fetcher: typeof fetch = fetch, baseUrl = "https://api.coingecko.com/api/v3") {
    this.db = db;
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Whether this process can fetch candles it does not have. */
  get canFetch(): boolean {
    return this.apiKey !== null;
  }

  /** The close of the last candle that had closed by `at`, if one closed within the lookback. */
  priceAt(market: string, at: string): PricePoint | null {
    const a = seconds(at);
    const row = this.db.prepare(
      `SELECT start_s, close FROM market_candles
        WHERE source = ? AND market = ? AND interval_s = ? AND start_s <= ? AND start_s >= ?
        ORDER BY start_s DESC LIMIT 1`,
    ).get(this.name, key(market), INTERVAL_S, a - INTERVAL_S, a - INTERVAL_S - LOOKBACK_S) as { start_s: number; close: string } | undefined;
    return row ? { at: iso(row.start_s + INTERVAL_S), price: row.close } : null;
  }

  /**
   * One point per candle that closed after `from` and by `to`. A candle that began before `from` counts by
   * its close only: its high and low may have been set before that moment.
   */
  between(market: string, from: string, to: string): PricePoint[] {
    const f = seconds(from);
    const rows = this.db.prepare(
      `SELECT start_s, high, low, close FROM market_candles
        WHERE source = ? AND market = ? AND interval_s = ? AND start_s > ? AND start_s <= ? ORDER BY start_s`,
    ).all(this.name, key(market), INTERVAL_S, f - INTERVAL_S, seconds(to) - INTERVAL_S) as unknown as CandleRow[];
    return rows.map((r) => ({
      at: iso(r.start_s + INTERVAL_S),
      price: r.close,
      ...(r.start_s >= f ? { high: r.high, low: r.low } : {}),
    }));
  }

  candles(market: string, from: string, to: string): Candle[] {
    const rows = this.db.prepare(
      `SELECT start_s, open, high, low, close, volume FROM market_candles
        WHERE source = ? AND market = ? AND interval_s = ? AND start_s >= ? AND start_s <= ? ORDER BY start_s`,
    ).all(this.name, key(market), INTERVAL_S, seconds(from), seconds(to) - INTERVAL_S) as unknown as CandleRow[];
    return rows.map((r) => ({ at: iso(r.start_s), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
  }

  hasCandles(market: string, from: string, to: string): boolean {
    return !POOLS[key(market)] || this.gaps(key(market), alignDown(seconds(from)), alignDown(seconds(to))).length === 0;
  }

  loadCandles(market: string, from: string, to: string): Promise<void> {
    return this.loadRange(market, seconds(from), seconds(to));
  }

  /**
   * The newest price CoinGecko has right now: the close so far of the newest candle. Nothing is stored,
   * because that candle may still change, and the evaluation only ever reads candles that have settled.
   */
  latest(market: string): Promise<PricePoint | null> {
    const pool = POOLS[key(market)];
    if (!pool) return Promise.resolve(null);
    const run = this.queue.then(async () => {
      const now = Math.floor(Date.now() / 1000);
      const [newest] = await this.fetchPage(pool, now, 1);
      return newest ? { at: iso(Math.min(newest.start_s + INTERVAL_S, now)), price: newest.close } : null;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** A market with no pool has nothing to wait for: it is "covered" and has no prices, which evaluates as no data. */
  covers(market: string, from: string, to: string): boolean {
    if (!POOLS[key(market)]) return true;
    const [start, end] = neededRange(from, to);
    return this.gaps(key(market), start, end).length === 0;
  }

  /** Fetches the candles `priceAt(market, from)` and `between(market, from, to)` need and do not have yet. */
  load(market: string, from: string, to: string): Promise<void> {
    const [start, end] = neededRange(from, to);
    return this.loadRange(market, start, end);
  }

  /** Fetches every candle that starts at or after `fromS` and before `toS` (Unix seconds) and is not cached yet. */
  loadRange(market: string, fromS: number, toS: number): Promise<void> {
    const m = key(market);
    const start = alignDown(fromS);
    const end = alignDown(toS);
    const window = `${m}:${start}:${end}`;
    const run = this.queue.then(async () => {
      if ((this.refusedUntil.get(window) ?? 0) > Date.now()) {
        throw new Error("CoinGecko refused this window earlier (it may be older than the plan's history); it is asked again within the hour");
      }
      try {
        await this.fill(m, start, end);
      } catch (err) {
        if (err instanceof FeedRefusal) this.refusedUntil.set(window, Date.now() + REFUSED_RETRY_MS);
        throw err;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async fill(market: string, start: number, end: number): Promise<void> {
    const pool = POOLS[market];
    if (!pool || end <= start) return;
    const realNow = Math.floor(Date.now() / 1000);
    // Close to the present, look up to the newest settled minute, even past `end`: only a candle that is
    // newer than a quiet minute proves the minute was quiet and not just unindexed.
    const recent = end > realNow - RECENT_S;
    const fetchEnd = recent ? alignDown(realNow - SETTLE_S) : end;
    let pages = 0;
    for (const [gapStart, gapEnd] of this.gaps(market, start, fetchEnd)) {
      const trusted = !(recent && gapEnd === fetchEnd);
      let cursor = gapEnd;
      while (cursor > gapStart) {
        if (pages++ >= MAX_PAGES_PER_LOAD) return; // the rest comes with the next load
        const want = Math.min(PAGE_LIMIT, Math.ceil((cursor - gapStart) / INTERVAL_S));
        const rows = await this.fetchPage(pool, cursor - 1, want);
        const oldest = rows.at(-1)?.start_s;
        const newest = rows[0]?.start_s;
        // Fewer candles than asked for, or candles reaching back past the gap: nothing older is missing.
        const coverFrom = rows.length < want || oldest === undefined || oldest <= gapStart ? gapStart : oldest;
        const coverTo = trusted || cursor !== gapEnd ? cursor : Math.min(cursor, (newest ?? -Infinity) + INTERVAL_S);
        if (coverTo <= coverFrom) break; // the feed has indexed nothing this recent yet
        transaction(this.db, () => {
          for (const r of rows) if (r.start_s >= coverFrom && r.start_s < coverTo) this.store(market, r);
          this.addCoverage(market, coverFrom, coverTo);
        });
        cursor = coverFrom;
      }
    }
  }

  /** One page of candles, newest first, ending with the candle that contains `before` (Unix seconds). */
  private async fetchPage(pool: Pool, before: number, limit: number): Promise<CandleRow[]> {
    if (!this.apiKey) throw new Error("no CoinGecko API key is configured (CONDEX_COINGECKO_API_KEY)");
    if (Date.now() < this.failedUntil) throw new Error("CoinGecko is not asked again for a minute after a failed request");
    const url = `${this.baseUrl}/onchain/networks/${pool.network}/pools/${pool.address}/ohlcv/minute` +
      `?aggregate=1&before_timestamp=${before}&limit=${limit}&currency=usd&token=base`;
    try {
      // The key travels in a header only, never in the URL, so it cannot end up in a log line.
      const res = await this.fetcher(url, {
        headers: { accept: "application/json", "x-cg-demo-api-key": this.apiKey },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const message = `CoinGecko answered ${res.status}`;
        // A plain "no" is about this request. A rate limit, a timeout or a server error is about all of them.
        throw res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 ? new FeedRefusal(message) : new Error(message);
      }
      const body = await res.json() as { data?: { attributes?: { ohlcv_list?: unknown } } };
      const list = body?.data?.attributes?.ohlcv_list;
      if (!Array.isArray(list)) throw new Error("CoinGecko's answer had no ohlcv_list");
      return list.map(candleFromFeed).filter((r): r is CandleRow => r !== null).sort((a, b) => b.start_s - a.start_s);
    } catch (err) {
      if (!(err instanceof FeedRefusal)) this.failedUntil = Date.now() + BACKOFF_MS;
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // ---- snapshots ----

  /** The cached candles of a window, ready to save. Call `loadRange` first. */
  exportSnapshot(market: string, from: string, to: string): CandleSnapshot {
    const m = key(market);
    const pool = POOLS[m];
    if (!pool) throw new Error(`No pool prices ${m} on this feed`);
    const start = alignDown(seconds(from));
    const end = alignDown(seconds(to));
    if (this.gaps(m, start, end).length > 0) throw new Error(`The candles of ${m} from ${iso(start)} to ${iso(end)} are not all fetched yet`);
    const rows = this.db.prepare(
      `SELECT start_s, open, high, low, close, volume FROM market_candles
        WHERE source = ? AND market = ? AND interval_s = ? AND start_s >= ? AND start_s < ? ORDER BY start_s`,
    ).all(this.name, m, INTERVAL_S, start, end) as unknown as CandleRow[];
    return {
      market: m, source: this.name, attribution: ATTRIBUTION, network: pool.network, pool: pool.address, pair: pool.pair,
      interval_seconds: INTERVAL_S, from: iso(start), to: iso(end), fetched_at: new Date().toISOString(),
      candles: rows.map((r) => [r.start_s, r.open, r.high, r.low, r.close, r.volume]),
    };
  }

  /** Puts a saved window into the cache, as if it had just been fetched. */
  importSnapshot(snapshot: CandleSnapshot): void {
    if (snapshot?.source !== this.name || snapshot.interval_seconds !== INTERVAL_S || !Array.isArray(snapshot.candles)) {
      throw new Error(`not a ${this.name} snapshot of ${INTERVAL_S}-second candles`);
    }
    const market = key(snapshot.market);
    const start = alignDown(seconds(snapshot.from));
    const end = alignDown(seconds(snapshot.to));
    if (!(end > start)) throw new Error("the snapshot's window is empty");
    transaction(this.db, () => {
      for (const [start_s, open, high, low, close, volume] of snapshot.candles) {
        if (start_s >= start && start_s < end) this.store(market, { start_s, open, high, low, close, volume });
      }
      this.addCoverage(market, start, end);
    });
  }

  /** Imports every .json snapshot in a folder. Returns how many it imported. A missing folder is none. */
  importSnapshotDir(dir: string): number {
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const file of files) {
      try {
        this.importSnapshot(JSON.parse(readFileSync(join(dir, file), "utf8")) as CandleSnapshot);
      } catch (err) {
        throw new Error(`Candle snapshot ${join(dir, file)} could not be loaded: ${(err as Error).message}`);
      }
    }
    return files.length;
  }

  // ---- the cache ----

  private store(market: string, r: CandleRow): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO market_candles (source, market, interval_s, start_s, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(this.name, market, INTERVAL_S, r.start_s, r.open, r.high, r.low, r.close, r.volume);
  }

  /** Records that every candle starting in [from, to) is cached, joining it with the ranges it touches. */
  private addCoverage(market: string, from: number, to: number): void {
    const touching = this.db.prepare(
      "SELECT from_s, to_s FROM market_coverage WHERE source = ? AND market = ? AND interval_s = ? AND from_s <= ? AND to_s >= ?",
    ).all(this.name, market, INTERVAL_S, to, from) as Array<{ from_s: number; to_s: number }>;
    let lo = from;
    let hi = to;
    for (const r of touching) {
      lo = Math.min(lo, r.from_s);
      hi = Math.max(hi, r.to_s);
    }
    this.db.prepare(
      "DELETE FROM market_coverage WHERE source = ? AND market = ? AND interval_s = ? AND from_s <= ? AND to_s >= ?",
    ).run(this.name, market, INTERVAL_S, to, from);
    this.db.prepare("INSERT INTO market_coverage (source, market, interval_s, from_s, to_s) VALUES (?, ?, ?, ?, ?)")
      .run(this.name, market, INTERVAL_S, lo, hi);
  }

  /** The parts of [start, end) that are not covered yet, oldest first. */
  private gaps(market: string, start: number, end: number): Array<[number, number]> {
    const rows = this.db.prepare(
      `SELECT from_s, to_s FROM market_coverage
        WHERE source = ? AND market = ? AND interval_s = ? AND to_s > ? AND from_s < ? ORDER BY from_s`,
    ).all(this.name, market, INTERVAL_S, start, end) as Array<{ from_s: number; to_s: number }>;
    const gaps: Array<[number, number]> = [];
    let cursor = start;
    for (const r of rows) {
      if (r.from_s > cursor) gaps.push([cursor, Math.min(r.from_s, end)]);
      cursor = Math.max(cursor, r.to_s);
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push([cursor, end]);
    return gaps;
  }
}

/**
 * The candle starts a window needs: from the lookback before `from`, so the price at `from` is known, up to
 * the last candle that has closed by `to`.
 */
function neededRange(from: string, to: string): [number, number] {
  return [alignDown(seconds(from) - INTERVAL_S - LOOKBACK_S), alignDown(seconds(to))];
}

/** One row of the feed's ohlcv_list as a cache row, or null when it is not a usable candle. */
function candleFromFeed(row: unknown): CandleRow | null {
  if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== "number" || !Number.isFinite(row[0])) return null;
  const [open, high, low, close] = [row[1], row[2], row[3], row[4]].map((n) => decimal(n, true));
  const volume = decimal(row[5], false);
  if (!open || !high || !low || !close || volume === null) return null;
  return { start_s: alignDown(row[0]), open, high, low, close, volume };
}

/** A JSON number as the plain decimal text ConDex and the contract use: no exponent, at most 18 decimals. */
function decimal(n: unknown, positive: boolean): string | null {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
  // 15 significant digits is all a JSON number reliably holds. Past that is binary rounding noise, which
  // would turn the feed's 2023.65 into 2023.6499999999996.
  n = Number(n.toPrecision(15));
  const text = /e/i.test(String(n)) ? (n as number).toFixed(18) : String(n);
  const [whole = "0", fraction = ""] = text.split(".");
  const kept = fraction.slice(0, 18).replace(/0+$/, "");
  const out = kept ? `${whole}.${kept}` : whole;
  return positive && /^0+$/.test(out.replace(".", "")) ? null : out;
}

/** What a reader needs to check an evaluation: which feed, which pool, how candles are read, and the attribution. */
export function describeSource(source: string, market: string) {
  if (source !== COINGECKO_SOURCE) return null;
  const pool = POOLS[key(market)];
  return {
    feed: {
      provider: "CoinGecko",
      data: "one-minute candles of an onchain pool",
      ...(pool ? { network: pool.network, pool: pool.address, pair: pool.pair, url: `https://www.geckoterminal.com/${pool.network}/pools/${pool.address}` } : {}),
      candle_rule: "A level counts as reached when a candle's high or low touches it. A candle that touches both the target and the invalidation counts as invalidated.",
    },
    attribution: ATTRIBUTION,
  };
}
