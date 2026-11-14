import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Bump when the schema changes. Only matters for the opt-in file store (see `openDb`). */
export const SCHEMA_VERSION = 14;

const SCHEMA = `
-- Accounts and credentials ---------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id               TEXT PRIMARY KEY,
  near_account_id  TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  -- While keys are not checked on NEAR (dev mode), the first key that signs in is the only one
  -- accepted afterwards, so nobody else can sign in as an account that already exists.
  dev_public_key   TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  key_hash      TEXT NOT NULL UNIQUE,
  key_prefix    TEXT NOT NULL,
  label         TEXT NOT NULL,
  scopes        TEXT NOT NULL,          -- JSON array: publish | read | trade
  token_ids     TEXT,                   -- JSON array; NULL means any token
  key_check     TEXT NOT NULL,          -- how the issuing wallet sign-in was checked: "near-rpc" or "none"
  expires_at    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);

-- Wallet sign-in --------------------------------------------------------
-- One-time NEP-413 challenges. The wallet signs { message, nonce, recipient }.
-- Anyone can request one, so they are limited per client and in total, and pruned (services/auth.ts).
CREATE TABLE IF NOT EXISTS auth_challenges (
  nonce       TEXT PRIMARY KEY,         -- base64 of 32 random bytes
  message     TEXT NOT NULL,
  recipient   TEXT NOT NULL,
  client      TEXT NOT NULL,            -- address of the client that asked for it
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_challenges_expires ON auth_challenges (expires_at);
CREATE INDEX IF NOT EXISTS auth_challenges_client ON auth_challenges (client, created_at);

-- Website sessions, created only by a verified wallet signature.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  token_hash   TEXT NOT NULL UNIQUE,
  public_key   TEXT NOT NULL,           -- the wallet key that signed in, "ed25519:..."
  key_check    TEXT NOT NULL,           -- "near-rpc" or "none" (dev mode)
  expires_at   TEXT NOT NULL,           -- expired sessions are deleted at each new sign-in
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);

-- Insights (private storage) ------------------------------------------
CREATE TABLE IF NOT EXISTS insights (
  id          TEXT PRIMARY KEY,
  creator_id  TEXT NOT NULL REFERENCES accounts(id),
  created_at  TEXT NOT NULL
);

-- Each published version gets its own token. A version is never edited: its conditions and expiry
-- are fixed when it is published, and covered by content_hash.
CREATE TABLE IF NOT EXISTS insight_versions (
  token_id          TEXT PRIMARY KEY,
  insight_id        TEXT NOT NULL REFERENCES insights(id),
  version           INTEGER NOT NULL,
  creator_id        TEXT NOT NULL REFERENCES accounts(id),
  payout_account    TEXT NOT NULL,
  fee_yocto         TEXT NOT NULL,
  title             TEXT NOT NULL,
  summary           TEXT,
  -- Thesis conditions. Market and direction are public and checked against linked orders;
  -- entry, invalidation and target are the creator's words, served with the conversation.
  market            TEXT NOT NULL,
  direction         TEXT NOT NULL,      -- long | short
  entry             TEXT NOT NULL,
  invalidation      TEXT NOT NULL,
  target            TEXT,
  -- Optional price levels for the same conditions, so ConDex can evaluate them against market data.
  entry_price        TEXT,
  invalidation_price TEXT,
  target_price       TEXT,
  -- Expiry. Every version has one.
  expires_at        TEXT NOT NULL,      -- ISO 8601, UTC
  expiry_time_given INTEGER NOT NULL,   -- 0: only a date was set, so it expires at the end of that day
  expiry_set_by     TEXT NOT NULL,      -- creator | condex_ai | condex_default
  expiry_reason     TEXT,               -- why ConDex chose it; NULL when the creator set it
  evaluation_deadline TEXT NOT NULL,    -- ISO 8601, UTC; the thesis is judged on prices up to here. Never before expires_at
  messages          TEXT NOT NULL,      -- JSON array, private: served only to read-scoped keys
  content_hash      TEXT NOT NULL,
  mint_tx           TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  replayed          INTEGER NOT NULL DEFAULT 0,  -- 1: published while the dev replay clock was set, so its times are replayed, not real
  UNIQUE (insight_id, version)
);

CREATE TABLE IF NOT EXISTS reads (
  id               TEXT PRIMARY KEY,
  token_id         TEXT NOT NULL REFERENCES insight_versions(token_id),
  reader_id        TEXT NOT NULL REFERENCES accounts(id),
  key_id           TEXT NOT NULL,        -- API key id or session id
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
  key_id             TEXT NOT NULL,      -- API key id or session id
  token_id           TEXT NOT NULL REFERENCES insight_versions(token_id),
  quote_id           TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  market             TEXT NOT NULL,
  side               TEXT NOT NULL,       -- buy | sell
  quantity           TEXT NOT NULL,
  limit_price        TEXT,
  fee_yocto          TEXT NOT NULL,
  venue              TEXT NOT NULL,
  venue_order_id     TEXT,
  status             TEXT NOT NULL,       -- awaiting_approval | submitted | open | partially_filled | filled | cancelled | rejected | expired
  venue_status_known INTEGER NOT NULL DEFAULT 1,
  filled_quantity    TEXT NOT NULL DEFAULT '0',
  settlement_status  TEXT NOT NULL,       -- pending | settled | released
  receipt_id         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- A closing order brings a trade back to flat. No fee and no quote: its fills are the closing fills of the proof of trade.
CREATE TABLE IF NOT EXISTS closing_orders (
  id               TEXT PRIMARY KEY,      -- cls_...
  order_id         TEXT NOT NULL REFERENCES orders(id),
  borrower_id      TEXT NOT NULL REFERENCES accounts(id),
  side             TEXT NOT NULL,         -- opposite of the opening order
  quantity         TEXT NOT NULL,
  limit_price      TEXT,
  venue            TEXT NOT NULL,
  venue_order_id   TEXT,
  status           TEXT NOT NULL,         -- submitted | open | partially_filled | filled | cancelled | rejected | expired
  filled_quantity  TEXT NOT NULL DEFAULT '0',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS closing_events (
  id           TEXT PRIMARY KEY,          -- event id supplied by the execution integration
  closing_id   TEXT NOT NULL REFERENCES closing_orders(id),
  type         TEXT NOT NULL,
  quantity     TEXT,
  price        TEXT,
  source       TEXT NOT NULL,             -- "simulated" or "venue:<name>"
  effect       TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS execution_events (
  id           TEXT PRIMARY KEY,          -- event id supplied by the execution integration
  order_id     TEXT NOT NULL REFERENCES orders(id),
  type         TEXT NOT NULL,             -- accepted | fill | cancelled | rejected | expired | status_unknown | close
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

-- Subscriptions ------------------------------------------------------------
-- One period per payment. A renewal starts when the current period ends.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts(id),
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  amount_yocto  TEXT NOT NULL,
  tx            TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_by_account ON subscriptions (account_id, ends_at);

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
  issued_at       TEXT NOT NULL,          -- when the thesis was published
  expires_at      TEXT NOT NULL,          -- when it expires
  expiry_set_by   TEXT NOT NULL,          -- creator | condex_ai | condex_default
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

CREATE TABLE IF NOT EXISTS ledger_subscriptions (
  subscription_id  TEXT PRIMARY KEY,
  payer            TEXT NOT NULL,
  payee            TEXT NOT NULL,
  amount_yocto     TEXT NOT NULL,
  tx               TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_txs (
  id          TEXT PRIMARY KEY,
  seq         INTEGER NOT NULL,
  method      TEXT NOT NULL,
  args        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- NEAR contract (CONDEX_LEDGER=near) -----------------------------------
-- Calls ConDex signs, queued in the same transaction as the change they record and sent in order.
CREATE TABLE IF NOT EXISTS chain_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,     -- "pending:<id>" stands in for the tx hash until it is sent
  signer      TEXT NOT NULL,            -- operator | reporter
  method      TEXT NOT NULL,
  args        TEXT,                     -- JSON; NULL when built at send time (settle_fee's proof)
  ref         TEXT,                     -- what the call is about: a token, order or receipt id
  status      TEXT NOT NULL,            -- queued | sent | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT NOT NULL,
  tx_hash     TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT
);

-- What the contract's subscription_of said, kept briefly so reads do not ask NEAR every time.
CREATE TABLE IF NOT EXISTS chain_subscriptions (
  account          TEXT PRIMARY KEY,    -- NEAR account id
  subscribed_until TEXT,                -- ISO 8601; NULL when never subscribed
  checked_at       TEXT NOT NULL
);

-- Market data and thesis evaluation ------------------------------------
-- Prices recorded by the simulated market data feed (src/market/marketData.ts).
CREATE TABLE IF NOT EXISTS market_prices (
  id      TEXT PRIMARY KEY,
  market  TEXT NOT NULL,
  price   TEXT NOT NULL,
  at      TEXT NOT NULL                -- ISO 8601, UTC
);
CREATE INDEX IF NOT EXISTS market_prices_by_time ON market_prices (market, at);

-- Candles fetched from a live market data feed (src/market/coinGecko.ts), kept locally so the evaluation
-- never waits on the network. Prices are decimal text.
CREATE TABLE IF NOT EXISTS market_candles (
  source      TEXT NOT NULL,           -- the feed's name, e.g. "feed:coingecko"
  market      TEXT NOT NULL,
  interval_s  INTEGER NOT NULL,        -- candle length in seconds
  start_s     INTEGER NOT NULL,        -- Unix seconds: when the candle starts
  open        TEXT NOT NULL,
  high        TEXT NOT NULL,
  low         TEXT NOT NULL,
  close       TEXT NOT NULL,
  volume      TEXT NOT NULL,
  PRIMARY KEY (source, market, interval_s, start_s)
);

-- The time ranges whose candles are all in market_candles. A minute with no trades has no candle, so a
-- missing candle inside a covered range means "no trades" and outside one means "not fetched yet".
CREATE TABLE IF NOT EXISTS market_coverage (
  source      TEXT NOT NULL,
  market      TEXT NOT NULL,
  interval_s  INTEGER NOT NULL,
  from_s      INTEGER NOT NULL,        -- Unix seconds: the first candle start covered
  to_s        INTEGER NOT NULL,        -- Unix seconds: candle starts before this are covered
  PRIMARY KEY (source, market, interval_s, from_s)
);

-- Recorded once, after the evaluation deadline, and never changed.
CREATE TABLE IF NOT EXISTS thesis_evaluations (
  token_id          TEXT PRIMARY KEY REFERENCES insight_versions(token_id),
  outcome           TEXT NOT NULL,     -- see Outcome in services/evaluation.ts
  conditions_met    INTEGER,           -- 1 | 0 | NULL when it cannot be judged
  reference_price   TEXT,              -- last price at publish time
  final_price       TEXT,              -- last price at the deadline
  entered_at        TEXT,
  target_hit_at     TEXT,
  invalidated_at    TEXT,
  prices_used       INTEGER NOT NULL,
  source            TEXT NOT NULL,     -- which market data feed
  deadline          TEXT NOT NULL,
  evaluated_at      TEXT NOT NULL,
  evaluation_tx     TEXT                -- recorded on the thesis token (record_evaluation); "pending:<id>" until sent
);
`;

