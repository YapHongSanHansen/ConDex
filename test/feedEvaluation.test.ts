// A thesis judged on the CoinGecko feed, through the API: it stays pending until the sweep has fetched every
// candle of its window, no read ever fetches, and candle highs and lows decide whether a level was reached.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import { openDb } from "../src/db.ts";
import { ATTRIBUTION, CoinGeckoMarketData } from "../src/market/coinGecko.ts";
import type { ChainClient } from "../src/near/chainClient.ts";
import { loadDueCandles, sweepEvaluations } from "../src/services/evaluationSweep.ts";
import { type FeedCandle, fakeCoinGecko, flat, withCandle } from "./fakeCoinGecko.ts";
import { ETH_MESSAGES, connectWallet, startServer } from "./helpers.ts";

const fake = fakeCoinGecko();
const db = openDb(":memory:");
const srv = await startServer({ db, market: new CoinGeckoMarketData(db, "test-key", fake.fetcher) });
const { api } = srv;

// Each test gets its own day, so one test's failed request cannot make the feed back off in the next.
const DAY0 = Date.parse("2030-03-01T00:00:00.000Z");
let day = 0;
let base = DAY0;
const at = (minutes: number, seconds = 0) => new Date(base + minutes * 60_000 + seconds * 1000).toISOString();
const start = (minutes: number) => base / 1000 + minutes * 60;
/** A candle every minute from 40 minutes before publishing to 80 minutes after, all at 3000. */
const steady = () => flat(start(-40), start(80), 3000);

