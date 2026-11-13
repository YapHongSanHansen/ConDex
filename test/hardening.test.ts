import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import type { AccessKeyChecker } from "../src/near/accessKeys.ts";
import { signNep413, toNearPublicKey } from "../src/near/nep413.ts";
import { MAX_OPEN_CHALLENGES, MAX_OPEN_CHALLENGES_PER_CLIENT, newNonce } from "../src/services/auth.ts";
import { connectWallet, startServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
const count = (srv: Server, table: string) => (srv.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Adds `n` unfinished challenges for `client` (tests sign in from 127.0.0.1). */
function addOpenChallenges(srv: Server, n: number, client: (i: number) => string) {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();
  const insert = srv.ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, client, expires_at, created_at) VALUES (?, 'm', 'r', ?, ?, ?)");
  srv.ctx.db.exec("BEGIN");
  for (let i = 0; i < n; i++) insert.run(`seed${i}`, client(i), later, now);
  srv.ctx.db.exec("COMMIT");
}

async function withServer(fn: (srv: Server) => Promise<void>, overrides = {}) {
  const srv = await startServer({}, overrides);
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

describe("sign-in challenges cannot be used to lock others out or fill memory", () => {
  test("expired challenges are deleted when a new one is requested", () => withServer(async (srv) => {
    srv.ctx.db.prepare("INSERT INTO auth_challenges (nonce, message, recipient, client, expires_at, created_at) VALUES ('old', 'm', 'r', '10.0.0.1', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')").run();
    assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201);
    assert.equal(count(srv, "auth_challenges"), 1, "the expired row is gone and only the new one remains");
  }));

  test("each client is limited to a number of new challenges per minute", () => withServer(async (srv) => {
    for (let i = 0; i < 3; i++) assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201);
    const fourth = await srv.api("POST", "/v1/auth/challenge");
    assert.equal(fourth.status, 429);
    assert.match(fourth.body.error.message, /from your network/);
  }, { signInsPerMinute: 3 }));

  test("one client's unfinished sign-ins do not block anyone else", () => withServer(async (srv) => {
    addOpenChallenges(srv, MAX_OPEN_CHALLENGES_PER_CLIENT, () => "203.0.113.9"); // someone else filling their quota
    assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201, "another client still gets a challenge");
    srv.ctx.db.exec("DELETE FROM auth_challenges");
    addOpenChallenges(srv, MAX_OPEN_CHALLENGES_PER_CLIENT, () => "127.0.0.1");
    const mine = await srv.api("POST", "/v1/auth/challenge");
    assert.equal(mine.status, 429);
    assert.match(mine.body.error.message, /too many unfinished sign-ins/);
  }));

  test("the total cap stays as a last guard on memory, and frees up as challenges expire", () => withServer(async (srv) => {
    addOpenChallenges(srv, MAX_OPEN_CHALLENGES, (i) => `198.51.${i >> 8}.${i & 255}`);
    const full = await srv.api("POST", "/v1/auth/challenge");
    assert.equal(full.status, 429);
    srv.ctx.db.prepare("UPDATE auth_challenges SET expires_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z'").run();
    assert.equal((await srv.api("POST", "/v1/auth/challenge")).status, 201);
    assert.equal(count(srv, "auth_challenges"), 1);
  }));

  test("nonces never start with '/' (Git Bash would turn the near-cli argument into a path)", () => {
    for (let i = 0; i < 5000; i++) {
      const nonce = newNonce();
      assert.notEqual(nonce[0], "/", nonce);
      assert.equal(Buffer.from(nonce, "base64").length, 32);
    }
  });

  test("expired sessions are deleted at the next sign-in", () => withServer(async (srv) => {
    const old = await connectWallet(srv.api, "sessions.testnet");
    srv.ctx.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    await connectWallet(srv.api, "sessions.testnet", { key: old.privateKey });
    assert.equal(count(srv, "sessions"), 1, "only the new session is left");
  }));
});

