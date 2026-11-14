import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import { ETH_THESIS, connectWallet, placeOrder, startServer, subscribe } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;

after(() => srv.close());
afterEach(() => mock.timers.reset());

const balance = async (account: string) => (await api("GET", `/v1/ledger/balances/${account}`)).body;

describe("reading: a free abstract, and a subscription for the full thesis", () => {
  beforeEach(() => api("POST", "/v1/dev/reset"));

  async function aliceThesis() {
    const alice = (await connectWallet(api, "alice.testnet")).session;
    const published = await api("POST", "/v1/insights", { key: alice, body: { ...ETH_THESIS, entry_price: "3500", invalidation_price: "3600" } });
    return { alice, tokenId: published.body.token_id as string };
  }

  test("without a subscription, the read is refused with the terms and nothing of the thesis", async () => {
    const { tokenId } = await aliceThesis();
    const carol = (await connectWallet(api, "carol.testnet")).session;
    const r = await api("GET", `/v1/tokens/${tokenId}`, { key: carol });
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, "subscription_required");
    assert.equal(r.body.error.details.fee.near, "1");
    assert.equal(r.body.error.details.period_days, 30);
    const text = JSON.stringify(r.body);
    for (const hidden of [ETH_THESIS.entry, ETH_THESIS.invalidation, "3500", "swept yesterday"]) assert.ok(!text.includes(hidden), hidden);
  });

  test("the abstract is public and carries the author's score and how to unlock", async () => {
    const { tokenId } = await aliceThesis();
    const abstract = (await api("GET", `/v1/tokens/${tokenId}/preview`)).body;
    assert.equal(abstract.title, ETH_THESIS.title);
    assert.equal(abstract.summary, ETH_THESIS.summary);
    assert.deepEqual(abstract.author_score, (await api("GET", "/v1/publishers/alice.testnet")).body.score);
    assert.equal(abstract.unlock.fee.near, "1");
    assert.equal(abstract.conditions, undefined);
    assert.equal(abstract.messages, undefined);
    const listed = (await api("GET", "/v1/tokens")).body.tokens[0];
    assert.deepEqual(listed.author_score, abstract.author_score);
  });

  test("the creator reads their own thesis without subscribing", async () => {
    const { alice, tokenId } = await aliceThesis();
    const r = await api("GET", `/v1/tokens/${tokenId}`, { key: alice });
    assert.equal(r.status, 200);
    assert.equal(r.body.subscription, null);
    assert.equal(r.body.conditions.entry_price, "3500");
  });

  test("subscribing pays ConDex's treasury from the ledger balance, and needs enough of it", async () => {
    const { tokenId } = await aliceThesis();
    const carol = (await connectWallet(api, "carol.testnet")).session;
    const poor = await api("POST", "/v1/subscription", { key: carol });
    assert.equal(poor.status, 402);
    assert.equal(poor.body.error.code, "insufficient_balance");
    assert.equal((await api("GET", "/v1/subscription", { key: carol })).body.active, false);

    await subscribe(api, carol);
    assert.equal((await balance("carol.testnet")).available.near, "0");
    assert.equal((await balance("condex-treasury.testnet")).earned.near, "1");
    assert.equal((await balance("alice.testnet")).earned.near, "0");
    const tx = (await api("GET", "/v1/ledger/txs")).body.txs.find((t: { method: string }) => t.method === "charge_subscription");
    assert.equal(tx.args.payee, "condex-treasury.testnet");

    const r = await api("GET", `/v1/tokens/${tokenId}`, { key: carol });
    assert.equal(r.status, 200);
    assert.equal(r.body.charge.yocto, "0");
    assert.equal(r.body.subscription.subscribed_until, (await api("GET", "/v1/subscription", { key: carol })).body.subscribed_until);
  });

  test("a read-only key cannot subscribe; a trade key can", async () => {
    const carol = (await connectWallet(api, "carol.testnet")).session;
    const read = (await api("POST", "/v1/keys", { key: carol, body: { scopes: ["read"] } })).body.secret;
    const trade = (await api("POST", "/v1/keys", { key: carol, body: { scopes: ["trade"] } })).body.secret;
    await api("POST", "/v1/ledger/deposit", { key: carol, body: { amount_near: "1" } });
    const denied = await api("POST", "/v1/subscription", { key: read });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, "missing_scope");
    assert.equal((await api("POST", "/v1/subscription", { key: trade })).status, 201);
  });

  test("access ends with the period; renewing early adds a period after the current one", async () => {
    // Starts now, so the thesis's expiry is still ahead when it is published.
    const t0 = Date.now();
    mock.timers.enable({ apis: ["Date"], now: t0 });
    const { tokenId } = await aliceThesis();
    const session = (await connectWallet(api, "carol.testnet")).session;
    // The wallet session lasts a day; a key lasts across the months below.
    const carol = (await api("POST", "/v1/keys", { key: session, body: { scopes: ["read", "trade"] } })).body.secret;
    await api("POST", "/v1/ledger/deposit", { key: session, body: { amount_near: "2" } });
    const day = 86_400_000;

    const first = await api("POST", "/v1/subscription", { key: carol });
    assert.equal(first.body.subscribed_until, new Date(t0 + 30 * day).toISOString());
    mock.timers.setTime(t0 + 10 * day);
    const renewed = await api("POST", "/v1/subscription", { key: carol });
    assert.equal(renewed.body.payment.starts_at, new Date(t0 + 30 * day).toISOString());
    assert.equal(renewed.body.subscribed_until, new Date(t0 + 60 * day).toISOString());

    mock.timers.setTime(t0 + 45 * day);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: carol })).status, 200);
    mock.timers.setTime(t0 + 60 * day);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: carol })).status, 402);
    assert.equal((await api("GET", "/v1/subscription", { key: carol })).body.active, false);
  });
});

describe("trading needs no subscription", () => {
  beforeEach(() => api("POST", "/v1/dev/reset"));

  test("a trader without a subscription can quote, order and pay the fee on the first fill", async () => {
    const alice = (await connectWallet(api, "alice.testnet")).session;
    const tokenId = (await api("POST", "/v1/insights", { key: alice, body: ETH_THESIS })).body.token_id as string;
    const dave = (await connectWallet(api, "dave.testnet")).session;
    const trade = (await api("POST", "/v1/keys", { key: dave, body: { scopes: ["trade"] } })).body.secret;
    await api("POST", "/v1/ledger/deposit", { key: dave, body: { amount_near: "1" } });
    assert.equal((await api("GET", "/v1/subscription", { key: dave })).body.active, false);

    const { order } = await placeOrder(api, trade, tokenId, "1");
    assert.equal(order.status, 201);
    const fill = await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { price: "3500" } });
    assert.equal(fill.body.event.effect, "settled");
    assert.equal((await balance("alice.testnet")).earned.near, "0.1");
    // Reading the full thesis still needs the subscription.
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: dave })).status, 402);
  });
});
