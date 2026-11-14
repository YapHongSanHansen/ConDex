// What the ConDex backend actually sends and expects ("wire" shapes).
//
// Source: the backend's `src/api/app.ts` and `src/api/schemas.ts` on branch `backend-mcppublish`, checked
// against real responses. `docs/BACKEND_LINK.md` maps every frontend call to these. The rest of the app keeps
// using the friendlier types in `types.ts`; `adapters.ts` converts between the two.

/** NEAR amounts come as both units. Use `near` for display and `yocto` for exact maths. */
export interface Money { yocto: string; near: string }

export interface WireAccount {
  id: string; // acct_...
  near_account_id: string;
  display_name: string;
  created_at: string;
}

/** `publish` lets an agent publish theses, `read` lets it read a full conversation, `trade` lets it quote and order. */
export type Scope = "publish" | "read" | "trade";
export const SCOPES: readonly Scope[] = ["publish", "read", "trade"];

// ---- wallet sign-in (NEP-413) ----

/** POST /v1/auth/challenge. The wallet signs `message` with `nonce` (base64, 32 bytes) for `recipient`. */
export interface Challenge {
  message: string;
  nonce: string;
  recipient: string;
  network: "testnet" | "mainnet";
  expires_at: string;
}

/** POST /v1/auth/verify. `signature` and `public_key` are exactly what the wallet's signMessage returned. */
export interface VerifyBody {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  /** Only for redirect wallets: the exact callbackUrl the website gave the wallet. */
  callback_url?: string;
  display_name?: string;
}

export interface WireSession {
  id: string; // sess_...
  /** `cdxs_...`. Sent as `Authorization: Bearer`. Only a wallet session can issue keys. */
  token: string;
  expires_at: string;
  wallet_public_key: string;
  key_check: string;
}

export interface SignInResult { account: WireAccount; new_account: boolean; session: WireSession }

/** GET /v1/me */
export interface Me {
  account: WireAccount;
  credential: { type: "session" | "api_key"; id: string; scopes: string[]; token_ids: string[] | null };
}

// ---- keys and MCP ----

/** A key as listed. The secret is never included again. */
export interface WireKey {
  id: string; // key_...
  /** First characters of the secret, so a key can be recognised. */
  prefix: string;
  label: string;
  scopes: Scope[];
  /** Limits a key to these tokens. null means all of the account's reach. */
  token_ids: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

/** POST /v1/keys. `secret` (`cdx_...`) is shown once. */
export interface IssuedKey extends WireKey { secret: string }

export interface IssueKeyBody {
  scopes: Scope[];
  label?: string;
  token_ids?: string[] | null;
  expires_in_seconds?: number | null;
}

/** Set when the MCP server said hello with this key, so "connected" means a real agent process used it. */
export interface McpState {
  connectedAt: string;
  lastSeenAt: string;
  client: string;
  tools: string[];
}

/** GET /v1/keys */
export interface KeyWithMcp extends WireKey { mcp: McpState | null }

/** GET /v1/mcp/tools */
export interface McpTool { name: string; title: string; description: string }

// ---- scores, subscription, stats ----

/** Of the author's theses that were judged, the share whose conditions were met. */
export interface Accuracy { evaluated: number; met: number; accuracy_pct: number | null; pending: number; not_judged: number }

/** What real, fully closed trades of the author's theses returned. Before trading costs. */
export interface TrackRecord { trades: number; net_return_pct: number; net_profit_usd: number; max_drawdown_pct: number; costs: string }

export interface Score { accuracy: Accuracy; borrowers: TrackRecord }

export interface SubscriptionTerms { fee: Money; period_days: number; paid_to: string; unlocks: string; how: string }

/** GET and POST /v1/subscription. */
export interface SubscriptionStatus {
  account_id: string;
  active: boolean;
  subscribed_until: string | null;
  terms: SubscriptionTerms;
  /** Only on POST: the payment just made. */
  payment?: { id: string; starts_at: string; ends_at: string; paid: Money; ledger: string; tx: string };
}

/** GET /v1/stats. Public. */
export interface PlatformStats { insights_live: number; trades_linked_24h: number; fees_paid_to_creators: Money }

// ---- theses ----


export interface Expiry {
  expires_at: string;
  /** Market prices up to here are used to judge the thesis. The same as `expires_at` unless the creator set a later one. */
  evaluation_deadline: string;
  /** UTC calendar day, "YYYY-MM-DD". */
  date: string;
  /** UTC time, "HH:MM:SS". */
  time: string;
  /** false when only a day was given, so the thesis ends at the end of that day. */
  time_given: boolean;
  /** Who set it. `condex_ai` and `condex_default` mean the creator gave none. */
  set_by: "creator" | "condex_ai" | "condex_default";
  /** Why ConDex chose it. null when the creator set it. */
  reason: string | null;
}

export interface Conditions {
  market: string;
  direction: "long" | "short";
  entry: string;
  invalidation: string;
  target: string | null;
}

/** The public part of a thesis version, as listed and previewed. Never includes the conversation. */
export interface TokenPreview {
  /** `<insight_id>-v<version>`. The id of one version. */
  token_id: string;
  insight_id: string;
  version: number;
  title: string;
  market: string;
  direction: "long" | "short";
  summary: string | null;
  published_at: string;
  expires_at: string;
  expired: boolean;
  expiry: Expiry;
  message_count: number;
  creator: WireAccount;
  payout_account: string;
  /** The usage fee, charged once on the first fill of a linked order. */
  fee_per_filled_order: Money;
  /** The author's public score. */
  author_score: Score;
  /** What a subscription costs and what it unlocks. */
  unlock: SubscriptionTerms;
  content_hash: string;
  mint: { ledger: string; tx: string };
  created_at: string;
}

/** POST /v1/insights and /v1/insights/:id/versions */
export interface PublishedToken extends TokenPreview {
  conditions: Conditions;
  /** Present when ConDex chose the expiry, so an agent can tell the creator. */
  notice?: string;
}

export interface PublishBody {
  title: string;
  market: string;
  direction: "long" | "short";
  entry: string;
  invalidation: string;
  target?: string | null;
  summary?: string | null;
  /** UTC. All three omitted means ConDex sets the expiry. */
  expiry_date?: string | null;
  expiry_time?: string | null;
  expires_at?: string | null;
  /** A date or an ISO date-time, on or after the expiry and at most 30 days later. Defaults to the expiry. */
  evaluation_deadline?: string | null;
  entry_price?: string | null;
  invalidation_price?: string | null;
  target_price?: string | null;
  fee_near: string | number;
  payout_account?: string | null;
  messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string; at?: string }>;
}