describe("redirect wallets (NEP-413 callbackUrl)", () => {
  const key = generateKeyPairSync("ed25519").privateKey;
  const publicKey = toNearPublicKey(createPublicKey(key));
  const signIn = async (srv: Server, signedCallback: string | null, sentCallback: string | null) => {
    const ch = (await srv.api("POST", "/v1/auth/challenge")).body;
    const signature = signNep413(key, { message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: ch.recipient, callbackUrl: signedCallback });
    return srv.api("POST", "/v1/auth/verify", { body: {
      account_id: "redirect.testnet", public_key: publicKey, signature, nonce: ch.nonce,
      ...(sentCallback ? { callback_url: sentCallback } : {}),
    } });
  };

  test("a signature that covers a callbackUrl verifies only when the website sends that callbackUrl", () => withServer(async (srv) => {
    const cb = "http://localhost:8787/test";
    assert.equal((await signIn(srv, cb, null)).status, 401, "redirect-wallet signature without the callbackUrl");
    assert.equal((await signIn(srv, cb, cb)).status, 201, "redirect-wallet signature with the callbackUrl");
    assert.equal((await signIn(srv, null, cb)).status, 201, "popup-wallet signature even if the website sends a callbackUrl");
    assert.equal((await signIn(srv, null, null)).status, 201, "plain signature");
  }, { allowedOrigins: ["http://localhost:8787"] }));

  test("a callbackUrl on another site is refused, even with a valid signature over it", () => withServer(async (srv) => {
    const relayed = await signIn(srv, "https://evil.example/cb", "https://evil.example/cb");
    assert.equal(relayed.status, 400);
    assert.equal(relayed.body.error.code, "callback_not_allowed");
  }, { allowedOrigins: ["http://localhost:8787"] }));
});

