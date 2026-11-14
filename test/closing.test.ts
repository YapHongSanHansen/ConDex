import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { ETH_THESIS, placeOrder, setupAliceAndBob, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;
const SECRET = { "x-execution-secret": "test-secret" };

let s: Awaited<ReturnType<typeof setupAliceAndBob>>;

after(() => srv.close());
beforeEach(async () => {
  await api("POST", "/v1/dev/reset");
  s = await setupAliceAndBob(api);
});

const fill = (id: string, quantity: string, price?: string) =>
  api("POST", `/v1/sim/orders/${id}/fill`, { body: { quantity, ...(price ? { price } : {}) } });
const proofOf = async (tokenId = s.tokenId) => (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade[0];

/** Bob sells 2 ETH-USD at 3500 on Alice's short thesis. */
async function openShort(price = "3500", quantity = "2") {
  const { order } = await placeOrder(api, s.bobTrade, s.tokenId, quantity);
  assert.equal(order.status, 201);
  await fill(order.body.id, quantity, price);
  return order.body.id as string;
}
const close = (orderId: string, body: Record<string, unknown> = {}, key = s.bobTrade) =>
  api("POST", `/v1/orders/${orderId}/close`, { key, body });

describe("closing a trade", () => {
  test("a short that is closed lower records a win, and the proof of trade carries the closing fill", async () => {
    const orderId = await openShort("3500");
    const closing = await close(orderId);
    assert.equal(closing.status, 201);
    assert.equal(closing.body.side, "buy");
    assert.equal(closing.body.quantity, "2");
    assert.equal(closing.body.status, "open");
    assert.match(closing.body.id, /^cls_/);

    // Open until the venue confirms a closing fill.
    assert.equal((await proofOf()).trade.status, "open");

    const done = await fill(closing.body.id, "2", "3400");
    assert.equal(done.status, 201);
    assert.equal(done.body.closing_order.status, "filled");
    assert.equal(done.body.trade.status, "closed");

    const proof = await proofOf();
    assert.equal(proof.trade.status, "closed");
    assert.equal(proof.trade.direction, "short");
    assert.equal(proof.trade.open_quantity, "0");
    assert.equal(proof.closing_fill.price, "3400");
    assert.equal(proof.closing_fill.quantity, "2");
    assert.equal(proof.closing_fill.source, "simulated");
    assert.deepEqual(proof.trade.result, {
      available: true, entry_price: "3500", exit_price: "3400", quantity: "2", pnl: "200", return_pct: "2.85714286", outcome: "win",
    });
  });

  test("a short closed higher records a loss", async () => {
    const orderId = await openShort("3500");
    const closing = await close(orderId);
    await fill(closing.body.id, "2", "3600");
    const { result } = (await proofOf()).trade;
    assert.equal(result.pnl, "-200");
    assert.equal(result.return_pct, "-2.85714286");
    assert.equal(result.outcome, "loss");
  });

  test("a long is closed with a sell and wins when the price rises", async () => {
    const longThesis = await api("POST", "/v1/insights", {
      key: s.alicePublish, body: { ...ETH_THESIS, title: "ETH long", direction: "long" },
    });
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: longThesis.body.token_id } });
    const order = await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "buy", quantity: "1", authorise_fee: true },
    });
    await fill(order.body.id, "1", "3000");
    const closing = await close(order.body.id);
    assert.equal(closing.body.side, "sell");
    await fill(closing.body.id, "1", "3300");
    const trade = (await proofOf(longThesis.body.token_id)).trade;
    assert.equal(trade.direction, "long");
    assert.equal(trade.result.pnl, "300");
    assert.equal(trade.result.return_pct, "10");
    assert.equal(trade.result.outcome, "win");
  });

  test("entry is the average of the opening fills, and a partial close is calculated on what was closed", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId, "2");
    await fill(order.body.id, "1", "3500");
    await fill(order.body.id, "1", "3490");

    const first = await close(order.body.id, { quantity: "1" });
    await fill(first.body.id, "1", "3395");
    let trade = (await proofOf()).trade;
    assert.equal(trade.status, "partially_closed");
    assert.equal(trade.open_quantity, "1");
    assert.equal(trade.closing_fill, null);
    assert.equal(trade.result.entry_price, "3495");
    assert.equal(trade.result.pnl, "100");

    const second = await close(order.body.id);
    assert.equal(second.body.quantity, "1");
    await fill(second.body.id, "1", "3405");
    trade = (await proofOf()).trade;
    assert.equal(trade.status, "closed");
    assert.equal(trade.closing_fills.length, 2);
    assert.equal(trade.result.exit_price, "3400");
    assert.equal(trade.result.pnl, "190");
    assert.equal(trade.closing_fill.price, "3405");
  });

  test("closing costs no fee and works after the thesis expired", async () => {
    const orderId = await openShort();
    const before = (await api("GET", "/v1/ledger/balances/bob.testnet")).body;
    srv.ctx.db.prepare("UPDATE insight_versions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE token_id = ?").run(s.tokenId);
    const closing = await close(orderId);
    assert.equal(closing.status, 201);
    await fill(closing.body.id, "2", "3400");
    const after = (await api("GET", "/v1/ledger/balances/bob.testnet")).body;
    assert.deepEqual(after, before);
    assert.equal((await proofOf()).trade.status, "closed");
  });

  test("a closing order that ends with no fill leaves the trade open and can be retried", async () => {
    const orderId = await openShort();
    const first = await close(orderId);
    await api("POST", `/v1/sim/orders/${first.body.id}/cancel`);
    assert.equal((await proofOf()).trade.status, "open");
    assert.equal((await proofOf()).trade.result, null);
    const retry = await close(orderId);
    assert.equal(retry.status, 201);
    await fill(retry.body.id, "2", "3400");
    assert.equal((await proofOf()).trade.status, "closed");
  });
});

