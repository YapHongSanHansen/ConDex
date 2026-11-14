// Walks the ConDex flow drawing (Excalidraw) step by step: Trader A connects a wallet, gets a publishing
// key, plugs it into their agent, publishes an ETH bullish thesis with an expiry date and time, ConDex
// keeps the proof of thesis and proof of trade, and another AI agent reads it and decides whether to trade.
// Steps the drawing asks for that are not built yet are `todo`: they run and report, but do not fail.
import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.ts";
import { ETH_MESSAGES, connectWallet, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;

// Only Date is mocked, so the thesis can reach its deadline in step 5 without waiting.
const T0 = Date.parse("2030-03-01T00:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000).toISOString();
before(() => mock.timers.enable({ apis: ["Date"], now: T0 }));
after(() => {
  mock.timers.reset();
  return srv.close();
});

function json(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: !!r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
}

async function agentWith(apiKey: string) {
  const server = buildMcpServer({ apiUrl: srv.base, apiKey });
  const client = new Client({ name: "trader-a-agent", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

const EXPIRY_DATE = at(48).slice(0, 10);
const BULLISH = {
  title: "ETH bullish continuation",
  market: "ETH-USD",
  direction: "long",
  entry: "A 1-hour close above 3,600 after the retest holds.",
  invalidation: "A 4-hour close back below 3,450.",
  target: "3,900.",
  entry_price: "3600",
  invalidation_price: "3450",
  target_price: "3900",
  expiry_date: EXPIRY_DATE,
  expiry_time: "14:30",
  fee_near: "0.1",
  messages: ETH_MESSAGES,
};

// Shared across the steps, in drawing order.
const s = {} as {
  aliceSession: string; publishKey: string; tokenId: string; contentHash: string;
  bobSession: string; bobRead: string; bobTrade: string; orderId: string;
};

describe("drawing: Trader A publishes, ConDex proves, an AI agent reads", () => {
  test("1. Trader A connects a wallet", async () => {
    const r = await connectWallet(api, "trader-a.testnet", { displayName: "Trader A" });
    assert.equal(r.verify.status, 201);
    assert.ok(r.session);
    s.aliceSession = r.session;
    const me = await api("GET", "/v1/me", { key: s.aliceSession });
    assert.equal(me.body.account.near_account_id, "trader-a.testnet");
  });

  test("2. Trader A finds a publishing API key, which only a wallet session can issue", async () => {
    assert.equal((await api("POST", "/v1/keys", { body: { scopes: ["publish"] } })).status, 401);
    const key = await api("POST", "/v1/keys", { key: s.aliceSession, body: { scopes: ["publish"], label: "MCP agent" } });
    assert.equal(key.status, 201);
    s.publishKey = key.body.secret;
  });

  test("3. the key plugged into the agent publishes an ETH bullish thesis with an expiry date and time", async () => {
    const agent = await agentWith(s.publishKey);
    const out = json(await agent.callTool({ name: "condex_publish_insight", arguments: BULLISH }));
    assert.equal(out.isError, false, String(out.body));
    assert.equal(out.body.direction, "long");
    assert.equal(out.body.expires_at, `${EXPIRY_DATE}T14:30:00.000Z`);
    assert.equal(out.body.expiry.set_by, "creator");
    assert.equal(out.body.expiry.time_given, true);
    s.tokenId = out.body.token_id;
    s.contentHash = out.body.content_hash;

    // A publishing key cannot trade, and the agent cannot publish without conditions.
    const noConditions = json(await agent.callTool({
      name: "condex_publish_insight",
      arguments: { title: "x", market: "ETH-USD", fee_near: "0.1", messages: ETH_MESSAGES },
    }));
    assert.equal(noConditions.isError, true);
  });

  test("tokenised on NEAR: one token per thesis, recording ownership, version and fee rules", async () => {
    const p = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis;
    assert.equal(p.token_id, s.tokenId);
    assert.equal(p.version, 1);
    assert.equal(p.creator.near_account_id, "trader-a.testnet");
    assert.equal(p.usage_fee_per_filled_trade.near, "0.1");
    const preview = (await api("GET", `/v1/tokens/${s.tokenId}/preview`)).body;
    assert.ok(preview.mint.tx, "a mint transaction is recorded");
    // The drawing's note: the token does not itself prove the PnL. Nothing PnL-like is minted.
    assert.ok(!/pnl|profit|return/i.test(JSON.stringify(p)));
  });

  test("record the thesis: publication timestamp, access expiry and trade evaluation deadline", async () => {
    const p = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis;
    assert.ok(Date.parse(p.published_at) <= Date.now());
    assert.equal(p.expires_at, `${EXPIRY_DATE}T14:30:00.000Z`);
  });

  test("record the access expiry separately from the trade evaluation deadline", async () => {
    const p = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis;
    // Without its own evaluation deadline, a thesis is judged up to its expiry.
    assert.equal(p.evaluation_deadline, p.expires_at);
    assert.equal(p.expiry.evaluation_deadline, p.expires_at);
  });

  test("4. proof of thesis: the original conditions are preserved", async () => {
    const proof = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body;
    assert.equal(proof.proof_of_thesis.preserved, true);
    assert.equal(proof.proof_of_thesis.content_hash, s.contentHash);

    // A new version gets its own token; the original conditions stay unchanged.
    const insightId = s.tokenId.replace(/-v1$/, "");
    const v2 = await api("POST", `/v1/insights/${insightId}/versions`, {
      key: s.publishKey, body: { ...BULLISH, entry: "Changed my mind" },
    });
    assert.equal(v2.status, 201);
    assert.notEqual(v2.body.token_id, s.tokenId);
    const v1 = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis;
    assert.equal(v1.content_hash, s.contentHash);
    assert.equal(v1.preserved, true);

    // Tampering with the stored conditions is detected.
    srv.ctx.db.prepare("UPDATE insight_versions SET entry = ? WHERE token_id = ?").run("tampered", s.tokenId);
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis.preserved, false);
    srv.ctx.db.prepare("UPDATE insight_versions SET entry = ? WHERE token_id = ?").run(BULLISH.entry, s.tokenId);
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proof_of_thesis.preserved, true);
  });

  test("AI agent calls the reading API; anyone can read the abstract and the author's accuracy, not the insight", async () => {
    const bob = await connectWallet(api, "bob-agent.testnet");
    s.bobSession = bob.session;
    s.bobRead = (await api("POST", "/v1/keys", { key: s.bobSession, body: { scopes: ["read"] } })).body.secret;
    s.bobTrade = (await api("POST", "/v1/keys", { key: s.bobSession, body: { scopes: ["trade"] } })).body.secret;
    await api("POST", "/v1/ledger/deposit", { key: s.bobSession, body: { amount_near: "2" } });

    // Public, no key: the abstract and publisher page show the author's accuracy, and no entry, invalidation,
    // levels or conversation.
    const preview = (await api("GET", `/v1/tokens/${s.tokenId}/preview`)).body;
    const profile = (await api("GET", "/v1/publishers/trader-a.testnet")).body;
    assert.equal(preview.title, BULLISH.title);
    assert.deepEqual(preview.author_score, profile.score);
    assert.ok("accuracy" in preview.author_score);
    for (const text of [JSON.stringify(preview), JSON.stringify(profile)]) {
      assert.ok(!text.includes(BULLISH.entry) && !text.includes(BULLISH.invalidation) && !text.includes("swept yesterday"));
      assert.ok(!text.includes("entry_price"));
    }
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}`)).status, 401);
  });

  test("the full insight is behind a subscription fee to ConDex", async () => {
    const locked = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead });
    assert.equal(locked.status, 402);
    assert.equal(locked.body.error.code, "subscription_required");
    assert.ok(!JSON.stringify(locked.body).includes(BULLISH.entry));
    // A read key cannot spend money, so it cannot subscribe.
    assert.equal((await api("POST", "/v1/subscription", { key: s.bobRead })).status, 403);

    const paid = await api("POST", "/v1/subscription", { key: s.bobSession });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.active, true);
    assert.equal(paid.body.payment.paid.near, "1");
    // The subscription goes to ConDex, not to the creator.
    assert.equal((await api("GET", "/v1/ledger/balances/condex-treasury.testnet")).body.earned.near, "1");
    assert.equal((await api("GET", "/v1/ledger/balances/trader-a.testnet")).body.earned.near, "0");
  });

  test("the user decides: with a subscription, reading costs nothing more, and walking away costs nothing", async () => {
    const before = (await api("GET", "/v1/ledger/balances/bob-agent.testnet")).body;
    for (let i = 0; i < 3; i++) {
      const read = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead });
      assert.equal(read.status, 200);
      assert.equal(read.body.charge.near, "0");
      assert.equal(read.body.conditions.entry, BULLISH.entry);
    }
    const after = (await api("GET", "/v1/ledger/balances/bob-agent.testnet")).body;
    assert.deepEqual(after, before);
    // A read key cannot trade.
    assert.equal((await api("POST", "/v1/quotes", { key: s.bobRead, body: { token_id: s.tokenId } })).status, 403);
  });

  test("if the trade is executed, only then is the fee charged", async () => {
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    assert.equal(quote.status, 201);
    // A sell does not match a bullish thesis.
    const wrongSide = await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true },
    });
    assert.equal(wrongSide.status, 409);
    assert.equal(wrongSide.body.error.code, "direction_mismatch");

    const quote2 = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    const order = await api("POST", "/v1/orders", {
      key: s.bobTrade, body: { quote_id: quote2.body.quote_id, side: "buy", quantity: "1", authorise_fee: true },
    });
    assert.equal(order.status, 201);
    s.orderId = order.body.id;
    assert.equal((await api("GET", "/v1/ledger/balances/trader-a.testnet")).body.earned.near, "0");

    await api("POST", `/v1/sim/orders/${s.orderId}/fill`, { body: { quantity: "1", price: "3610" } });
    assert.equal((await api("GET", "/v1/ledger/balances/trader-a.testnet")).body.earned.near, "0.1");
    assert.equal((await api("GET", "/v1/ledger/balances/bob-agent.testnet")).body.available.near, "0.9");
  });

  test("4. proof of trade: the fill is recorded on the thesis token", async () => {
    const trades = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proofs_of_trade;
    assert.equal(trades.length, 1);
    assert.equal(trades[0].trader, "bob-agent.testnet");
    assert.equal(trades[0].order.side, "buy");
    assert.equal(trades[0].fill.price, "3610");
    assert.equal(trades[0].fee_paid.near, "0.1");
  });

  test("5. the trade is closed, and the closing fill and its result are recorded", async () => {
    const closed = await api("POST", `/v1/sim/orders/${s.orderId}/close`, { body: { price: "3790" } });
    assert.equal(closed.status, 201);
    const trade = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.proofs_of_trade[0];
    assert.equal(trade.closing_fill.price, "3790");
    assert.equal(trade.closing_fill.complete, true);
    assert.equal(trade.result.net_profit_usd, 180);
    assert.equal(trade.result.net_return_pct, 4.99);
  });

  test("5. before the deadline the evaluation is pending", async () => {
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.evaluation.status, "pending");
  });

  test("5. ConDex evaluates the thesis against market data and records whether its conditions were met", async () => {
    for (const [h, price] of [[-1, "3550"], [3, "3620"], [20, "3920"]] as const) {
      await api("POST", "/v1/sim/market/ETH-USD/prices", { body: { price, at: at(h) } });
    }
    mock.timers.setTime(Date.parse(`${EXPIRY_DATE}T14:31:00.000Z`));
    const ev = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body.evaluation;
    assert.equal(ev.status, "evaluated");
    assert.equal(ev.outcome, "target_hit");
    assert.equal(ev.conditions_met, true);
    assert.equal(ev.target_hit_at, at(20));
  });

  test("5. the author's record uses Net Return %, Net Profit ($) and Maximum drawdown %, not a reputation score", async () => {
    const proof = (await api("GET", `/v1/tokens/${s.tokenId}/proof`)).body;
    assert.deepEqual({ ...proof.verified_results, costs: undefined }, {
      trades: 1, net_return_pct: 4.99, net_profit_usd: 180, max_drawdown_pct: 0, costs: undefined,
    });
    const score = (await api("GET", "/v1/publishers/trader-a.testnet")).body.score;
    assert.deepEqual(score.borrowers, proof.verified_results);
    assert.ok(!/reputation/i.test(JSON.stringify(score)));
  });

  test("5. the accuracy of the author's theses is reported", async () => {
    // Both versions (v1 and the v2 from step 4) share the same levels and market, so both met their conditions.
    const { accuracy } = (await api("GET", "/v1/publishers/trader-a.testnet")).body.score;
    assert.deepEqual(accuracy, { evaluated: 2, met: 2, accuracy_pct: 100, pending: 0, not_judged: 0 });
  });

  test("after the expiry, subscribers can still read but no new trade can be linked", async () => {
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).status, 200);
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    assert.equal(quote.status, 409);
  });
});
