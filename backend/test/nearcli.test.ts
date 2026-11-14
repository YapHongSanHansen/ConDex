import assert from "node:assert/strict";
import { type KeyObject, createPublicKey, generateKeyPairSync } from "node:crypto";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { assertSameMachine } from "../src/api/local.ts";
import { type MessageSigner, NearCliError, NearCliSigner, findNearCli, nearCliErrorText, parseNearCliJson } from "../src/near/nearCli.ts";
import { base58Encode, signNep413, toNearPrivateKey, toNearPublicKey } from "../src/near/nep413.ts";
import { startServer } from "./helpers.ts";

/** Signs like near-cli does (ed25519:<base58> signature) with an in-memory throwaway key. */
function fakeNearCli(opts: { key?: KeyObject; fail?: string; signAs?: string } = {}): MessageSigner & { calls: number } {
  const key = opts.key ?? generateKeyPairSync("ed25519").privateKey;
  const signer = {
    calls: 0,
    async sign(input: { accountId: string; message: string; nonce: Buffer; recipient: string }) {
      signer.calls++;
      if (opts.fail) throw new NearCliError(opts.fail);
      const b64 = signNep413(key, { message: input.message, nonce: input.nonce, recipient: input.recipient });
      return {
        accountId: opts.signAs ?? input.accountId,
        publicKey: toNearPublicKey(createPublicKey(key)),
        signature: "ed25519:" + base58Encode(Buffer.from(b64, "base64")),
      };
    },
  };
  return signer;
}

describe("one-click connect with this computer's near-cli wallet", () => {
  test("connects in one request and reuses the account on the next click", async () => {
    const key = generateKeyPairSync("ed25519").privateKey;
    const srv = await startServer({ nearCli: fakeNearCli({ key }) });
    try {
      assert.deepEqual((await srv.api("GET", "/v1/dev/wallet/near-cli")).body, { available: true, network: "testnet" });
      const first = await srv.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: " Me.Testnet " } });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(first.body.account.near_account_id, "me.testnet");
      assert.equal(first.body.new_account, true);
      assert.match(first.body.session.token, /^cdxs_/);
      const again = await srv.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "me.testnet" } });
      assert.equal(again.body.new_account, false);
      assert.equal((await srv.api("GET", "/v1/keys", { key: again.body.session.token })).status, 200);
    } finally {
      await srv.close();
    }
  });

  test("explains a missing keychain key, and refuses a signature for another account", async () => {
    const missing = await startServer({ nearCli: fakeNearCli({ fail: "No access keys found in keychain" }) });
    try {
      const r = await missing.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "nokey.testnet" } });
      assert.equal(r.status, 502);
      assert.match(r.body.error.message, /no key for nokey\.testnet on testnet .* near account import-account/);
    } finally {
      await missing.close();
    }
    const wrong = await startServer({ nearCli: fakeNearCli({ signAs: "someone-else.testnet" }) });
    try {
      const r = await wrong.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "me.testnet" } });
      assert.equal(r.status, 502);
      assert.match(r.body.error.message, /signed as someone-else\.testnet/);
    } finally {
      await wrong.close();
    }
  });

  test("refuses other websites, non-local host names and bad account names", async () => {
    const signer = fakeNearCli();
    const srv = await startServer({ nearCli: signer });
    try {
      const evil = await srv.api("POST", "/v1/dev/wallet/near-cli", {
        body: { account_id: "me.testnet" }, headers: { origin: "https://evil.example" },
      });
      assert.equal(evil.status, 403);
      assert.equal(evil.body.error.code, "cross_site");

      const own = await srv.api("POST", "/v1/dev/wallet/near-cli", {
        body: { account_id: "me.testnet" }, headers: { origin: srv.base },
      });
      assert.equal(own.status, 201, "the console's own origin is allowed");

      // DNS rebinding: a hostname that resolves to 127.0.0.1 but is not a local name.
      const port = new URL(srv.base).port;
      const rebound = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, method: "POST", path: "/v1/dev/wallet/near-cli",
          headers: { host: `attacker.example:${port}`, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode!); });
        req.on("error", reject);
        req.end(JSON.stringify({ account_id: "me.testnet" }));
      });
      assert.equal(rebound, 403);

      const bad = await srv.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "not valid!" } });
      assert.equal(bad.status, 400);
      assert.equal(signer.calls, 1, "near-cli only runs for the one allowed request");
    } finally {
      await srv.close();
    }
  });

  test("is unavailable without near-cli and outside dev mode", async () => {
    const none = await startServer({ nearCli: null });
    try {
      assert.equal((await none.api("GET", "/v1/dev/wallet/near-cli")).body.available, false);
      const r = await none.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "me.testnet" } });
      assert.equal(r.status, 501);
      assert.match(r.body.error.message, /npm install -g near-cli-rs/);
    } finally {
      await none.close();
    }
    const prod = await startServer({ nearCli: fakeNearCli() }, { devMode: false, walletKeyCheck: "near-rpc" });
    try {
      assert.equal((await prod.api("GET", "/v1/dev/wallet/near-cli")).status, 404);
      assert.equal((await prod.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "me.testnet" } })).status, 404);
    } finally {
      await prod.close();
    }
  });
});

