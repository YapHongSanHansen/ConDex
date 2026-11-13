import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { AccessKeyChecker } from "../src/near/accessKeys.ts";
import { signNep413, toNearPublicKey } from "../src/near/nep413.ts";
import { MAX_OPEN_CHALLENGES, newNonce } from "../src/services/auth.ts";
import { connectWallet, startServer } from "./helpers.ts";

const countChallenges = (srv: Awaited<ReturnType<typeof startServer>>) =>
  (srv.ctx.db.prepare("SELECT COUNT(*) AS n FROM auth_challenges").get() as { n: number }).n;

describe("sign-in challenges stay bounded", () => {
  test("expired challenges are deleted when a new one is requested", async () => {
    const srv = await startServer();
    try {
      srv.ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, expires_at, created_at) VALUES ('old', 'm', 'ConDex', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')").run();
      assert.equal(countChallenges(srv), 1);
      assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201);
      assert.equal(countChallenges(srv), 1, "the expired row is gone and only the new one remains");
    } finally {
      await srv.close();
    }
  });

  test("too many open challenges returns 429 until they expire", async () => {
    const srv = await startServer();
    try {
      const future = new Date(Date.now() + 60_000).toISOString();
      const insert = srv.ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, expires_at, created_at) VALUES (?, 'm', 'ConDex', ?, ?)");
      srv.ctx.db.exec("BEGIN");
      for (let i = 0; i < MAX_OPEN_CHALLENGES; i++) insert.run(`n${i}`, future, future);
      srv.ctx.db.exec("COMMIT");
      const full = await srv.api("POST", "/v1/auth/challenge");
      assert.equal(full.status, 429);
      assert.equal(full.body.error.code, "too_many_sign_ins");
      srv.ctx.db.prepare("UPDATE auth_challenges SET expires_at = '2000-01-01T00:00:00.000Z'").run();
      assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201);
      assert.equal(countChallenges(srv), 1);
    } finally {
      await srv.close();
    }
  });

  test("nonces never start with '/' (Git Bash would turn the near-cli argument into a path)", () => {
    for (let i = 0; i < 5000; i++) {
      const nonce = newNonce();
      assert.notEqual(nonce[0], "/", nonce);
      assert.equal(Buffer.from(nonce, "base64").length, 32);
    }
  });
});

describe("redirect wallets (NEP-413 callbackUrl)", () => {
  test("a signature that covers a callbackUrl verifies only when the website sends that callbackUrl", async () => {
    const srv = await startServer();
    try {
      const key = generateKeyPairSync("ed25519").privateKey;
      const publicKey = toNearPublicKey(createPublicKey(key));
      const callbackUrl = "http://localhost:8787/test";
      const signIn = async (signedWithCallback: boolean, sendCallback: boolean) => {
        const ch = (await srv.api("POST", "/v1/auth/challenge")).body;
        const signature = signNep413(key, {
          message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient,
          callbackUrl: signedWithCallback ? callbackUrl : null,
        });
        return srv.api("POST", "/v1/auth/verify", { body: {
          account_id: "redirect.testnet", public_key: publicKey, signature, nonce: ch.nonce,
          ...(sendCallback ? { callback_url: callbackUrl } : {}),
        } });
      };
      assert.equal((await signIn(true, false)).status, 401, "redirect-wallet signature without the callbackUrl");
      assert.equal((await signIn(true, true)).status, 201, "redirect-wallet signature with the callbackUrl");
      assert.equal((await signIn(false, true)).status, 201, "popup-wallet signature even if the website sends a callbackUrl");
      assert.equal((await signIn(false, false)).status, 201, "plain signature");
    } finally {
      await srv.close();
    }
  });
});

describe("production settings", () => {
  test("outside dev mode a private execution secret is required", () => {
    const prod = { CONDEX_DEV_MODE: "false" };
    assert.throws(() => loadConfig(prod), /CONDEX_EXECUTION_SECRET/);
    assert.throws(() => loadConfig({ ...prod, CONDEX_EXECUTION_SECRET: "" }), /CONDEX_EXECUTION_SECRET/);
    assert.throws(() => loadConfig({ ...prod, CONDEX_EXECUTION_SECRET: "dev-execution-secret" }), /CONDEX_EXECUTION_SECRET/);
    assert.equal(loadConfig({ ...prod, CONDEX_EXECUTION_SECRET: "s3cret-from-the-venue" }).executionSecret, "s3cret-from-the-venue");
    assert.equal(loadConfig({}).executionSecret, "dev-execution-secret", "dev mode keeps the convenient default");
  });

  test("credentials from dev-mode sign-ins stop working once keys are checked on NEAR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "condex-keycheck-"));
    const dbPath = join(dir, "condex.db");
    const onChain: AccessKeyChecker = { mode: "near-rpc", isFullAccessKey: async () => true };
    try {
      // 1. Dev mode, no on-chain check: sign in and create an agent key.
      const dev = await startServer({}, { dbPath });
      const devSignIn = await connectWallet(dev.api, "someone.testnet");
      assert.equal(devSignIn.verify.body.session.key_check, "none");
      const devKey = (await dev.api("POST", "/v1/keys", { key: devSignIn.session, body: { scopes: ["read"] } })).body.secret;
      await dev.close();
      dev.ctx.db.close();

      // 2. Same file, now checking keys on NEAR: the unproven session and key are refused.
      const prod = await startServer({ accessKeys: onChain }, { dbPath, walletKeyCheck: "near-rpc" });
      try {
        const oldSession = await prod.api("GET", "/v1/me", { key: devSignIn.session });
        assert.equal(oldSession.status, 401);
        assert.match(oldSession.body.error.message, /skipped the on-chain wallet check/);
        assert.equal((await prod.api("GET", "/v1/me", { key: devKey })).status, 401);

        // A sign-in checked on NEAR works, and so does a key it issues.
        const real = await connectWallet(prod.api, "someone.testnet");
        assert.equal(real.verify.status, 201);
        assert.equal(real.verify.body.session.key_check, "near-rpc");
        const key = (await prod.api("POST", "/v1/keys", { key: real.session, body: { scopes: ["read"] } })).body.secret;
        assert.equal((await prod.api("GET", "/v1/me", { key })).status, 200);
      } finally {
        await prod.close();
        prod.ctx.db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
