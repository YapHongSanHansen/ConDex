// The CoinGecko price feed on its own, against a stand-in for the endpoint: what it asks for, what it keeps,
// and when it says a window is complete. Nothing here reaches the network.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { ATTRIBUTION, CoinGeckoMarketData, describeSource } from "../src/market/coinGecko.ts";
import { type FeedCandle, fakeCoinGecko, flat, withCandle } from "./fakeCoinGecko.ts";

const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const MIN = 60;
/** The start of the window every test uses, in Unix seconds. */
const T = Date.parse("2030-03-01T00:00:00Z") / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();
const FROM = iso(T);
const TO = iso(T + 30 * MIN);
/** Ten days later: the window is long past, so every minute of it is final. */
const LONG_AFTER = (T + 10 * 86_400) * 1000;

beforeEach(() => mock.timers.enable({ apis: ["Date"], now: LONG_AFTER }));
afterEach(() => mock.timers.reset());

function feedWith(candles: FeedCandle[], apiKey: string | null = "test-key") {
  const fake = fakeCoinGecko(candles);
  return { feed: new CoinGeckoMarketData(openDb(":memory:"), apiKey, fake.fetcher), fake };
}
/** A candle every minute from 40 minutes before the window to 40 minutes after its end, all at 3000. */
const steady = () => flat(T - 40 * MIN, T + 70 * MIN, 3000);

describe("fetching a window", () => {
  test("asks once, with the key in a header and never in the URL, and then answers from its cache", async () => {
    const { feed, fake } = feedWith(steady());
    assert.equal(feed.covers("ETH-USD", FROM, TO), false);
    await feed.load("eth-usd", FROM, TO);

    assert.equal(fake.state.calls.length, 1);
    const [call] = fake.state.calls;
    assert.equal(call!.key, "test-key");
    assert.ok(!call!.url.includes("test-key"), "the key must not be in the URL");
    assert.ok(call!.url.includes(`/onchain/networks/eth/pools/${POOL}/ohlcv/minute?aggregate=1`), call!.url);
    assert.equal(call!.before, T + 30 * MIN - 1);
    assert.equal(call!.limit, 61); // 30 minutes of window, 30 of lookback and the candle that closed at `from`

    assert.equal(feed.covers("ETH-USD", FROM, TO), true);
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(fake.state.calls.length, 1, "a covered window is not fetched again");

    // The price at a moment is the close of the last candle that had closed by then.
    assert.deepEqual(feed.priceAt("ETH-USD", FROM), { at: FROM, price: "3000" });
    const points = feed.between("ETH-USD", FROM, TO);
    assert.equal(points.length, 30);
    assert.deepEqual(points[0], { at: iso(T + MIN), price: "3000", high: "3000", low: "3000" });
    assert.equal(points.at(-1)!.at, TO);
  });

  test("a minute with no trades inside a fetched window is not missing data", async () => {
    const { feed } = feedWith(steady().filter((c) => c[0] !== T + 5 * MIN));
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(feed.covers("ETH-USD", FROM, TO), true);
    const points = feed.between("ETH-USD", FROM, TO);
    assert.equal(points.length, 29);
    assert.ok(!points.some((p) => p.at === iso(T + 6 * MIN)));
  });

  test("pages back through a window longer than one answer", async () => {
    const { feed, fake } = feedWith(flat(T - 40 * MIN, T + 2500 * MIN, 3000));
    await feed.load("ETH-USD", FROM, iso(T + 2500 * MIN));
    assert.deepEqual(fake.state.calls.map((c) => c.limit), [1000, 1000, 531]);
    assert.deepEqual(fake.state.calls.map((c) => c.before), [T + 2500 * MIN - 1, T + 1500 * MIN - 1, T + 500 * MIN - 1]);
    assert.equal(feed.covers("ETH-USD", FROM, iso(T + 2500 * MIN)), true);
  });

  test("a candle that began before `from` counts by its close only, and one closing after `to` is left out", async () => {
    const { feed } = feedWith(withCandle(steady(), T, 3000, 3050, 2950, 3010));
    await feed.load("ETH-USD", FROM, TO);
    const points = feed.between("ETH-USD", iso(T + 30), iso(T + 2 * MIN + 30));
    assert.deepEqual(points, [
      { at: iso(T + MIN), price: "3010" },                                  // began 30 seconds before `from`
      { at: iso(T + 2 * MIN), price: "3000", high: "3000", low: "3000" },   // the candle T+2min closes after `to`
    ]);
  });

  test("prices are kept as plain decimals, without binary rounding noise", async () => {
    const { feed } = feedWith(withCandle(steady(), T, 2023.6499999999996, 2032.4499999999996, 0.0000001, 2075.62));
    await feed.load("ETH-USD", FROM, TO);
    const [candle] = feed.candles("ETH-USD", FROM, iso(T + MIN));
    assert.deepEqual(candle, { at: FROM, open: "2023.65", high: "2032.45", low: "0.0000001", close: "2075.62", volume: "1000" });
  });

  test("a market no pool prices has nothing to wait for and no prices", async () => {
    const { feed, fake } = feedWith(steady());
    assert.equal(feed.covers("DOGE-USD", FROM, TO), true);
    await feed.load("DOGE-USD", FROM, TO);
    assert.equal(fake.state.calls.length, 0);
    assert.equal(feed.priceAt("DOGE-USD", FROM), null);
    assert.deepEqual(feed.between("DOGE-USD", FROM, TO), []);
  });
});