describe("closing is refused when it makes no sense", () => {
  test("no confirmed fill yet, someone else's trade, or a key without trade scope", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    const early = await close(order.body.id);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "trade_not_open");

    await fill(order.body.id, "2", "3500");
    assert.equal((await close(order.body.id, {}, s.alicePublish)).status, 403);
    assert.equal((await close(order.body.id, {}, s.bobRead)).status, 403);
    assert.equal((await api("POST", `/v1/orders/${order.body.id}/close`)).status, 401);
    const alice = (await api("POST", "/v1/keys", { key: s.aliceSession, body: { scopes: ["trade"] } })).body.secret;
    assert.equal((await close(order.body.id, {}, alice)).status, 404);
  });

  test("more than is open, a second closing order in progress, and an already closed trade", async () => {
    const orderId = await openShort();
    const tooMuch = await close(orderId, { quantity: "3" });
    assert.equal(tooMuch.status, 400);
    assert.equal(tooMuch.body.error.code, "quantity_exceeds_open");

    const closing = await close(orderId, { quantity: "1" });
    const second = await close(orderId);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, "closing_in_progress");

    await fill(closing.body.id, "1", "3400");
    const rest = await close(orderId);
    await fill(rest.body.id, "1", "3400");
    const again = await close(orderId);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "already_closed");
  });

  test("a closing fill needs a price and cannot exceed the closing order", async () => {
    const orderId = await openShort();
    const closing = await close(orderId);
    const noPrice = await fill(closing.body.id, "2");
    assert.equal(noPrice.status, 400);
    assert.equal(noPrice.body.error.code, "price_required");
    const over = await fill(closing.body.id, "3", "3400");
    assert.equal(over.status, 400);
    assert.equal(over.body.error.code, "overfill");
    assert.equal((await proofOf()).trade.status, "open");
  });

  test("an opening fill with no price gives no result, and says why", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    await fill(order.body.id, "2");
    const closing = await close(order.body.id);
    await fill(closing.body.id, "2", "3400");
    const trade = (await proofOf()).trade;
    assert.equal(trade.status, "closed");
    assert.equal(trade.result.available, false);
    assert.match(trade.result.reason, /no price/);
  });
});

describe("closing fills are idempotent and can come from a live venue", () => {
  test("replaying a closing fill changes nothing", async () => {
    const orderId = await openShort();
    const closing = await close(orderId, { quantity: "1" });
    const f = await fill(closing.body.id, "1", "3400");
    const replay = await api("POST", `/v1/sim/events/${f.body.event.id}/replay`);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const trade = (await proofOf()).trade;
    assert.equal(trade.closed_quantity, "1");
    assert.equal(trade.closing_fills.length, 1);
  });

  test("the execution endpoint closes a trade with a live-venue source, and the proof says so", async () => {
    const orderId = await openShort();
    const closing = await close(orderId);
    const body = { event_id: "venue-close-1", order_id: closing.body.id, type: "fill", quantity: "2", price: "3380", source: "venue:acme" };
    const first = await api("POST", "/v1/execution/events", { headers: SECRET, body });
    assert.equal(first.status, 201);
    assert.equal((await api("POST", "/v1/execution/events", { headers: SECRET, body })).status, 200);
    assert.equal((await api("POST", "/v1/execution/events", { headers: SECRET, body: { ...body, type: "cancelled" } })).status, 409);
    const proof = await proofOf();
    assert.equal(proof.closing_fill.source, "venue:acme");
    assert.equal(proof.trade.result.pnl, "240");
  });

  test("an event id cannot be reused between an order and a closing order", async () => {
    const orderId = await openShort();
    const closing = await close(orderId);
    const body = { event_id: "shared-id", order_id: closing.body.id, type: "fill", quantity: "2", price: "3400", source: "venue:acme" };
    await api("POST", "/v1/execution/events", { headers: SECRET, body });
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    const clash = await api("POST", "/v1/execution/events", { headers: SECRET, body: { ...body, order_id: order.body.id } });
    assert.equal(clash.status, 409);
  });
});

describe("where the trade shows", () => {
  test("the borrower's order view shows the trade and its closing orders", async () => {
    const orderId = await openShort();
    const closing = await close(orderId);
    await fill(closing.body.id, "2", "3400");
    const order = (await api("GET", `/v1/orders/${orderId}`, { key: s.bobTrade })).body;
    assert.equal(order.trade.status, "closed");
    assert.equal(order.trade.result.outcome, "win");
    assert.equal(order.closing_orders.length, 1);
    assert.equal(order.closing_orders[0].id, closing.body.id);
    const view = await api("GET", `/v1/closing-orders/${closing.body.id}`, { key: s.bobTrade });
    assert.equal(view.body.fills.length, 1);
    const alice = (await api("POST", "/v1/keys", { key: s.aliceSession, body: { scopes: ["trade"] } })).body.secret;
    assert.equal((await api("GET", `/v1/closing-orders/${closing.body.id}`, { key: alice })).status, 404);
  });

  test("an order with no fill has no trade yet", async () => {
    const { order } = await placeOrder(api, s.bobTrade, s.tokenId);
    assert.equal(order.body.trade, null);
    assert.deepEqual(order.body.closing_orders, []);
  });
});