/** GET /v1/tokens/:id, needs a `read` key. */
export interface ReadInsight extends PublishedToken {
  messages: PublishBody["messages"];
  integrity: { content_hash: string; recomputed_hash: string; matches: boolean };
  charge: Money;
  your_reads: { count: number; total_charged: Money };
}

/** GET /v1/publishers/:nearAccountId */
export interface PublisherProfile {
  publisher: WireAccount;
  score: Score;
  stats: { insights: number; reads: number; paid_orders: number; fees_paid: Money; payout_accounts: string[] };
  tokens: TokenPreview[];
}

// ---- proofs ----

export interface TradeResult {
  available: boolean;
  /** Decimal strings. Only present when `available` is true. */
  entry_price?: string;
  exit_price?: string;
  quantity?: string;
  pnl?: string;
  return_pct?: string;
  outcome?: "win" | "loss" | "flat";
  reason?: string;
}

export interface ClosingFill { event_id: string; at: string; price: string; quantity: string; source: string }

export interface Trade {
  status: "open" | "partially_closed" | "closed";
  direction: "long" | "short";
  opened_quantity: string;
  closed_quantity: string;
  open_quantity: string;
  closing_fills: ClosingFill[];
  closing_fill: ClosingFill | null;
  result: TradeResult | null;
}

/** GET /v1/tokens/:id/proof. Public. */
export interface ThesisProof {
  proof_of_thesis: {
    token_id: string;
    insight_id: string;
    version: number;
    creator: WireAccount;
    published_at: string;
    expires_at: string;
    evaluation_deadline: string;
    expiry: Expiry;
    content_hash: string;
    /** false means the stored content no longer matches its hash. */
    preserved: boolean;
    usage_fee_per_filled_trade: Money;
    payout_account: string;
    mint: { ledger: string; tx: string };
  };
  /** Whether the thesis's conditions were met, judged once against market data after the evaluation deadline. */
  evaluation: Evaluation;
  proofs_of_trade: ProofOfTrade[];
  /** The closed trades of this thesis added up. */
  verified_results: TrackRecord;
}

export type EvaluationOutcome =
  | "target_hit" | "invalidated" | "not_triggered" | "target_missed" | "in_direction" | "against_direction"
  | "already_reached" | "no_data";

