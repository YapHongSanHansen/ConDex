// The two clocks. The business clock times theses, quotes and orders, and in dev mode can be frozen at a past
// moment to replay a market window. Sign-in, API keys and subscriptions stay on real time throughout.
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, mock, test } from "node:test";
import type { ChainClient } from "../src/near/chainClient.ts";
import { clearReplayClock, nowIso, replayClock, setReplayClock, systemNowIso } from "../src/util.ts";
import { ETH_MESSAGES, connectWallet, startServer, subscribe } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;

/** A moment long past: the replay in these tests happens "then". */
const THEN = "2026-05-15T02:00:00.000Z";
const then = (minutes: number) => new Date(Date.parse(THEN) + minutes * 60_000).toISOString();
const setClock = (now: string) => api("POST", "/v1/dev/clock", { body: { now } });
const thesis = (expiresAt: string) => ({
  title: "ETH short", market: "ETH-USD", direction: "short", entry: "At the market.", invalidation: "Ten percent higher.",
  expires_at: expiresAt, fee_near: "0.1", messages: ETH_MESSAGES,
});

after(() => srv.close());
beforeEach(async () => {
  await api("POST", "/v1/dev/reset");
});
afterEach(() => {
  mock.timers.reset();
  clearReplayClock(); // the clock belongs to the whole process, so no test may leave it set
});

