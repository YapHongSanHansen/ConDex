import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { ETH_MESSAGES, ETH_THESIS, connectWallet, placeOrder, setupAliceAndBob, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;
const SECRET = { "x-execution-secret": "test-secret" };

let s: Awaited<ReturnType<typeof setupAliceAndBob>>;

after(() => srv.close());
beforeEach(async () => {
  await api("POST", "/v1/dev/reset");
  s = await setupAliceAndBob(api);
});

const balance = async (account: string) => (await api("GET", `/v1/ledger/balances/${account}`)).body;

describe("README demo checklist", () => {
  test("1. publish a selected conversation and mint its token", async () => {
    const p = s.published;
    assert.equal(p.status, 201);
    assert.match(s.tokenId, /^ins_.+-v1$/);
    assert.equal(p.body.fee_per_filled_order.near, "0.1");
    assert.equal(p.body.unlock.fee.near, "1");
    assert.equal(p.body.mint.ledger, "mock");
    assert.match(p.body.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(p.body.payout_account, "alice.testnet");

    // The public preview never includes the messages.
    const preview = await api("GET", `/v1/tokens/${s.tokenId}/preview`);
    assert.equal(preview.body.message_count, 2);
    assert.equal(preview.body.messages, undefined);
    assert.equal(preview.body.author_score.borrowers.trades, 0);

    const txs = (await api("GET", "/v1/ledger/txs")).body.txs;
    assert.ok(txs.some((t: { method: string; args: { token_id?: string } }) => t.method === "mint_insight_token" && t.args.token_id === s.tokenId));
  });

  test("2. with a subscription, read twice with a borrower credential and pay nothing more", async () => {
    const before = await balance("bob.testnet");
    const r1 = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead });
    const r2 = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body.messages, ETH_MESSAGES);
    assert.equal(r2.body.charge.yocto, "0");
    assert.equal(r2.body.your_reads.count, 2);
    assert.equal(r2.body.your_reads.total_charged.yocto, "0");
    assert.deepEqual(await balance("bob.testnet"), before);
  });

  test("3. cancelled unfilled order releases the reserved fee", async () => {
    const { quote, order } = await placeOrder(api, s.bobTrade, s.tokenId);
    assert.equal(quote.status, 201);
    assert.equal(quote.body.fee.near, "0.1");
    assert.equal(order.status, 201);
    assert.equal(order.body.status, "open");
    assert.equal(order.body.settlement.status, "pending");
    assert.equal(order.body.settlement.reserve.status, "reserved");
    let bob = await balance("bob.testnet");
    assert.equal(bob.available.near, "0.9");
    assert.equal(bob.reserved.near, "0.1");

    const cancel = await api("POST", `/v1/sim/orders/${order.body.id}/cancel`);
    assert.equal(cancel.body.event.effect, "released");
    assert.equal(cancel.body.order.status, "cancelled");
    assert.equal(cancel.body.order.settlement.status, "released");

    bob = await balance("bob.testnet");
    assert.equal(bob.available.near, "1");
    assert.equal(bob.reserved.near, "0");
    assert.equal((await balance("alice.testnet")).earned.near, "0");
  });

  test("4. partial fill pays once; later fills, replays and cancel do not pay again", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId, "2");
    const orderId = order.body.id;

    const fill1 = await api("POST", `/v1/sim/orders/${orderId}/fill`, { body: { quantity: "0.5", price: "3500" } });
    assert.equal(fill1.body.event.effect, "settled");
    assert.equal(fill1.body.order.status, "partially_filled");
    assert.equal(fill1.body.order.settlement.status, "settled");
    const receipt = fill1.body.receipt;
    assert.ok(receipt.id);
    assert.equal(receipt.evidence_source, "simulated");
    assert.match(receipt.evidence_label, /Simulated/);

    const replay = await api("POST", `/v1/sim/events/${fill1.body.event.id}/replay`);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.receipt.id, receipt.id);

    const fill2 = await api("POST", `/v1/sim/orders/${orderId}/fill`, { body: { quantity: "0.5" } });
    assert.equal(fill2.body.event.effect, "fill_same_receipt");
    assert.equal(fill2.body.receipt.id, receipt.id);

    const cancel = await api("POST", `/v1/sim/orders/${orderId}/cancel`);
    assert.equal(cancel.body.event.effect, "closed_after_fill");
    assert.equal(cancel.body.order.filled_quantity, "1");

    assert.equal((await balance("alice.testnet")).earned.near, "0.1");
    const bob = await balance("bob.testnet");
    assert.equal(bob.available.near, "0.9");
    assert.equal(bob.reserved.near, "0");

    const settles = (await api("GET", "/v1/ledger/txs")).body.txs.filter((t: { method: string }) => t.method === "settle_fee");
    assert.equal(settles.length, 1);

    const receipts = (await api("GET", "/v1/receipts", { key: s.aliceSession })).body.receipts;
    assert.equal(receipts.length, 1);
  });

  test("5. a live venue event through the execution endpoint is labelled as live evidence", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId, "1");
    const body = { event_id: "venue-evt-1", order_id: order.body.id, type: "fill", quantity: "1", price: "3490", source: "venue:testex" };
    const first = await api("POST", "/v1/execution/events", { body, headers: SECRET });
    assert.equal(first.status, 201);
    assert.equal(first.body.order.status, "filled");
    assert.equal(first.body.receipt.evidence_source, "venue:testex");
    assert.match(first.body.receipt.evidence_label, /Live venue/);

    const again = await api("POST", "/v1/execution/events", { body, headers: SECRET });
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal((await balance("alice.testnet")).earned.near, "0.1");

    const noSecret = await api("POST", "/v1/execution/events", { body });
    assert.equal(noSecret.status, 401);
  });
});