describe("when the feed cannot answer", () => {
  for (const failure of [500, 429, "timeout", "garbage"] as const) {
    test(`${failure}: nothing is kept, and it is not asked again for a minute`, async () => {
      const { feed, fake } = feedWith(steady());
      fake.state.fail = failure;
      await assert.rejects(feed.load("ETH-USD", FROM, TO));
      assert.equal(feed.covers("ETH-USD", FROM, TO), false);
      assert.equal(feed.priceAt("ETH-USD", FROM), null);

      fake.state.fail = null;
      await assert.rejects(feed.load("ETH-USD", FROM, TO), /not asked again for a minute/);
      assert.equal(fake.state.calls.length, 1);

      mock.timers.setTime(LONG_AFTER + 61_000);
      await feed.load("ETH-USD", FROM, TO);
      assert.equal(feed.covers("ETH-USD", FROM, TO), true);
    });
  }

  test("a refused window is left alone for an hour, and other windows are still fetched", async () => {
    const { feed, fake } = feedWith(steady());
    fake.state.fail = 401; // what the Demo plan answers for a window older than its history
    await assert.rejects(feed.load("ETH-USD", FROM, TO), /answered 401/);
    fake.state.fail = null;

    const later = [iso(T + 40 * MIN), iso(T + 60 * MIN)] as const;
    await feed.load("ETH-USD", ...later);
    assert.equal(feed.covers("ETH-USD", ...later), true);

    const before = fake.state.calls.length;
    await assert.rejects(feed.load("ETH-USD", FROM, TO), /refused this window earlier/);
    assert.equal(fake.state.calls.length, before, "the refused window is not asked for again yet");
  });

  test("without an API key it only answers from what it already has", async () => {
    const { feed, fake } = feedWith(steady(), null);
    assert.equal(feed.canFetch, false);
    await assert.rejects(feed.load("ETH-USD", FROM, TO), /no CoinGecko API key/);
    assert.equal(fake.state.calls.length, 0);
  });
});

describe("close to the present", () => {
  test("a candle is not kept until it has been closed for three minutes", async () => {
    const { feed } = feedWith(steady());
    mock.timers.setTime((T + 30 * MIN + 100) * 1000); // 100 seconds after the window ended
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(feed.covers("ETH-USD", FROM, TO), false);
    assert.equal(feed.between("ETH-USD", FROM, TO).at(-1)!.at, iso(T + 28 * MIN));

    mock.timers.setTime((T + 35 * MIN) * 1000);
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(feed.covers("ETH-USD", FROM, TO), true);
  });

  test("a quiet last minute only counts once a newer candle shows the feed has got that far", async () => {
    // No trades in the last two minutes of the window, and none since.
    const { feed, fake } = feedWith(flat(T - 40 * MIN, T + 28 * MIN, 3000));
    mock.timers.setTime((T + 35 * MIN) * 1000);
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(feed.covers("ETH-USD", FROM, TO), false, "the feed may just not have indexed those minutes yet");

    fake.state.candles.push([T + 33 * MIN, 3001, 3001, 3001, 3001, 1000]);
    mock.timers.setTime((T + 37 * MIN) * 1000);
    await feed.load("ETH-USD", FROM, TO);
    assert.equal(feed.covers("ETH-USD", FROM, TO), true);
    assert.equal(feed.between("ETH-USD", FROM, TO).at(-1)!.at, iso(T + 28 * MIN), "the quiet minutes have no candle");
  });
});