export type Evaluation =
  | { status: "pending"; deadline: string; source: string }
  | {
      status: "evaluated";
      outcome: EvaluationOutcome;
      /** null when the thesis could not be judged. */
      conditions_met: boolean | null;
      explanation: string;
      reference_price: string | null;
      final_price: string | null;
      entered_at: string | null;
      target_hit_at: string | null;
      invalidated_at: string | null;
      prices_used: number;
      source: string;
      deadline: string;
      evaluated_at: string;
      recorded: { ledger: string; tx: string | null };
    };

export interface ProofOfTrade {
  receipt_id: string;
  thesis: { token_id: string; content_hash: string };
  trader: string;
  role: "borrower" | "creator";
  order: { id: string; market: string; side: "buy" | "sell"; quantity: string; authorised_at: string; status: string };
  fill: { at: string; price: string; quantity: string; source: string };
  fee_paid: Money;
  settlement: { ledger: string; tx: string };
  trade: Trade;
  closing_fill: ClosingFill | null;
  proven_at: string;
}

// ---- trading ----

/** POST /v1/quotes */
export interface Quote {
  quote_id: string;
  token_id: string;
  fee: Money;
  fee_rule: string;
  payout_account: string;
  content_hash: string;
  expires_at: string;
}

export interface PlaceOrderBody {
  quote_id: string;
  side: "buy" | "sell";
  quantity: string | number;
  market?: string | null;
  limit_price?: string | number | null;
  /** Must be true: the borrower agrees to the fee before the order is linked to the thesis. */
  authorise_fee: boolean;
}

export interface ClosingOrder {
  id: string; // cls_...
  order_id: string;
  side: "buy" | "sell";
  quantity: string;
  limit_price: string | null;
  filled_quantity: string;
  status: string;
  venue: { name: string; order_id: string };
  fills: ClosingFill[];
  created_at: string;
  updated_at: string;
}

/** The reserve_fee call the trader signs to approve an order on the NEAR ledger. */
export interface OrderApproval {
  contract: string;
  method: string;
  args: { order_id: string; token_id: string; fee: string; order_hash: string };
  /** What to call next, once the transaction is signed. */
  then: string;
}

/** POST /v1/orders and GET /v1/orders/:id */
export interface Order {
  id: string; // ord_...
  token_id: string;
  quote_id: string;
  market: string;
  side: "buy" | "sell";
  quantity: string;
  limit_price: string | null;
  filled_quantity: string;
  status: string;
  venue: { name: string; order_id: string; status_known: boolean };
  /** What was checked when the order was linked to the thesis. */
  thesis_match: {
    token_id: string;
    content_hash: string;
    market: string;
    direction: "long" | "short";
    opens_with: "buy" | "sell";
    thesis_expires_at: string;
    authorised_at: string;
    checked: string[];
  };
  fee: Money;
  /** On NEAR, the approval the trader still has to sign. null on the mock ledger. */
  approval: OrderApproval | null;
  settlement: {
    status: "pending" | "settled" | "released" | string;
    receipt_id: string | null;
    ledger: string;
    reserve: { status: string; payer: string; payee: string; reserve_tx: string | null; final_tx: string | null };
  };
  /** null until the first fill. */
  trade: Trade | null;
  closing_orders: ClosingOrder[];
  execution_events: Array<{ id: string; type: string; quantity: string | null; price: string | null; source: string; effect: string; receipt_id: string | null; received_at: string }>;
  created_at: string;
  updated_at: string;
}

/** GET /v1/receipts */
export interface WireReceipt {
  id: string; // rcpt_...
  order_id: string;
  token_id: string;
  borrower_id: string;
  creator_id: string;
  payout_account: string;
  fee: Money;
  first_fill_event_id: string;
  evidence_source: string;
  evidence_label: string;
  settlement: { ledger: string; tx: string };
  created_at: string;
}

/** GET /v1/ledger/balances/:account */
export interface Balances { ledger: string; account: string; available: Money; reserved: Money; earned: Money }

// ---- errors ----

/** Every non-2xx response: `{ error: { code, message, details? } }`. */
export interface WireError { error: { code: string; message: string; details?: unknown } }

/** GET /health */
export interface Health {
  ok: boolean;
  ledger: string;
  venue: string;
  dev_mode: boolean;
  near_network: "testnet" | "mainnet";
  wallet_key_check: string;
  storage: "memory" | "file";
  expiry_ai: boolean;
  /** The NEAR contract, only when the backend runs on the NEAR ledger. */
  contract_id?: string;
  /** The price feed theses are judged on: "simulated", or "feed:<name>" for real prices. */
  market_data?: string;
  /** "replay" while the backend's dev replay clock is set, so thesis and trade times are a past window. */
  clock?: string;
  /** Dev mode, same machine only: the MCP server path, with the home folder shown as $HOME. */
  mcp_server?: string;
}