describe("dev routes only answer this computer's own test console", () => {
  test("other websites, proxies and tunnels are refused; the console's own requests work", () => withServer(async (srv) => {
    const reset = (headers: Record<string, string>) => srv.api("POST", "/v1/dev/reset", { headers });
    assert.equal((await reset({ origin: "https://evil.example" })).status, 403, "cross-site form post or fetch");
    assert.equal((await reset({ "x-forwarded-for": "203.0.113.5" })).status, 403, "through ngrok or a reverse proxy");
    assert.equal((await reset({ forwarded: "for=203.0.113.5" })).status, 403);
    assert.equal((await srv.api("POST", "/v1/sim/orders/x/fill", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await reset({ origin: srv.base })).status, 200, "the test console itself");
    assert.equal((await reset({})).status, 200, "a script on this computer");
  }));

  test("/health shows the server's file path only to this computer", () => withServer(async (srv) => {
    assert.match((await srv.api("GET", "/health")).body.mcp_server, /server\.ts$/);
    const viaTunnel = await srv.api("GET", "/health", { headers: { "x-forwarded-for": "203.0.113.5" } });
    assert.equal(viaTunnel.status, 200);
    assert.equal(viaTunnel.body.mcp_server, undefined);
  }));
});

describe("settings", () => {
  const prod = {
    CONDEX_DEV_MODE: "false", CONDEX_EXECUTION_SECRET: "s3cret-from-the-venue", CONDEX_DB_PATH: "data/condex.db",
    CONDEX_AUTH_RECIPIENT: "condex.app",
  };

  test("dev defaults: this computer only, in memory, public testnet RPC", () => {
    const dev = loadConfig({});
    assert.equal(dev.host, "127.0.0.1");
    assert.equal(dev.dbPath, ":memory:");
    assert.equal(dev.authRecipient, "localhost:8787");
    assert.deepEqual(dev.allowedOrigins, ["http://localhost:8787", "http://127.0.0.1:8787"]);
    assert.equal(dev.nearRpcUrl, "https://test.rpc.fastnear.com");
    assert.equal(dev.executionSecret, "dev-execution-secret");
  });

  test("outside dev mode, storage, the site's domain and a private execution secret must be set", () => {
    assert.doesNotThrow(() => loadConfig(prod));
    assert.equal(loadConfig(prod).host, "0.0.0.0");
    const without = (name: keyof typeof prod) => ({ ...prod, [name]: "" });
    assert.throws(() => loadConfig(without("CONDEX_EXECUTION_SECRET")), /CONDEX_EXECUTION_SECRET/);
    assert.throws(() => loadConfig({ ...prod, CONDEX_EXECUTION_SECRET: "dev-execution-secret" }), /CONDEX_EXECUTION_SECRET/);
    assert.throws(() => loadConfig(without("CONDEX_DB_PATH")), /CONDEX_DB_PATH/);
    assert.equal(loadConfig({ ...prod, CONDEX_DB_PATH: ":memory:" }).dbPath, ":memory:", "memory is allowed when chosen explicitly");
    assert.throws(() => loadConfig(without("CONDEX_AUTH_RECIPIENT")), /CONDEX_AUTH_RECIPIENT/);
    assert.throws(() => loadConfig({ ...prod, CONDEX_WALLET_KEY_CHECK: "none" }), /only allowed when CONDEX_DEV_MODE=true/);
  });

  test("typos fail at startup instead of silently changing behaviour", () => {
    assert.equal(loadConfig({ CONDEX_NEAR_NETWORK: "Mainnet" }).nearNetwork, "mainnet", "case does not matter");
    assert.equal(loadConfig({ CONDEX_NEAR_NETWORK: "mainnet" }).nearRpcUrl, "https://rpc.mainnet.fastnear.com");
    assert.throws(() => loadConfig({ CONDEX_NEAR_NETWORK: "main-net" }), /CONDEX_NEAR_NETWORK/);
    assert.throws(() => loadConfig({ CONDEX_DEV_MODE: "yes" }), /CONDEX_DEV_MODE/);
    assert.throws(() => loadConfig({ CONDEX_WALLET_KEY_CHECK: "rpc" }), /CONDEX_WALLET_KEY_CHECK/);
    assert.throws(() => loadConfig({ CONDEX_CHALLENGE_TTL_SECONDS: "5m" }), /CONDEX_CHALLENGE_TTL_SECONDS/);
    assert.throws(() => loadConfig({ CONDEX_SESSION_TTL_SECONDS: "0" }), /CONDEX_SESSION_TTL_SECONDS/);
    assert.equal(loadConfig({ CONDEX_SESSION_TTL_SECONDS: "" }).sessionTtlSeconds, 86_400, "empty means the default");
    assert.throws(() => loadConfig({ CONDEX_ALLOWED_ORIGINS: "https://condex.app/login" }), /CONDEX_ALLOWED_ORIGINS/);
    assert.deepEqual(loadConfig({ CONDEX_ALLOWED_ORIGINS: "https://condex.app, https://www.condex.app/" }).allowedOrigins,
      ["https://condex.app", "https://www.condex.app"]);
  });

  test("credentials from dev-mode sign-ins stop working once keys are checked on NEAR", async () => {
    const dir = mkdtempSync(join(tmpdir(), "condex-keycheck-"));
    const dbPath = join(dir, "condex.db");
    const onChain: AccessKeyChecker = { mode: "near-rpc", isFullAccessKey: async () => true };
    try {
      // 1. Dev mode, no on-chain check: sign in and create an agent key.
      let devSession = "";
      let devKey = "";
      const dev = await startServer({}, { dbPath });
      try {
        const devSignIn = await connectWallet(dev.api, "someone.testnet");
        assert.equal(devSignIn.verify.body.session.key_check, "none");
        devSession = devSignIn.session;
        devKey = (await dev.api("POST", "/v1/keys", { key: devSession, body: { scopes: ["read"] } })).body.secret;
      } finally {
        await dev.close();
        dev.ctx.db.close();
      }

      // 2. Same file, now checking keys on NEAR: the unproven session and key are refused.
      const prod = await startServer({ accessKeys: onChain }, { dbPath, walletKeyCheck: "near-rpc" });
      try {
        const oldSession = await prod.api("GET", "/v1/me", { key: devSession });
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