describe("same-machine check", () => {
  const req = (remoteAddress: string, hostname: string, headers: Record<string, string> = {}) => ({
    socket: { remoteAddress }, hostname, get: (name: string) => headers[name.toLowerCase()],
  });

  test("allows local requests from the console's own pages and from local tools", () => {
    assert.doesNotThrow(() => assertSameMachine(req("127.0.0.1", "localhost", { host: "localhost:8787", origin: "http://localhost:8787" })));
    assert.doesNotThrow(() => assertSameMachine(req("::1", "localhost", { host: "localhost:8787" })));
    assert.doesNotThrow(() => assertSameMachine(req("::ffff:127.0.0.1", "127.0.0.1", { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787" })));
  });

  test("refuses other machines, other sites, sandboxed pages and rebinding host names", () => {
    assert.throws(() => assertSameMachine(req("192.168.1.20", "localhost", { host: "localhost:8787" })), /computer running ConDex/);
    assert.throws(() => assertSameMachine(req("127.0.0.1", "attacker.example", { host: "attacker.example:8787" })), /localhost/);
    assert.throws(() => assertSameMachine(req("127.0.0.1", "localhost", { host: "localhost:8787", origin: "https://evil.example" })), /other websites/);
    assert.throws(() => assertSameMachine(req("127.0.0.1", "localhost", { host: "localhost:8787", origin: "http://localhost:9999" })), /other websites/);
    assert.throws(() => assertSameMachine(req("127.0.0.1", "localhost", { host: "localhost:8787", origin: "null" })), /other websites/);
  });

  test("refuses requests a proxy or tunnel passed on, even though they arrive from this computer", () => {
    for (const header of ["x-forwarded-for", "forwarded", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "via"]) {
      assert.throws(() => assertSameMachine(req("127.0.0.1", "localhost", { host: "localhost:8787", [header]: "203.0.113.5" })), /proxy or tunnel/, header);
    }
  });
});

describe("near-cli output handling", () => {
  test("parses the JSON near-cli prints and its error lines", () => {
    const stdout = '{\n  "accountId": "a.testnet",\n  "publicKey": "ed25519:BHp9oxZuzZ7WSUiPCZqfNqLZRiZBjS1y5SVpU7sCYyoT",\n  "signature": "ed25519:2DKi"\n}\n';
    assert.deepEqual(parseNearCliJson(stdout), {
      accountId: "a.testnet", publicKey: "ed25519:BHp9oxZuzZ7WSUiPCZqfNqLZRiZBjS1y5SVpU7sCYyoT", signature: "ed25519:2DKi",
    });
    assert.equal(parseNearCliJson("no json here"), null);
    assert.equal(parseNearCliJson('{"accountId": "a.testnet"}'), null);
    const stderr = "\n\x1b[33mHere is your console command if you need to script it or re-run:\x1b[39m\n    near ...\n\nError: \n   0: No access keys found in keychain\n\nLocation:\n   src\\commands\\account\\export_account\\mod.rs:122\n";
    assert.equal(nearCliErrorText(stderr), "No access keys found in keychain");
  });

  test("CONDEX_NEAR_CLI must point at near-cli-rs: missing files and other programs are rejected", () => {
    assert.equal(findNearCli({ CONDEX_NEAR_CLI: "Z:/definitely/missing/near.exe" }), null);
    assert.equal(findNearCli({ CONDEX_NEAR_CLI: process.execPath }), null, "node runs, but it is not near-cli-rs");
    assert.equal(findNearCli({ CONDEX_NEAR_CLI: tmpdir() }), null, "a directory");
  });

  const binary = findNearCli();
  test("finds the real binary behind npm-style and pnpm-style `near` shims on PATH", { skip: binary ? false : "near-cli not installed" }, () => {
    const exe = process.platform === "win32" ? "near.exe" : "near";
    const root = mkdtempSync(join(tmpdir(), "condex-shim-"));
    const install = (pkgDir: string) => {
      const target = join(pkgDir, "node_modules", ".bin_real");
      mkdirSync(target, { recursive: true });
      try { linkSync(binary!, join(target, exe)); } catch { copyFileSync(binary!, join(target, exe)); }
      return join(target, exe);
    };
    try {
      // npm on Windows: the shim sits beside node_modules (for example under nvm-windows' prefix).
      const npmDir = join(root, "npm-prefix");
      const npmReal = install(join(npmDir, "node_modules", "near-cli-rs"));
      writeFileSync(join(npmDir, "near.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\near-cli-rs\\run-near.js" %*\r\n');
      assert.equal(findNearCli({ PATH: npmDir }), npmReal);
      assert.equal(findNearCli({ CONDEX_NEAR_CLI: join(npmDir, "near.cmd") }), npmReal, "CONDEX_NEAR_CLI may name the shim");

      // pnpm: the shim points somewhere else entirely.
      const pnpmBin = join(root, "pnpm-home");
      mkdirSync(pnpmBin);
      const pnpmReal = install(join(root, "pnpm-global", "5", "node_modules", "near-cli-rs"));
      writeFileSync(join(pnpmBin, "near.cmd"), '@SETLOCAL\r\n"%~dp0\\..\\pnpm-global\\5\\node_modules\\near-cli-rs\\run-near.js" %*\r\n');
      assert.equal(findNearCli({ PATH: pnpmBin }), pnpmReal);

      assert.equal(findNearCli({ PATH: join(root, "nothing-here") }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the real near-cli binary signs a sign-in that the server accepts", { skip: binary ? false : "near-cli not installed" }, async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const signer = new NearCliSigner(binary!, () => ["sign-with-plaintext-private-key", toNearPrivateKey(privateKey)]);
    const srv = await startServer({ nearCli: signer });
    try {
      const r = await srv.api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: "real-cli.testnet" } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.session.wallet_public_key, toNearPublicKey(createPublicKey(privateKey)));
    } finally {
      await srv.close();
    }
  });
});