const ALL_TABLES = [
  "chain_subscriptions", "chain_outbox",
  "thesis_evaluations", "market_prices", "market_coverage", "market_candles",
  "ledger_txs", "ledger_subscriptions", "ledger_reserves", "ledger_tokens", "ledger_balances",
  "subscriptions", "closing_events", "closing_orders", "receipts", "execution_events", "orders", "quotes", "reads",
  "insight_versions", "insights", "sessions", "auth_challenges", "api_keys", "accounts",
];

/**
 * Opens the store. ":memory:" (the default) keeps all state inside this process: nothing is written
 * to disk and it starts empty on every restart. SQLite here is only an in-process table engine; it
 * gives multi-step operations (reserve a fee + create the order) all-or-nothing rollback.
 *
 * A file path (opt-in via CONDEX_DB_PATH) keeps data across restarts. There are no migrations, so a
 * file written by a build with a different schema is refused rather than half-used.
 */
export function openDb(path: string): Db {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (!inMemory) {
    const found = storedSchemaVersion(db);
    if (found !== null && found !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `${path} was written by a different version of ConDex (schema ${found}; this build needs ${SCHEMA_VERSION}). ` +
        "Delete it to start fresh, or unset CONDEX_DB_PATH to keep data in memory.",
      );
    }
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/** null for a new, empty file; otherwise the stored version (0 means it predates versioning). */
function storedSchemaVersion(db: Db): number | null {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number };
  if (n === 0) return null;
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
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
