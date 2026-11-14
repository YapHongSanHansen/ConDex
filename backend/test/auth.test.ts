import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { after, beforeEach, describe, test } from "node:test";
import { RpcAccessKeyChecker } from "../src/near/accessKeys.ts";
import { base58Decode, base58Encode, signNep413, toNearPublicKey, verifyNep413 } from "../src/near/nep413.ts";
import { connectWallet, setupAliceAndBob, startServer } from "./helpers.ts";

const srv = await startServer();
const { api } = srv;
after(() => srv.close());
beforeEach(() => api("POST", "/v1/dev/reset"));

/**
 * Produced by near-cli-rs 0.31.1 (`near message sign-nep413 utf8 ... sign-with-plaintext-private-key`)
 * with a throwaway key. It checks our NEP-413 encoding against NEAR's own tooling, not just itself.
 */
const NEAR_CLI_VECTOR = {
  message: "Sign in to ConDex. This proves you control this NEAR account and does not send a transaction or cost anything. Issued 2026-11-13T08:10:00.000Z",
  nonce: "cAK4AqNRsJaiaPxyexqmygrprZuKqxLxMsj+Kx4b6yY=",
  recipient: "ConDex",
  publicKey: "ed25519:BHp9oxZuzZ7WSUiPCZqfNqLZRiZBjS1y5SVpU7sCYyoT",
  signature: "ed25519:2DKiEaTnN4isdGD6h7yRUMsEUF3Csrut69rSqjJDX8Na8LAtyBsaKb5NEHtYCds7BcFS12FVeHMnCxSP1qmRhxzc",
};