let alice: string;
after(() => srv.close());
beforeEach(async () => {
  base = DAY0 + ++day * 86_400_000;
  mock.timers.enable({ apis: ["Date"], now: base });
  await api("POST", "/v1/dev/reset");
  fake.state.candles = steady();
  fake.state.calls.length = 0;
  fake.state.fail = null;
  const session = (await connectWallet(api, "alice.testnet")).session;
  alice = (await api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
});
afterEach(() => mock.timers.reset());

/** Long ETH-USD from 3000: wrong at 2900, right at 3100, tradable and judged for one hour. */
async function publish(server = api, key = alice) {
  const r = await server("POST", "/v1/insights", { key, body: {
    title: "ETH long", market: "ETH-USD", direction: "long", entry: "At the market.", invalidation: "Below 2,900.", target: "3,100.",
    invalidation_price: "2900", target_price: "3100", expires_at: at(60), fee_near: "0.1", messages: ETH_MESSAGES,
  } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.token_id as string;
}
const set = (candles: FeedCandle[]) => { fake.state.candles = candles; };
const pastDeadline = () => mock.timers.setTime(base + 70 * 60_000);
const evaluation = async (tokenId: string) => (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.evaluation;
const stored = (tokenId: string) => db.prepare("SELECT outcome FROM thesis_evaluations WHERE token_id = ?").get(tokenId);
const recorded = () => srv.ctx.ledger.listTxs(50).filter((t) => t.method === "record_evaluation").length;

describe("a thesis on the CoinGecko feed", () => {
  test("stays pending until the sweep has fetched its window, and no read ever fetches", async () => {
    set(withCandle(steady(), start(30), 3000, 3105, 2995, 3050)); // a wick through the target, closing below it
    const tokenId = await publish();
    assert.deepEqual((await evaluation(tokenId)).status, "pending");
    pastDeadline();

    // Reading, in every way a thesis is read, neither fetches nor records anything.
    for (const path of [`/v1/tokens/${tokenId}/proof`, `/v1/tokens/${tokenId}/preview`, "/v1/tokens", "/v1/publishers/alice.testnet"]) {
      assert.equal((await api("GET", path)).status, 200, path);
    }
    assert.equal(sweepEvaluations(srv.ctx), 0, "the sweep alone does not fetch either");
    assert.equal(fake.state.calls.length, 0);
    assert.equal(stored(tokenId), undefined);
    const pending = await evaluation(tokenId);
    assert.equal(pending.status, "pending");
    assert.equal(pending.waiting_for, "market_data");
    assert.equal(pending.source, "feed:coingecko");

    // CoinGecko is down: the thesis is not recorded as "no data". It simply waits.
    fake.state.fail = 500;
    assert.equal(await loadDueCandles(srv.ctx), 0);
    assert.equal(sweepEvaluations(srv.ctx), 0);
    assert.equal(stored(tokenId), undefined);
    assert.equal(recorded(), 0);

    // It answers again: one fetch, then the thesis is judged once.
    fake.state.fail = null;
    mock.timers.setTime(base + 72 * 60_000);
    assert.equal(await loadDueCandles(srv.ctx), 1);
    assert.equal(sweepEvaluations(srv.ctx), 1);
    assert.equal(sweepEvaluations(srv.ctx), 0);
    assert.equal(await loadDueCandles(srv.ctx), 0, "an evaluated thesis is not fetched for again");

    const ev = await evaluation(tokenId);
    assert.equal(ev.status, "evaluated");
    assert.equal(ev.outcome, "target_hit", "a high that touches the target counts, wherever the candle closed");
    assert.equal(ev.conditions_met, true);
    assert.equal(ev.reference_price, "3000");
    assert.equal(ev.entered_at, at(0));
    assert.equal(ev.target_hit_at, at(31), "timed when the candle that touched it closed");
    assert.equal(ev.source, "feed:coingecko");
    assert.equal(ev.feed.pool, "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
    assert.equal(ev.attribution, ATTRIBUTION);
    assert.equal(ev.clock, undefined, "published in real time, so it is not marked as a replay");
    assert.equal(recorded(), 1, "recorded on the thesis token once");
  });

  test("a candle that touches both the target and the invalidation counts as invalidated", async () => {
    set(withCandle(steady(), start(10), 3000, 3110, 2890, 3000));
    const tokenId = await publish();
    pastDeadline();
    await loadDueCandles(srv.ctx);
    sweepEvaluations(srv.ctx);
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "invalidated");
    assert.equal(ev.conditions_met, false);
    assert.equal(ev.invalidated_at, at(11));
  });

  test("the candle a thesis was published in counts by its close only", async () => {
    // Its low went through the invalidation, but that may have been before the thesis was published.
    set(withCandle(withCandle(steady(), start(0), 3000, 3000, 2800, 3000), start(20), 3000, 3100, 3000, 3000));
    mock.timers.setTime(base + 30_000); // published half a minute into that candle
    const tokenId = await publish();
    pastDeadline();
    await loadDueCandles(srv.ctx);
    sweepEvaluations(srv.ctx);
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "target_hit");
    assert.equal(ev.target_hit_at, at(21));
  });

  test("with neither level touched, it is a miss at the deadline, judged on the last close", async () => {
    const tokenId = await publish();
    pastDeadline();
    await loadDueCandles(srv.ctx);
    sweepEvaluations(srv.ctx);
    const ev = await evaluation(tokenId);
    assert.equal(ev.outcome, "target_missed");
    assert.equal(ev.final_price, "3000");
    assert.equal(ev.prices_used, 61); // the price at publishing and one candle for each of the 60 minutes
  });
});

describe("a simulated fill in real time", () => {
  test("given no price, is made at the newest price the feed has, so it agrees with the evaluation of that moment", async () => {
    const tokenId = await publish();
    const bob = (await connectWallet(api, "bob.testnet")).session;
    await api("POST", "/v1/ledger/deposit", { key: bob, body: { amount_near: "1" } });
    const quote = await api("POST", "/v1/quotes", { key: bob, body: { token_id: tokenId } });
    const order = await api("POST", "/v1/orders", { key: bob, body: { quote_id: quote.body.quote_id, side: "buy", quantity: "1", authorise_fee: true } });
    assert.equal(order.status, 201, JSON.stringify(order.body));

    // Two minutes in, the price has moved. That candle is too recent to keep for the evaluation, but it is the price now.
    mock.timers.setTime(base + 2 * 60_000 + 15_000);
    set(withCandle(withCandle(steady(), start(1), 3000, 3020, 3000, 3020), start(2), 3020, 3031, 3020, 3030.5));
    const filled = await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: {} });
    assert.equal(filled.status, 201, JSON.stringify(filled.body));
    assert.equal(filled.body.event.price, "3030.5");
    assert.equal(fake.state.calls.at(-1)!.limit, 1, "one fresh request for the newest candle");

    // A price given by hand still wins.
    const closed = await api("POST", `/v1/sim/orders/${order.body.id}/close`, { body: { price: "3040" } });
    assert.equal(closed.body.event.price, "3040");
  });
});

describe("on NEAR", () => {
  test("the evaluation is queued for the thesis token with the feed as its source and plain decimal prices", async () => {
    const chainDb = openDb(":memory:");
    const contract: ChainClient = {
      contractId: "condex.testnet",
      async call() { return { txHash: "tx1" }; },
      async view() { throw new Error("no view is needed here"); },
    };
    const near = await startServer(
      { db: chainDb, market: new CoinGeckoMarketData(chainDb, "test-key", fake.fetcher), chainClient: contract, startChainSender: false },
      { ledger: "near", near: { contractId: "condex.testnet", operatorId: "operator.testnet", operatorKey: "ed25519:op", reporterId: "reporter.testnet", reporterKey: "ed25519:rep" } },
    );
    try {
      set(withCandle(steady(), start(30), 3000, 3105.5, 2995, 3050));
      const session = (await connectWallet(near.api, "alice.testnet")).session;
      const key = (await near.api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
      const tokenId = await publish(near.api, key);
      pastDeadline();
      await loadDueCandles(near.ctx);
      assert.equal(sweepEvaluations(near.ctx), 1);

      const queued = chainDb.prepare("SELECT signer, args FROM chain_outbox WHERE method = 'record_evaluation' AND ref = ?").get(tokenId) as { signer: string; args: string };
      assert.equal(queued.signer, "reporter");
      const args = JSON.parse(queued.args);
      assert.equal(args.source, "feed:coingecko");
      assert.equal(args.outcome, "target_hit");
      assert.equal(args.reference_price, "3000");
      assert.match(args.final_price, /^\d+(\.\d{1,18})?$/);
      assert.ok(args.target_hit_at <= Date.parse(at(60)), "the contract refuses an event after the deadline");
    } finally {
      await near.close();
    }
  });
});
