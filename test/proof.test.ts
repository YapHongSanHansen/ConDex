import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { ETH_THESIS, setupAliceAndBob, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;

let s: Awaited<ReturnType<typeof setupAliceAndBob>>;

after(() => srv.close());
beforeEach(async () => {
  await api("POST", "/v1/dev/reset");
  s = await setupAliceAndBob(api);
});

async function publishShort(overrides: Record<string, unknown> = {}) {
  const r = await api("POST", "/v1/insights", { key: s.alicePublish, body: { ...ETH_THESIS, title: "ETH short", ...overrides } });
  assert.equal(r.status, 201);
  return r.body.token_id as string;
}

async function trade(tokenId: string, body: Record<string, unknown> = {}) {
  const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } });
  return api("POST", "/v1/orders", {
    key: s.bobTrade,
    body: { quote_id: quote.body.quote_id, side: "sell", quantity: "2", authorise_fee: true, ...body },
  });
}

describe("the stored thesis is re-checked against its fingerprint", () => {
  test("the fingerprint covers the conditions, and a stored change is detected", async () => {
    const tokenId = await publishShort();
    const read = await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead });
    assert.equal(read.body.integrity.matches, true);
    assert.equal(read.body.integrity.recomputed_hash, read.body.content_hash);

    // Same conversation, different conditions: a different fingerprint.
    const other = await publishShort({ direction: "long" });
    const otherRead = await api("GET", `/v1/tokens/${other}`, { key: s.bobRead });
    assert.notEqual(otherRead.body.content_hash, read.body.content_hash);

    // Editing the stored conditions behind the API's back is caught.
    srv.ctx.db.prepare("UPDATE insight_versions SET invalidation = ? WHERE token_id = ?").run("never", tokenId);
    const tampered = await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead });
    assert.equal(tampered.body.integrity.matches, false);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proof_of_thesis.preserved, false);
  });

  test("a new version keeps the earlier version's conditions", async () => {
    const tokenId = await publishShort();
    const insightId = tokenId.replace(/-v1$/, "");
    const v2 = await api("POST", `/v1/insights/${insightId}/versions`, {
      key: s.alicePublish, body: { ...ETH_THESIS, title: "ETH short v2", entry: "new entry" },
    });
    assert.equal(v2.status, 201);
    const v1Read = await api("GET", `/v1/tokens/${tokenId}`, { key: s.bobRead });
    assert.equal(v1Read.body.conditions.entry, ETH_THESIS.entry);
    assert.equal(v1Read.body.integrity.matches, true);
  });
});

describe("proof of thesis and proof of trade", () => {
  test("the proof is public, shows the fingerprint, and leaks no conversation or conditions", async () => {
    const tokenId = await publishShort();
    const res = await api("GET", `/v1/tokens/${tokenId}/proof`);
    assert.equal(res.status, 200);
    const p = res.body.proof_of_thesis;
    assert.equal(p.token_id, tokenId);
    assert.equal(p.creator.near_account_id, "alice.testnet");
    assert.match(p.content_hash, /^[0-9a-f]{64}$/);
    assert.equal(p.preserved, true);
    assert.equal(p.usage_fee_per_filled_trade.near, "0.1");
    assert.ok(p.published_at);
    assert.equal(p.expiry.set_by, "creator");
    assert.deepEqual(res.body.proofs_of_trade, []);
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes(ETH_THESIS.entry) && !text.includes(ETH_THESIS.invalidation) && !text.includes("swept yesterday"));
  });

  test("a proof of trade appears on the first confirmed fill only, with the real fill", async () => {
    const tokenId = await publishShort();
    const order = await trade(tokenId);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade.length, 0);

    await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { quantity: "1", price: "3500" } });
    await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { quantity: "1", price: "3490" } });

    const proofs = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade;
    assert.equal(proofs.length, 1);
    const t = proofs[0];
    assert.equal(t.trader, "bob.testnet");
    assert.equal(t.role, "borrower");
    assert.equal(t.thesis.token_id, tokenId);
    assert.equal(t.order.market, "ETH-USD");
    assert.equal(t.order.side, "sell");
    assert.equal(t.fill.price, "3500");
    assert.equal(t.fill.quantity, "1");
    assert.equal(t.fill.source, "simulated");
    assert.equal(t.fee_paid.near, "0.1");
    assert.equal(t.closing_fill, null);
    assert.ok(t.settlement.tx);
  });

  test("a cancelled, unfilled order leaves no proof of trade", async () => {
    const tokenId = await publishShort();
    const order = await trade(tokenId);
    await api("POST", `/v1/sim/orders/${order.body.id}/cancel`);
    assert.equal((await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade.length, 0);
  });

  test("an unknown token has no proof", async () => {
    assert.equal((await api("GET", "/v1/tokens/nope-v1/proof")).status, 404);
  });
});