describe("settlement edge cases", () => {
  test("rejected and expired orders with no fills release the reserve", async () => {
    for (const action of ["reject", "expire"]) {
      const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
      const r = await api("POST", `/v1/sim/orders/${order.body.id}/${action}`);
      assert.equal(r.body.event.effect, "released", action);
    }
    assert.equal((await balance("bob.testnet")).available.near, "1");
  });

  test("unknown venue status keeps settlement pending", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    const r = await api("POST", `/v1/sim/orders/${order.body.id}/unknown`);
    assert.equal(r.body.event.effect, "settlement_pending");
    assert.equal(r.body.order.settlement.status, "pending");
    assert.equal(r.body.order.venue.status_known, false);
    assert.equal((await balance("bob.testnet")).reserved.near, "0.1");
  });

  test("a fill after release is flagged and pays nothing", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    await api("POST", `/v1/sim/orders/${order.body.id}/cancel`);
    const late = await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { quantity: "1" } });
    assert.equal(late.body.event.effect, "fill_after_release");
    assert.equal((await balance("alice.testnet")).earned.near, "0");
  });

  test("overfill is refused", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId, "1");
    const r = await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { quantity: "1.5" } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "overfill");
  });
});

describe("permissions and validation", () => {
  test("a read key cannot trade and a trade key cannot read", async () => {
    const q = await api("POST", "/v1/quotes", { key: s.bobRead, body: { token_id: s.tokenId } });
    assert.equal(q.status, 403);
    assert.equal(q.body.error.code, "missing_scope");
    const r = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobTrade });
    assert.equal(r.status, 403);
  });

  test("a read key scoped to other tokens is refused", async () => {
    const scoped = await api("POST", "/v1/keys", { key: s.bobSession, body: { scopes: ["read"], token_ids: ["ins_other-v1"] } });
    const r = await api("GET", `/v1/tokens/${s.tokenId}`, { key: scoped.body.secret });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "token_not_in_scope");
  });

  test("revoked keys stop working", async () => {
    const keys = (await api("GET", "/v1/keys", { key: s.bobSession })).body.keys;
    const readKey = keys.find((k: { label: string }) => k.label === "bob research");
    assert.equal((await api("DELETE", `/v1/keys/${readKey.id}`, { key: s.bobSession })).status, 200);
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).status, 401);
  });

  test("creators cannot link orders to their own insight", async () => {
    const r = await api("POST", "/v1/quotes", { key: s.aliceSession, body: { token_id: s.tokenId } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "self_link");
  });

  test("orders need explicit fee authorisation, a fresh quote and enough balance", async () => {
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    const noAuth = await api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: false } });
    assert.equal(noAuth.body.error.code, "fee_not_authorised");

    const ok = await api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true } });
    assert.equal(ok.status, 201);
    const reuse = await api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true } });
    assert.equal(reuse.body.error.code, "quote_used");

    const pricey = await api("POST", "/v1/insights", { key: s.alicePublish, body: { ...ETH_THESIS, title: "Pricey", market: "BTC-USD", fee_near: "5" } });
    const { order } = await placeOrder(api, s.bobTrade, pricey.body.token_id);
    assert.equal(order.status, 402);
    assert.equal(order.body.error.code, "insufficient_balance");
  });

  test("new versions get new tokens and only the creator can publish them", async () => {
    const v2 = await api("POST", `/v1/insights/${s.published.body.insight_id}/versions`, {
      key: s.alicePublish, body: { ...ETH_THESIS, title: "ETH failed breakout (updated)", fee_near: "0.2" },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version, 2);
    assert.notEqual(v2.body.token_id, s.tokenId);
    assert.notEqual(v2.body.content_hash, s.published.body.content_hash);

    const bobPublish = (await api("POST", "/v1/keys", { key: s.bobSession, body: { scopes: ["publish"] } })).body.secret;
    const denied = await api("POST", `/v1/insights/${s.published.body.insight_id}/versions`, {
      key: bobPublish, body: { ...ETH_THESIS, title: "hijack", fee_near: "0" },
    });
    assert.equal(denied.status, 403);
  });

  test("bad input returns 400 with a reason", async () => {
    const r = await api("POST", "/v1/insights", { key: s.alicePublish, body: { title: "", fee_near: "abc", messages: [] } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "invalid_request");
    const badAcct = await connectWallet(api, "Not Valid!");
    assert.equal(badAcct.verify.body.error.code, "invalid_near_account");
    const expired = await api("POST", "/v1/insights", {
      key: s.alicePublish, body: { ...ETH_THESIS, title: "old", expiry_date: "2020-01-01" },
    });
    assert.equal(expired.body.error.code, "invalid_expiry");
  });
});