describe("NEP-413 compatibility", () => {
  test("a signature made by near-cli verifies, in both encodings", () => {
    const v = NEAR_CLI_VECTOR;
    const payload = { message: v.message, nonce: Buffer.from(v.nonce, "base64"), recipient: v.recipient };
    assert.equal(verifyNep413(v.publicKey, v.signature, payload), true);
    const asBase64 = Buffer.from(base58Decode(v.signature.slice("ed25519:".length))).toString("base64");
    assert.equal(verifyNep413(v.publicKey, asBase64, payload), true);
  });

  test("the near-cli signature fails if any signed field changes", () => {
    const v = NEAR_CLI_VECTOR;
    const nonce = Buffer.from(v.nonce, "base64");
    assert.equal(verifyNep413(v.publicKey, v.signature, { message: v.message + " ", nonce, recipient: v.recipient }), false);
    assert.equal(verifyNep413(v.publicKey, v.signature, { message: v.message, nonce: Buffer.alloc(32), recipient: v.recipient }), false);
    assert.equal(verifyNep413(v.publicKey, v.signature, { message: v.message, nonce, recipient: "Evil" }), false);
    assert.equal(verifyNep413(v.publicKey, v.signature, { message: v.message, nonce, recipient: v.recipient, callbackUrl: "https://x" }), false);
    const otherKey = toNearPublicKey(generateKeyPairSync("ed25519").publicKey);
    assert.equal(verifyNep413(otherKey, v.signature, { message: v.message, nonce, recipient: v.recipient }), false);
    assert.equal(verifyNep413(v.publicKey, "not a signature!", { message: v.message, nonce, recipient: v.recipient }), false);
  });

  test("sign-in accepts the near-cli signature format (ed25519:<base58>)", async () => {
    const r = await connectWallet(api, "cli-user.testnet");
    assert.equal(r.verify.status, 201); // helper sends base64, like browser wallets
    const challenge = (await api("POST", "/v1/auth/challenge")).body;
    const sigB64 = signNep413(r.privateKey, { message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"), recipient: challenge.recipient });
    const nearCliStyle = "ed25519:" + base58Encode(Buffer.from(sigB64, "base64"));
    const res = await api("POST", "/v1/auth/verify", {
      body: { account_id: "cli-user.testnet", public_key: r.publicKey, signature: nearCliStyle, nonce: challenge.nonce },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.new_account, false);
  });
});

describe("without a wallet", () => {
  test("visitors can see publisher details and previews only", async () => {
    const s = await setupAliceAndBob(api);

    const profile = await api("GET", "/v1/publishers/alice.testnet");
    assert.equal(profile.status, 200);
    assert.equal(profile.body.publisher.display_name, "Alice");
    assert.equal(profile.body.stats.insights, 1);
    assert.equal(profile.body.tokens.length, 1);
    assert.equal(profile.body.tokens[0].messages, undefined);
    assert.equal((await api("GET", "/v1/tokens")).status, 200);
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}/preview`)).status, 200);

    const blocked: Array<[string, string, unknown?]> = [
      ["GET", `/v1/tokens/${s.tokenId}`],
      ["POST", "/v1/keys", { scopes: ["read"] }],
      ["GET", "/v1/keys"],
      ["POST", "/v1/insights", { title: "x", fee_near: "0", messages: [{ role: "user", content: "x" }] }],
      ["POST", "/v1/quotes", { token_id: s.tokenId }],
      ["POST", "/v1/ledger/deposit", { amount_near: "1" }],
      ["GET", "/v1/receipts"],
      ["GET", "/v1/receipts/rcpt_any"],
    ];
    for (const [method, path, body] of blocked) {
      const r = await api(method, path, { body });
      assert.equal(r.status, 401, `${method} ${path}`);
      assert.match(r.body.error.message, /Connect your NEAR wallet/, `${method} ${path}`);
    }
  });

  test("an unknown publisher is a 404", async () => {
    assert.equal((await api("GET", "/v1/publishers/nobody.testnet")).status, 404);
  });
});

describe("connect wallet (NEP-413)", () => {
  test("first sign-in creates the account; later sign-ins reuse it", async () => {
    const first = await connectWallet(api, "carol.testnet", { displayName: "Carol" });
    assert.equal(first.verify.status, 201);
    assert.equal(first.verify.body.new_account, true);
    assert.match(first.session, /^cdxs_/);
    assert.equal(first.verify.body.session.key_check, "none");

    const second = await connectWallet(api, "carol.testnet", { key: first.privateKey });
    assert.equal(second.verify.body.new_account, false);
    assert.equal(second.verify.body.account.id, first.verify.body.account.id);
    assert.equal(second.verify.body.account.display_name, "Carol");

    const me = await api("GET", "/v1/me", { key: second.session });
    assert.equal(me.body.credential.type, "session");
    assert.deepEqual(me.body.credential.scopes, ["publish", "read", "trade"]);
  });

  test("the sign-in message names the site, so a look-alike site is visible to the user", async () => {
    const challenge = (await api("POST", "/v1/auth/challenge")).body;
    assert.equal(challenge.recipient, "localhost:8787");
    assert.match(challenge.message, /^Sign in to ConDex at localhost:8787\. /);
  });

  test("while keys are not checked on NEAR, only an account's first key can sign in as it", async () => {
    const first = await connectWallet(api, "pinned.testnet");
    assert.equal(first.verify.status, 201);
    const impostor = await connectWallet(api, "pinned.testnet"); // a different, freshly generated key
    assert.equal(impostor.verify.status, 401);
    assert.match(impostor.verify.body.error.message, /first connected with a different key/);
    assert.equal((await connectWallet(api, "pinned.testnet", { key: first.privateKey })).verify.status, 201);
  });

  test("receipts can only be read by the borrower and the creator", async () => {
    const s = await setupAliceAndBob(api);
    const quote = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    const order = await api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true } });
    const receiptId = (await api("POST", `/v1/sim/orders/${order.body.id}/fill`)).body.receipt.id;
    assert.equal((await api("GET", `/v1/receipts/${receiptId}`, { key: s.bobTrade })).status, 200);
    assert.equal((await api("GET", `/v1/receipts/${receiptId}`, { key: s.aliceSession })).status, 200);
    const stranger = (await connectWallet(api, "stranger.testnet")).session;
    assert.equal((await api("GET", `/v1/receipts/${receiptId}`, { key: stranger })).status, 404);
  });

  test("a tampered or wrong-key signature is rejected", async () => {
    const challenge = (await api("POST", "/v1/auth/challenge")).body;
    const real = await connectWallet(api, "dave.testnet");
    const other = generateKeyPairSync("ed25519").privateKey;
    const sigByOtherKey = signNep413(other, {
      message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"), recipient: challenge.recipient,
    });
    const r = await api("POST", "/v1/auth/verify", {
      body: { account_id: "dave.testnet", public_key: real.publicKey, signature: sigByOtherKey, nonce: challenge.nonce },
    });
    assert.equal(r.status, 401);
    assert.match(r.body.error.message, /signature does not match/);

    // Signing for a different recipient (e.g. a phishing site) does not verify either.
    const c2 = (await api("POST", "/v1/auth/challenge")).body;
    const wrongRecipient = signNep413(real.privateKey, { message: c2.message, nonce: Buffer.from(c2.nonce, "base64"), recipient: "evil.example" });
    const r2 = await api("POST", "/v1/auth/verify", {
      body: { account_id: "dave.testnet", public_key: real.publicKey, signature: wrongRecipient, nonce: c2.nonce },
    });
    assert.equal(r2.status, 401);
  });

  test("a challenge works once", async () => {
    const first = await connectWallet(api, "erin.testnet");
    const replay = await api("POST", "/v1/auth/verify", {
      body: { account_id: "erin.testnet", public_key: first.publicKey, signature: first.signature, nonce: first.challenge.nonce },
    });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error.message, /already used/);

    const unknown = await api("POST", "/v1/auth/verify", {
      body: { account_id: "erin.testnet", public_key: first.publicKey, signature: first.signature, nonce: "bm9wZQ==" },
    });
    assert.equal(unknown.status, 401);
  });

  test("only a wallet session can manage API keys; API keys outlive sign-out", async () => {
    const s = await setupAliceAndBob(api);
    const viaKey = await api("POST", "/v1/keys", { key: s.bobRead, body: { scopes: ["read"] } });
    assert.equal(viaKey.status, 403);
    assert.equal(viaKey.body.error.code, "wallet_session_required");
    assert.equal((await api("GET", "/v1/keys", { key: s.bobTrade })).status, 403);
    assert.equal((await api("PATCH", "/v1/me", { key: s.bobRead, body: { display_name: "x" } })).status, 403);

    assert.equal((await api("PATCH", "/v1/me", { key: s.bobSession, body: { display_name: "Bobby" } })).body.display_name, "Bobby");
    assert.equal((await api("POST", "/v1/auth/logout", { key: s.bobSession })).status, 200);
    const afterLogout = await api("GET", "/v1/keys", { key: s.bobSession });
    assert.equal(afterLogout.status, 401);
    assert.match(afterLogout.body.error.message, /signed out/);
    // Agent keys keep working until revoked, so a running MCP agent is not cut off by closing the website.
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).status, 200);
  });
});

describe("on-chain key check", () => {
  /** A stand-in NEAR RPC node that answers view_access_key with `answer` (or fails with HTTP 502). */
  function fakeRpc(answer: unknown) {
    const calls: unknown[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      if (answer === "down") return new Response("bad gateway", { status: 502 });
      return Response.json({ jsonrpc: "2.0", id: "condex", ...(answer as object) });
    }) as typeof fetch;
    return { checker: new RpcAccessKeyChecker("https://rpc.example", fetchFn), calls };
  }
  const permission = (p: unknown) => ({ result: { nonce: 1, permission: p, block_height: 1 } });
  const rpcError = (cause: string) => ({ error: { name: "HANDLER_ERROR", cause: { name: cause }, message: "x" } });

  test("a full-access key signs in; missing or limited keys get 401; RPC trouble is a retryable 502", async () => {
    const cases: Array<[string, unknown, number]> = [
      ["full-access key", permission("FullAccess"), 201],
      ["function-call key", permission({ FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } }), 401],
      ["unknown key (JSON-RPC error)", rpcError("UNKNOWN_ACCESS_KEY"), 401],
      ["unknown account (JSON-RPC error)", rpcError("UNKNOWN_ACCOUNT"), 401],
      ["unknown key (FastNEAR's result.error)", { result: { error: "access key ed25519:x does not exist while viewing", logs: [] } }, 401],
      ["node not synced", rpcError("NO_SYNCED_BLOCKS"), 502],
      ["unknown block", rpcError("UNKNOWN_BLOCK"), 502],
      ["rate limited inside result.error", { result: { error: "rate limit exceeded", logs: [] } }, 502],
      ["RPC down", "down", 502],
    ];
    for (const [label, answer, status] of cases) {
      const rpc = fakeRpc(answer);
      const s = await startServer({ accessKeys: rpc.checker });
      try {
        const r = await connectWallet(s.api, "frank.testnet");
        assert.equal(r.verify.status, status, label);
        if (status === 502) assert.equal(r.verify.body.error.code, "near_rpc_unavailable", label);
        const call = rpc.calls[0] as { params: { request_type: string; account_id: string; public_key: string } };
        assert.equal(call.params.request_type, "view_access_key");
        assert.equal(call.params.account_id, "frank.testnet");
        assert.equal(call.params.public_key, r.publicKey);
        if (status === 201) assert.equal(r.verify.body.session.key_check, "near-rpc");
      } finally {
        await s.close();
      }
    }
  });

  test("keys are not pinned when they are checked on NEAR: any full-access key of the account works", async () => {
    const s = await startServer({ accessKeys: fakeRpc(permission("FullAccess")).checker });
    try {
      assert.equal((await connectWallet(s.api, "multi.testnet")).verify.status, 201);
      assert.equal((await connectWallet(s.api, "multi.testnet")).verify.status, 201);
    } finally {
      await s.close();
    }
  });

  test("base58 round-trips, including leading zero bytes", () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) {
      assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
    }
    assert.equal(base58Encode(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  });
});