describe("the newest price, for filling a simulated order", () => {
  test("is asked for afresh, includes a candle too recent to keep, and is not stored", async () => {
    const { feed, fake } = feedWith(steady());
    const now = T + 30 * MIN + 20; // 20 seconds into a minute
    mock.timers.setTime(now * 1000);
    fake.state.candles = withCandle(fake.state.candles, T + 30 * MIN, 3000, 3012, 3000, 3011.5); // still forming

    assert.deepEqual(await feed.latest("ETH-USD"), { at: iso(now), price: "3011.5" });
    assert.deepEqual(fake.state.calls.at(-1), { url: fake.state.calls.at(-1)!.url, key: "test-key", before: now, limit: 1 });
    assert.deepEqual(feed.candles("ETH-USD", iso(T), iso(T + 40 * MIN)), [], "nothing from it is kept as market data");
    assert.equal(feed.priceAt("ETH-USD", iso(now)), null);

    assert.equal(await feed.latest("DOGE-USD"), null);
    fake.state.fail = 500;
    await assert.rejects(feed.latest("ETH-USD"), /answered 500/);
  });
});

describe("saved windows", () => {
  test("a snapshot carries a window to a feed that cannot fetch", async () => {
    const { feed } = feedWith(withCandle(steady(), T + 10 * MIN, 3000, 3105, 2995, 3050));
    await feed.load("ETH-USD", FROM, TO);
    const snapshot = JSON.parse(JSON.stringify(feed.exportSnapshot("ETH-USD", iso(T - 31 * MIN), TO)));
    assert.equal(snapshot.source, "feed:coingecko");
    assert.equal(snapshot.pool, POOL);
    assert.equal(snapshot.attribution, ATTRIBUTION);
    assert.equal(snapshot.candles.length, 61);

    const offline = new CoinGeckoMarketData(openDb(":memory:"), null, (() => { throw new Error("no network in this test"); }) as never);
    assert.equal(offline.covers("ETH-USD", FROM, TO), false);
    offline.importSnapshot(snapshot);
    assert.equal(offline.covers("ETH-USD", FROM, TO), true);
    assert.deepEqual(offline.between("ETH-USD", FROM, TO), feed.between("ETH-USD", FROM, TO));
    assert.equal(offline.between("ETH-USD", FROM, TO)[10]!.high, "3105");
  });

  test("a window that is not fully fetched cannot be saved, and a foreign file is refused", async () => {
    const { feed } = feedWith(steady());
    assert.throws(() => feed.exportSnapshot("ETH-USD", FROM, TO), /not all fetched yet/);
    assert.throws(() => feed.importSnapshot({ source: "simulated", interval_seconds: 60, candles: [] } as never), /not a feed:coingecko snapshot/);
  });
});

describe("configuration and description", () => {
  test("the feed is CoinGecko only when it has a key or is asked for by name", () => {
    assert.equal(loadConfig({}).marketFeed, "simulated");
    assert.equal(loadConfig({}).marketSnapshots, null);
    const withKey = loadConfig({ CONDEX_COINGECKO_API_KEY: " k-test " });
    assert.equal(withKey.marketFeed, "coingecko");
    assert.equal(withKey.coinGeckoApiKey, "k-test");
    assert.match(withKey.marketSnapshots!, /demo[\\/]candles$/);
    assert.equal(loadConfig({ CONDEX_COINGECKO_API_KEY: "k", CONDEX_MARKET_FEED: "simulated" }).marketFeed, "simulated");
    // Asked for by name without a key: it can still replay saved windows.
    const offline = loadConfig({ CONDEX_MARKET_FEED: "coingecko" });
    assert.equal(offline.marketFeed, "coingecko");
    assert.equal(offline.coinGeckoApiKey, null);
    assert.throws(() => loadConfig({ CONDEX_MARKET_FEED: "coingeko" }), /CONDEX_MARKET_FEED must be one of/);
  });

  test("an evaluation on this feed can name its pool and carries the attribution", () => {
    assert.equal(describeSource("simulated", "ETH-USD"), null);
    const described = describeSource("feed:coingecko", "eth-usd")!;
    assert.equal(described.attribution, "Data provided by CoinGecko");
    assert.equal(described.feed.pool, POOL);
    assert.equal(described.feed.network, "eth");
    assert.match(described.feed.url!, /geckoterminal\.com\/eth\/pools\/0x88e6/);
  });
});
