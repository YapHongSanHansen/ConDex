// The API on the NEAR contract (CONDEX_LEDGER=near), against a stand-in contract: what ConDex signs is queued
// and sent in order, and what only the trader can sign (subscribe, reserve_fee) is read from the contract.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { orderHash } from "../src/near/chain.ts";
import { type ChainClient, ContractRefused, type Signer } from "../src/near/chainClient.ts";
import { ETH_THESIS, connectWallet, startServer } from "./helpers.ts";

/** Records every call ConDex signs and answers the views the API reads. */
class FakeContract implements ChainClient {
  readonly contractId = "condex.testnet";
  calls: Array<{ signer: string; method: string; args: any }> = [];
  views: Array<{ method: string; args: any }> = [];
  subscriptions = new Map<string, number>();
  reserves = new Map<string, object>();
  failNext: Error[] = [];
  private seq = 0;

  async call(signer: Signer, method: string, args: object) {
    const failure = this.failNext.shift();
    if (failure) throw failure;
    this.calls.push({ signer: signer.accountId, method, args });
    return { txHash: `tx${++this.seq}` };
  }

  async view<T>(method: string, args: any): Promise<T> {
    this.views.push({ method, args });
    if (method === "subscription_of") {
      const until = this.subscriptions.get(args.account_id) ?? 0;
      return { account_id: args.account_id, subscribed_until: until, active: until > Date.now(), price: "1000000000000000000000000", period: 2592000000 } as T;
    }
    if (method === "get_reserve") return (this.reserves.get(args.order_id) ?? null) as T;
    if (method === "balance_of") return { account_id: args.account_id, available: "5", reserved: "1", earned_total: "2" } as T;
    throw new Error(`unexpected view ${method}`);
  }
}

const chain = new FakeContract();
const srv = await startServer(
  { chainClient: chain, startChainSender: false },
  {
    ledger: "near",
    near: { contractId: "condex.testnet", operatorId: "operator.testnet", operatorKey: "ed25519:op", reporterId: "reporter.testnet", reporterKey: "ed25519:rep" },
  },
);
const { api } = srv;
const drain = () => srv.ctx.chain!.sender.drain();
const SECRET = { "x-execution-secret": "test-secret" };

let alice: string; let alicePublish: string; let bob: string; let tokenId: string;

before(async () => {
  alice = (await connectWallet(api, "alice.testnet")).session;
  bob = (await connectWallet(api, "bob.testnet")).session;
  alicePublish = (await api("POST", "/v1/keys", { key: alice, body: { scopes: ["publish"] } })).body.secret;
});
after(() => srv.close());

async function newOrder(quantity = "2") {
  const quote = await api("POST", "/v1/quotes", { key: bob, body: { token_id: tokenId } });
  const order = await api("POST", "/v1/orders", { key: bob, body: { quote_id: quote.body.quote_id, side: "sell", quantity, authorise_fee: true } });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  return order.body;
}

/** What the trader's own reserve_fee leaves on the contract. */
function approveOnChain(order: { id: string; approval: { args: { order_hash: string } } }, change: object = {}) {
  chain.reserves.set(order.id, {
    order_id: order.id, token_id: tokenId, payer: "bob.testnet", amount: "100000000000000000000000",
    order_hash: order.approval.args.order_hash, status: "reserved", ...change,
  });
}

describe("ConDex's own calls are queued and sent in order", () => {
  test("publishing queues mint_thesis, and the sent tx hash replaces the pending one", async () => {
    const published = await api("POST", "/v1/insights", { key: alicePublish, body: ETH_THESIS });
    assert.equal(published.status, 201);
    tokenId = published.body.token_id;
    assert.match(published.body.mint.tx, /^pending:/);
    assert.equal(published.body.mint.ledger, "near-testnet");
    assert.equal(chain.calls.length, 0, "nothing is sent inside the request");

    await drain();
    const mint = chain.calls.find((c) => c.method === "mint_thesis")!;
    assert.equal(mint.signer, "operator.testnet");
    assert.equal(mint.args.token_id, tokenId);
    assert.equal(mint.args.owner, "alice.testnet");
    assert.equal(mint.args.fee, "100000000000000000000000");
    assert.equal(mint.args.content_hash, published.body.content_hash);
    assert.equal(mint.args.expires_at, Date.parse(published.body.expires_at), "times go to NEAR as Unix milliseconds");
    assert.equal(mint.args.expiry_set_by, "creator");
    assert.match((await api("GET", `/v1/tokens/${tokenId}/preview`)).body.mint.tx, /^tx\d+$/);
  });

  test("a network error is retried in place; a call the contract refuses is marked failed and the queue moves on", async () => {
    const before = chain.calls.length;
    chain.failNext.push(new Error("socket hang up"), new ContractRefused("Smart contract panicked: Token exists"));
    await api("POST", "/v1/insights", { key: alicePublish, body: { ...ETH_THESIS, title: "second" } });
    await api("POST", "/v1/insights", { key: alicePublish, body: { ...ETH_THESIS, title: "third" } });
    await drain();
    const outbox = (await api("GET", "/v1/chain/outbox")).body.calls as Array<{ status: string; attempts: number; error: string | null }>;
    const [third, second] = outbox;
    assert.equal(second!.status, "failed");
    assert.match(second!.error!, /panicked/);
    assert.equal(second!.attempts, 2, "first a network error, then the refusal");
    assert.equal(third!.status, "sent");
    assert.equal(chain.calls.length, before + 1);
  });
});

