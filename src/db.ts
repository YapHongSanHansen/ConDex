import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
-- Accounts and credentials ---------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  near_account_id  TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  label         TEXT NOT NULL,
  scopes        TEXT NOT NULL,          -- JSON array: admin | publish | read | trade
  token_ids     TEXT,                   -- JSON array; NULL means any token
  expires_at    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);

-- Insights (private storage) ------------------------------------------
CREATE TABLE IF NOT EXISTS insights (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL
);

-- Each published version gets its own token.
CREATE TABLE IF NOT EXISTS insight_versions (
  token_id        TEXT PRIMARY KEY,
  insight_id      TEXT NOT NULL REFERENCES insights(id),
  version         INTEGER NOT NULL,
  creator_id      TEXT NOT NULL REFERENCES accounts(id),
  payout_account  TEXT NOT NULL,
  fee_yocto       TEXT NOT NULL,
  title           TEXT NOT NULL,
  market          TEXT,
  summary         TEXT,
  expires_at      TEXT,
  messages        TEXT NOT NULL,        -- JSON array, private: served only to read-scoped keys
  content_hash    TEXT NOT NULL,
  mint_tx         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (insight_id, version)
);

CREATE TABLE IF NOT EXISTS reads (
  id               TEXT PRIMARY KEY,
  token_id         TEXT NOT NULL REFERENCES insight_versions(token_id),
  reader_id        TEXT NOT NULL REFERENCES accounts(id),
  key_id           TEXT NOT NULL REFERENCES api_keys(id),
  charged_yocto    TEXT NOT NULL DEFAULT '0',
  created_at       TEXT NOT NULL
);

-- Trading and settlement -----------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id            TEXT PRIMARY KEY,
  token_id      TEXT NOT NULL REFERENCES insight_versions(token_id),
  borrower_id   TEXT NOT NULL REFERENCES accounts(id),
  fee_yocto     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  order_id      TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,
  borrower_id        TEXT NOT NULL REFERENCES accounts(id),
  key_id             TEXT NOT NULL REFERENCES api_keys(id),
  token_id           TEXT NOT NULL REFERENCES insight_versions(token_id),
  quote_id           TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  market             TEXT NOT NULL,
  side               TEXT NOT NULL,       -- buy | sell
  quantity           TEXT NOT NULL,
  limit_price        TEXT,
  fee_yocto          TEXT NOT NULL,
  venue              TEXT NOT NULL,
  venue_order_id     TEXT,
  status             TEXT NOT NULL,       -- submitted | open | partially_filled | filled | cancelled | rejected | expired
  venue_status_known INTEGER NOT NULL DEFAULT 1,
  filled_quantity    TEXT NOT NULL DEFAULT '0',
  settlement_status  TEXT NOT NULL,       -- pending | settled | released
  receipt_id         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_events (
  id           TEXT PRIMARY KEY,          -- event id supplied by the execution integration
  order_id     TEXT NOT NULL REFERENCES orders(id),
  type         TEXT NOT NULL,             -- accepted | fill | cancelled | rejected | expired | status_unknown
  quantity     TEXT,
  price        TEXT,
  source       TEXT NOT NULL,             -- "simulated" or "venue:<name>"
  effect       TEXT NOT NULL,             -- what ConDex did with the event
  receipt_id   TEXT,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL UNIQUE REFERENCES orders(id),
  token_id             TEXT NOT NULL,
  borrower_id          TEXT NOT NULL,
  creator_id           TEXT NOT NULL,
  payout_account       TEXT NOT NULL,
  fee_yocto            TEXT NOT NULL,
  first_fill_event_id  TEXT NOT NULL,
  evidence_source      TEXT NOT NULL,
  settle_tx            TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

-- Mock NEAR ledger -------------------------------------------------------
-- Stands in for the NEAR contract until it is deployed. Keyed by NEAR account id.
CREATE TABLE IF NOT EXISTS ledger_balances (
  account         TEXT PRIMARY KEY,
  available_yocto TEXT NOT NULL DEFAULT '0',
  reserved_yocto  TEXT NOT NULL DEFAULT '0',
  earned_yocto    TEXT NOT NULL DEFAULT '0'
);

CREATE TABLE IF NOT EXISTS ledger_tokens (
  token_id        TEXT PRIMARY KEY,
  owner           TEXT NOT NULL,
  payout_account  TEXT NOT NULL,
  fee_yocto       TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  mint_tx         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_reserves (
  order_id      TEXT PRIMARY KEY,
  token_id      TEXT NOT NULL,
  payer         TEXT NOT NULL,
  payee         TEXT NOT NULL,
  amount_yocto  TEXT NOT NULL,
  status        TEXT NOT NULL,            -- reserved | settled | released
  reserve_tx    TEXT NOT NULL,
  final_tx      TEXT
);

CREATE TABLE IF NOT EXISTS ledger_txs (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  method      TEXT NOT NULL,
  args        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

const ALL_TABLES = [
  "ledger_txs", "ledger_reserves", "ledger_tokens", "ledger_balances",
  "receipts", "execution_events", "orders", "quotes", "reads",
  "insight_versions", "insights", "api_keys", "accounts",
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

/** Deletes every row. Used by the dev reset route and tests. */
export function wipeDb(db: Db): void {
  transaction(db, () => {
    for (const table of ALL_TABLES) db.exec(`DELETE FROM ${table}`);
  });
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction.
 * `fn` must be synchronous: SQLite access here is synchronous, so nothing else
 * can interleave with the transaction.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