describe("the two clocks", () => {
  test("a replay freezes the business clock and leaves real time alone", () => {
    assert.equal(replayClock(), null);
    setReplayClock(Date.parse(THEN));
    assert.equal(nowIso(), THEN);
    assert.equal(replayClock(), THEN);
    assert.ok(Math.abs(Date.parse(systemNowIso()) - Date.now()) < 5000);
    clearReplayClock();
    assert.ok(Math.abs(Date.parse(nowIso()) - Date.now()) < 5000);
  });

  test("the dev routes set it, show it and clear it, and a data reset clears it too", async () => {
    assert.equal((await api("GET", "/v1/dev/clock")).body.mode, "real");
    const set = await setClock(THEN);
    assert.equal(set.status, 200);
    assert.deepEqual(set.body, { mode: "replay", now: THEN, fills: [], evaluated: 0 });
    assert.deepEqual((await api("GET", "/health")).body.clock, { mode: "replay", now: THEN });
    assert.equal((await api("GET", "/health")).body.market_data, "simulated");

    assert.equal((await api("DELETE", "/v1/dev/clock")).body.mode, "real");
    await setClock(THEN);
    await api("POST", "/v1/dev/reset");
    assert.equal((await api("GET", "/v1/dev/clock")).body.mode, "real");
  });

  test("it only goes to the past, and only takes a full time", async () => {
    const future = await setClock(new Date(Date.now() + 3_600_000).toISOString());
    assert.equal(future.status, 400);
    assert.equal(future.body.error.code, "clock_in_future");
    assert.equal((await setClock("yesterday")).status, 400);
    assert.equal((await api("GET", "/v1/dev/clock")).body.mode, "real");
  });

  test("it exists in dev mode only", async () => {
    const live = await startServer({}, { devMode: false });
    try {
      assert.equal((await live.api("GET", "/v1/dev/clock")).status, 404);
      assert.equal((await live.api("POST", "/v1/dev/clock", { body: { now: THEN } })).status, 404);
    } finally {
      await live.close();
    }
  });

  test("it is refused on NEAR, whose own clock cannot be moved", async () => {
    const contract: ChainClient = {
      contractId: "condex.testnet",
      async call() { return { txHash: "tx1" }; },
      async view() { throw new Error("no view is needed here"); },
    };
    const near = await startServer(
      { chainClient: contract, startChainSender: false },
      { ledger: "near", near: { contractId: "condex.testnet", operatorId: "operator.testnet", operatorKey: "ed25519:op", reporterId: "reporter.testnet", reporterKey: "ed25519:rep" } },
    );
    try {
      const refused = await near.api("POST", "/v1/dev/clock", { body: { now: THEN } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, "replay_needs_mock_ledger");
      assert.equal(replayClock(), null);
    } finally {
      await near.close();
    }
  });
});

describe("during a replay", () => {
  test("publishing, the expiry check and quotes happen at the replayed time", async () => {
    const alice = (await connectWallet(api, "alice.testnet")).session;
    const bob = (await connectWallet(api, "bob.testnet")).session;
    await api("POST", "/v1/ledger/deposit", { key: bob, body: { amount_near: "1" } });
    await setClock(THEN);

    // An expiry half an hour after the replayed moment is in the future there, though long past in real time.
    const published = await api("POST", "/v1/insights", { key: alice, body: thesis(then(30)) });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.equal(published.body.published_at, THEN);
    assert.equal(published.body.clock, "replay");
    const tokenId = published.body.token_id;

    const tooEarly = await api("POST", "/v1/insights", { key: alice, body: thesis(then(-1)) });
    assert.equal(tooEarly.status, 400);
    assert.equal(tooEarly.body.error.code, "invalid_expiry");

    const quote = await api("POST", "/v1/quotes", { key: bob, body: { token_id: tokenId } });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    assert.equal(quote.body.expires_at, then(5), "a quote lasts five minutes of replayed time");

    const proof = (await api("GET", `/v1/tokens/${tokenId}/proof`)).body;
    assert.equal(proof.proof_of_thesis.clock, "replay");
    assert.equal(proof.evaluation.status, "pending");

    // Step past the expiry: no new trade can be linked.
    await setClock(then(31));
    assert.equal((await api("POST", "/v1/quotes", { key: bob, body: { token_id: tokenId } })).body.error.code, "insight_expired");

    // Back in real time, a thesis published now is marked as real.
    await api("DELETE", "/v1/dev/clock");
    const real = await api("POST", "/v1/insights", { key: alice, body: thesis(new Date(Date.now() + 3_600_000).toISOString()) });
    assert.equal(real.body.clock, "real");
  });

  test("nobody is signed out, keys keep working and new sign-ins work", async () => {
    const alice = (await connectWallet(api, "alice.testnet")).session;
    const key = (await api("POST", "/v1/keys", { key: alice, body: { scopes: ["read"], expires_in_seconds: 3600 } })).body.secret;
    await setClock(THEN);
    assert.equal((await api("GET", "/v1/me", { key: alice })).status, 200);
    assert.equal((await api("GET", "/v1/me", { key })).status, 200);
    assert.ok((await connectWallet(api, "bob.testnet")).session, "a wallet can connect while the clock is replayed");
    await api("DELETE", "/v1/dev/clock");
    assert.equal((await api("GET", "/v1/me", { key: alice })).status, 200);
    assert.equal((await api("GET", "/v1/me", { key })).status, 200);
  });

  test("a session still ends on real time, however long the replay stays frozen", async () => {
    const start = Date.now();
    mock.timers.enable({ apis: ["Date"], now: start });
    const alice = (await connectWallet(api, "alice.testnet")).session;
    await setClock(THEN);
    mock.timers.setTime(start + 25 * 3_600_000); // a day of real time; the replay has not moved
    assert.equal(nowIso(), THEN);
    assert.equal((await api("GET", "/v1/me", { key: alice })).status, 401);
  });

  test("a subscription bought in real time still unlocks the full thesis", async () => {
    const alice = (await connectWallet(api, "alice.testnet")).session;
    const bob = (await connectWallet(api, "bob.testnet")).session;
    await subscribe(api, bob);
    await setClock(THEN);
    const tokenId = (await api("POST", "/v1/insights", { key: alice, body: thesis(then(30)) })).body.token_id;
    const read = await api("GET", `/v1/tokens/${tokenId}`, { key: bob });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.clock, "replay");
  });
});
