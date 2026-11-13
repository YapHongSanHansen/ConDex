import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createApp } from "../src/api/app.ts";
import { loadConfig } from "../src/config.ts";
import { SCHEMA_VERSION, openDb } from "../src/db.ts";
import { setupAliceAndBob, startServer } from "./helpers.ts";

test("by default data lives in memory and nothing is written to disk", () => {
  const config = loadConfig({});
  assert.equal(config.dbPath, ":memory:");
  assert.equal(loadConfig({ CONDEX_DB_PATH: "" }).dbPath, ":memory:");

  const dir = mkdtempSync(join(tmpdir(), "condex-cwd-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const { ctx } = createApp(config);
    ctx.db.prepare("INSERT INTO accounts (id, near_account_id, display_name, created_at) VALUES ('a', 'x.testnet', 'X', 'now')").run();
    assert.deepEqual(readdirSync(dir), [], "the default store must not create files");
    ctx.db.close();
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart starts empty: published insights, sessions and keys are gone", async () => {
  const first = await startServer();
  const s = await setupAliceAndBob(first.api);
  assert.equal((await first.api("GET", "/v1/tokens")).body.tokens.length, 1);
  await first.close();

  const second = await startServer();
  try {
    assert.equal((await second.api("GET", "/v1/tokens")).body.tokens.length, 0);
    assert.equal((await second.api("GET", "/v1/me", { key: s.bobRead })).status, 401);
    assert.equal((await second.api("GET", "/v1/keys", { key: s.bobSession })).status, 401);
    assert.equal((await second.api("GET", "/health")).body.storage, "memory");
  } finally {
    await second.close();
  }
});

test("opt-in file store keeps data between restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "condex-file-"));
  const path = join(dir, "nested", "condex.db");
  try {
    const a = openDb(path);
    a.prepare("INSERT INTO accounts (id, near_account_id, display_name, created_at) VALUES ('a', 'x.testnet', 'X', 'now')").run();
    a.close();
    const b = openDb(path);
    assert.equal((b.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n, 1);
    assert.equal((b.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opt-in file store refuses a file from an older build and leaves its data intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "condex-old-"));
  const path = join(dir, "condex.db");
  try {
    // What the pre-versioning build wrote: tables, data, user_version 0.
    const old = new DatabaseSync(path);
    old.exec("PRAGMA journal_mode = WAL; CREATE TABLE accounts (id TEXT PRIMARY KEY, near_account_id TEXT); INSERT INTO accounts VALUES ('a', 'old.testnet');");
    old.close();

    assert.throws(() => openDb(path), new RegExp(`different version of ConDex \\(schema 0; this build needs ${SCHEMA_VERSION}\\)`));

    const check = new DatabaseSync(path, { readOnly: true });
    assert.equal((check.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n, 1);
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 0);
    check.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