describe("what the trader signs is read from the contract", () => {
  test("the subscription comes from subscription_of, and paying it is the trader's own call", async () => {
    assert.equal((await api("GET", `/v1/tokens/${tokenId}`, { key: bob })).status, 402);
    const pay = await api("POST", "/v1/subscription", { key: bob });
    assert.equal(pay.status, 409);
    assert.equal(pay.body.error.code, "sign_on_chain");
    assert.equal(pay.body.error.details.method, "subscribe");
    assert.equal(pay.body.error.details.attached_deposit.near, "1");

    chain.subscriptions.set("bob.testnet", Date.now() + 86_400_000);
    // Bob's earlier answer is cached for 30 seconds; a fresh check sees the subscription.
    await srv.ctx.chain!.refreshSubscription("bob.testnet", true);
    const read = await api("GET", `/v1/tokens/${tokenId}`, { key: bob });
    assert.equal(read.status, 200);
    const status = (await api("GET", "/v1/subscription", { key: bob })).body;
    assert.equal(status.active, true);
    assert.equal(status.terms.paid_to, "condex.testnet");
    const asked = chain.views.filter((v) => v.method === "subscription_of" && v.args.account_id === "bob.testnet").length;
    await api("GET", `/v1/tokens/${tokenId}`, { key: bob });
    assert.equal(chain.views.filter((v) => v.method === "subscription_of" && v.args.account_id === "bob.testnet").length, asked, "read again from the cache");
  });

  test("balances are the contract's balance_of; deposits are made on the contract", async () => {
    const b = (await api("GET", "/v1/ledger/balances/bob.testnet")).body;
    assert.deepEqual([b.ledger, b.available.yocto, b.reserved.yocto, b.earned.yocto], ["near-testnet", "5", "1", "2"]);
    assert.equal((await api("POST", "/v1/ledger/deposit", { key: bob, body: { amount_near: "1" } })).status, 403);
  });
});

describe("an order waits for the trader's own approval on the contract", () => {
  let orderId: string;

  test("the order comes back awaiting approval, with the reserve_fee call to sign, and is not submitted", async () => {
    const order = await newOrder();
    orderId = order.id;
    assert.equal(order.status, "awaiting_approval");
    assert.equal(order.settlement.reserve, null);
    assert.deepEqual(order.approval.args, {
      order_id: order.id, token_id: tokenId, fee: "100000000000000000000000",
      order_hash: orderHash({ orderId: order.id, tokenId, market: "ETH-USD", side: "sell", quantity: "2" }),
    });
    assert.equal(order.approval.contract, "condex.testnet");
    const fill = await api("POST", `/v1/sim/orders/${order.id}/fill`, { body: { price: "3500" } });
    assert.equal(fill.status, 409);
    assert.equal(fill.body.error.code, "not_submitted");
  });

  test("confirming checks the payer, fee and order fingerprint on the contract", async () => {
    const confirm = () => api("POST", `/v1/orders/${orderId}/confirm-approval`, { key: bob });
    assert.equal((await confirm()).body.error.code, "approval_missing");
    const order = (await api("GET", `/v1/orders/${orderId}`, { key: bob })).body;
    for (const wrong of [{ payer: "mallory.testnet" }, { amount: "1" }, { order_hash: "0".repeat(64) }, { status: "released" }]) {
      approveOnChain(order, wrong);
      const r = await confirm();
      assert.equal(r.status, 409, JSON.stringify(wrong));
      assert.equal(r.body.error.code, "approval_mismatch");
    }
    approveOnChain(order);
    const ok = await confirm();
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "open", "submitted to the venue and accepted");
    assert.equal(ok.body.settlement.reserve.status, "reserved");
    assert.equal((await confirm()).body.status, "open", "confirming again changes nothing");
  });

  test("the first fill queues settle_fee with the proof the contract checks; a close queues record_close", async () => {
    await api("POST", `/v1/sim/orders/${orderId}/fill`, { body: { quantity: "2", price: "3500" } });
    await api("POST", `/v1/sim/orders/${orderId}/close`, { body: { price: "3400" } });
    await drain();
    const settle = chain.calls.find((c) => c.method === "settle_fee")!;
    assert.equal(settle.signer, "reporter.testnet");
    assert.equal(settle.args.order_id, orderId);
    assert.deepEqual({ ...settle.args.proof, fill: { ...settle.args.proof.fill, event_id: undefined, at: undefined } }, {
      market: "ETH-USD", side: "sell", quantity: "2",
      fill: { event_id: undefined, at: undefined, price: "3500", quantity: "2", source: "simulated" },
    });
    assert.equal(typeof settle.args.proof.fill.at, "number");
    const close = chain.calls.find((c) => c.method === "record_close")!;
    assert.deepEqual([close.signer, close.args.order_id, close.args.quantity, close.args.price], ["reporter.testnet", orderId, "2", "3400"]);
    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body.proofs_of_trade[0];
    assert.equal(proof.settlement.tx, `tx${chain.calls.indexOf(settle) + 1}`, "the receipt shows the real tx hash once sent");
  });

  test("an approved order that ends with no fill queues release_fee", async () => {
    const order = await newOrder("1");
    approveOnChain(order);
    await api("POST", `/v1/orders/${order.id}/confirm-approval`, { key: bob });
    await api("POST", "/v1/execution/events", {
      headers: SECRET, body: { event_id: "evt-cancel-1", order_id: order.id, type: "cancelled", source: "venue:testex" },
    });
    await drain();
    const release = chain.calls.find((c) => c.method === "release_fee" && c.args.order_id === order.id);
    assert.equal(release?.signer, "reporter.testnet");
  });
});
