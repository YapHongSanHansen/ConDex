// The demo replay, end to end: 19 August 2026, 15:22 to 15:43 UTC, on the saved CoinGecko candles in
// demo/candles. The feed here has no API key, so anything that tried to reach the network would fail.
import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ATTRIBUTION } from "../src/market/coinGecko.ts";
import { buildMcpServer } from "../src/mcp/server.ts";
import { clearReplayClock } from "../src/util.ts";
import { ETH_MESSAGES, connectWallet, startServer, subscribe } from "./helpers.ts";

const srv = await startServer({}, {
  marketFeed: "coingecko", coinGeckoApiKey: null, marketSnapshots: fileURLToPath(new URL("../demo/candles", import.meta.url)),
});
const { api } = srv;

/** A moment on 19 August 2026, UTC. */
const utc = (time: string) => `2026-08-19T${time}.000Z`;
const clockTo = async (time: string) => {
  const r = await api("POST", "/v1/dev/clock", { body: { now: utc(time), market: "ETH-USD" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

/** Alice's thesis at 15:32: long from 2,072.65, right at 2,080, wrong at 2,050, tradable until 15:38, judged at 15:43. */
const PULLBACK_LONG = {
  title: "ETH: long the pullback", market: "ETH-USD", direction: "long",
  entry: "After the pullback from 2,089 holds above 2,060.", invalidation: "Support at 2,050 breaks.", target: "A retest of 2,080.",
  invalidation_price: "2050", target_price: "2080",
  expires_at: utc("15:38:00"), evaluation_deadline: utc("15:43:00"), fee_near: "0.1", messages: ETH_MESSAGES,
};

let s: { alice: string; bobSession: string; bobRead: string; bobTrade: string };

after(() => {
  clearReplayClock();
  return srv.close();
});
beforeEach(async () => {
  await api("POST", "/v1/dev/reset"); // also puts the clock back on real time
  // Everyone connects, pays and gets keys in real time, as on demo day before the replay starts.
  const aliceSession = (await connectWallet(api, "alice.testnet")).session;
  const bobSession = (await connectWallet(api, "bob.testnet")).session;
  await subscribe(api, bobSession);
  await api("POST", "/v1/ledger/deposit", { key: bobSession, body: { amount_near: "1" } });
  s = {
    alice: (await api("POST", "/v1/keys", { key: aliceSession, body: { scopes: ["publish", "read"] } })).body.secret,
    bobSession,
    bobRead: (await api("POST", "/v1/keys", { key: bobSession, body: { scopes: ["read"] } })).body.secret,
    bobTrade: (await api("POST", "/v1/keys", { key: bobSession, body: { scopes: ["trade"] } })).body.secret,
  };
});

async function publish(body: Record<string, unknown> = {}) {
  const r = await api("POST", "/v1/insights", { key: s.alice, body: { ...PULLBACK_LONG, ...body } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function buy(tokenId: string, extra: Record<string, unknown> = {}) {
  const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
  assert.equal(quote.status, 201, JSON.stringify(quote.body));
  const order = await api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "buy", quantity: "1", authorise_fee: true, ...extra } });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  return order.body;
}
const balance = async (account: string) => (await api("GET", `/v1/ledger/balances/${account}`)).body;

describe("replaying 19 August 2026", () => {
  test("the server starts with the saved window and judges on it", async () => {
    const health = (await api("GET", "/health")).body;
    assert.equal(health.market_data, "feed:coingecko");
    assert.deepEqual(health.clock.mode, "real");
  });

  test("Alice publishes at 23:32, Bob trades it, and ConDex judges it on the real candles", async () => {
    // 23:22 (UTC+8): Alice's agent looks at the market. It sees nothing after this moment.
    const early = await clockTo("15:22:00");
    assert.deepEqual({ mode: early.mode, now: early.now, fills: early.fills, evaluated: early.evaluated }, { mode: "replay", now: utc("15:22:00"), fills: [], evaluated: 0 });
    assert.equal(early.price.price, "2010.45");
    const seen = (await api("GET", "/v1/market/ETH-USD/candles", { key: s.alice })).body;
    assert.equal(seen.now, utc("15:22:00"));
    assert.equal(seen.clock, "replay");
    assert.equal(seen.complete, true);
    assert.equal(seen.attribution, ATTRIBUTION);
    assert.equal(seen.candles.length, 30);
    assert.deepEqual(seen.candles.at(-1), { at: utc("15:21:00"), open: "2009.39", high: "2010.45", low: "2009.39", close: "2010.45", volume: seen.candles.at(-1).volume });

    // 23:29: her first long, from 2,023.65 at 23:27, is up 2.57% (5.1% on margin at 2x).
    assert.equal((await clockTo("15:29:00")).price.price, "2075.62");

    // 23:32: she publishes, with the price back at 2,072.65.
    assert.equal((await clockTo("15:32:00")).price.price, "2072.65");
    const published = await publish();
    assert.equal(published.published_at, utc("15:32:00"));
    assert.equal(published.clock, "replay");
    assert.equal(published.expires_at, utc("15:38:00"));
    const tokenId = published.token_id as string;

    // 23:34: support held at 2,061.38. Bob reads the full thesis and buys. The fee is reserved, not yet paid.
    await clockTo("15:34:00");
    const read = await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.conditions.target_price, "2080");
    const order = await buy(tokenId);
    assert.equal(order.status, "open");
    assert.equal((await balance("bob.testnet")).reserved.near, "0.1");
    assert.equal((await balance("alice.testnet")).earned.near, "0");

    // 23:35: the order fills at the close of the first candle after it, and only now is Alice paid.
    const filled = await clockTo("15:35:00");
    assert.deepEqual(filled.fills, [{ order_id: order.id, at: utc("15:35:00"), price: "2065.39" }]);
    assert.equal((await balance("alice.testnet")).earned.near, "0.1");
    assert.equal((await balance("bob.testnet")).reserved.near, "0");

    // 23:38: the thesis can no longer be traded. 23:42: the target has been touched, and Bob asks to close.
    await clockTo("15:38:00");
    assert.equal((await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } })).body.error.code, "insight_expired");
    assert.equal((await clockTo("15:42:00")).evaluated, 0, "not judged before its deadline");
    const closing = await api("POST", `/v1/orders/${order.id}/close`, { key: s.bobTrade, body: {} });
    assert.equal(closing.status, 201, JSON.stringify(closing.body));

    // 23:43: the close fills, and the deadline has come, so the thesis is judged.
    const done = await clockTo("15:43:00");
    assert.deepEqual(done.fills, [{ order_id: closing.body.id, at: utc("15:43:00"), price: "2082.34" }]);
    assert.equal(done.evaluated, 1);

    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body;
    assert.equal(proof.proof_of_thesis.clock, "replay");
    const ev = proof.evaluation;
    assert.equal(ev.status, "evaluated");
    assert.equal(ev.outcome, "target_hit");
    assert.equal(ev.conditions_met, true);
    assert.equal(ev.reference_price, "2072.65");
    assert.equal(ev.target_hit_at, utc("15:41:00"), "the 23:40 candle's high of 2,082.38 reached 2,080");
    assert.equal(ev.source, "feed:coingecko");
    assert.equal(ev.feed.pool, "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
    assert.equal(ev.attribution, ATTRIBUTION);
    assert.equal(ev.clock, "replay");
    assert.equal(ev.evaluated_at, utc("15:43:00"));

    const [trade] = proof.proofs_of_trade;
    assert.equal(trade.trader, "bob.testnet");
    assert.deepEqual([trade.fill.price, trade.fill.at], ["2065.39", utc("15:35:00")]);
    assert.equal(trade.closing_fill.complete, true);
    assert.deepEqual(
      [trade.result.entry_price, trade.result.exit_price, trade.result.net_profit_usd, trade.result.net_return_pct],
      ["2065.39", "2082.34", 16.95, 0.82],
    );
    assert.equal(proof.verified_results.trades, 1);

    // Back to real time: the keys made before the replay still work, and Alice's page shows the result.
    assert.equal((await api("DELETE", "/v1/dev/clock")).body.mode, "real");
    assert.equal((await api("GET", "/v1/me", { key: s.bobTrade })).status, 200);
    const score = (await api("GET", "/v1/publishers/alice.testnet")).body.score;
    assert.deepEqual([score.accuracy.evaluated, score.accuracy.met], [1, 1]);
  });

  test("an order is not filled by a candle that closed before it was placed", async () => {
    await clockTo("15:32:00");
    const { token_id } = await publish();
    await clockTo("15:34:00");
    const order = await buy(token_id);
    assert.deepEqual((await clockTo("15:34:00")).fills, [], "setting the clock to the same moment fills nothing");
    assert.deepEqual((await clockTo("15:34:30")).fills, [], "no candle has closed since the order");
    assert.equal((await clockTo("15:35:00")).fills[0].order_id, order.id);
  });

  test("a limit order waits for a close at its price", async () => {
    await clockTo("15:30:00");
    const { token_id } = await publish({ target_price: "2095", expires_at: utc("15:50:00"), evaluation_deadline: utc("15:55:00") });
    await clockTo("15:31:00");
    const order = await buy(token_id, { limit_price: "2062" });
    assert.deepEqual((await clockTo("15:33:00")).fills, [], "2,072.65 and 2,066.46 are above the limit");
    assert.deepEqual((await clockTo("15:36:00")).fills, [{ order_id: order.id, at: utc("15:34:00"), price: "2061.38" }]);
  });

  test("a fill or close asked for without a price is made at the feed's price", async () => {
    await clockTo("15:32:00");
    const { token_id } = await publish();
    await clockTo("15:35:00");
    const order = await buy(token_id);
    const filled = await api("POST", `/v1/sim/orders/${order.id}/fill`, { body: {} });
    assert.equal(filled.status, 201, JSON.stringify(filled.body));
    assert.equal(filled.body.event.price, "2065.39");
    await clockTo("15:43:00");
    const closed = await api("POST", `/v1/sim/orders/${order.id}/close`, { body: {} });
    assert.equal(closed.body.event.price, "2082.34");
  });

  test("candles need a credential, never run past the replayed time, and survive a data reset", async () => {
    await clockTo("15:32:00");
    assert.equal((await api("GET", "/v1/market/ETH-USD/candles")).status, 401);
    const ahead = (await api("GET", `/v1/market/ETH-USD/candles?from=${utc("15:25:00")}&to=${utc("16:00:00")}`, { key: s.bobRead })).body;
    assert.equal(ahead.to, utc("15:32:00"));
    assert.equal(ahead.candles.at(-1).at, utc("15:31:00"));
    assert.equal(ahead.candles.length, 7);
    assert.equal((await api("GET", "/v1/market/ETH-USD/candles?from=soon", { key: s.bobRead })).body.error.code, "invalid_time");

    await api("POST", "/v1/dev/reset");
    assert.equal((await api("GET", "/v1/dev/clock")).body.mode, "real");
    const session = (await connectWallet(api, "carol.testnet")).session;
    const kept = (await api("GET", `/v1/market/ETH-USD/candles?from=${utc("15:25:00")}&to=${utc("15:32:00")}`, { key: session })).body;
    assert.equal(kept.clock, "real");
    assert.equal(kept.candles.length, 7, "the saved window is put back after a reset");
  });

  test("an agent reads the same candles through the MCP tool", async () => {
    await clockTo("15:32:00");
    const server = buildMcpServer({ apiUrl: srv.base, apiKey: s.alice });
    const client = new Client({ name: "alice-agent", version: "0.0.0" });
    const [c, t] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(t), client.connect(c)]);
    const result = await client.callTool({ name: "condex_get_candles", arguments: { market: "ETH-USD", from: utc("15:27:00") } }) as { content: Array<{ text: string }>; isError?: boolean };
    assert.ok(!result.isError, result.content[0]?.text);
    const body = JSON.parse(result.content[0]!.text);
    assert.equal(body.now, utc("15:32:00"));
    assert.equal(body.clock, "replay");
    assert.deepEqual(body.candles.map((k: { close: string }) => k.close), ["2032.45", "2075.62", "2089.09", "2081.46", "2072.65"]);
  });
});
