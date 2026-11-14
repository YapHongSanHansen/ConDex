// The shapes the pages use. The client in this folder implements the interfaces at the bottom of this file.
// What the backend actually sends is in `wire.ts`, and `adapters.ts` converts between the two.

import type {
  Balances, Challenge, ClosingOrder, IssueKeyBody, IssuedKey, McpState, McpTool, Me, Order, PlaceOrderBody, PublisherProfile,
  Quote, ReadInsight, SignInResult, SubscriptionStatus, ThesisProof, VerifyBody,
} from "./wire";

export type Horizon = "intraday" | "days" | "weeks";
export type InsightStatus = "live" | "expired" | "revoked";
export type SortKey = "newest" | "cheapest" | "expiring";

/** Public preview only. Private text is never part of this type. */
export interface Insight {
  id: string;
  market: string;
  horizon: Horizon;
  /** Flat usage fee per filled linked trade, in NEAR. */
  price: number;
  expires_at: string; // ISO 8601
  /** Prices up to here are used to judge the thesis. */
  evaluation_deadline: string;
  version: number;
  creator: string; // NEAR account id
  status: InsightStatus;
  created_at: string;
  direction: "long" | "short";
  title: string;
}

export interface InsightVersion {
  version: number;
  version_hash: string;
  created_at: string;
  /** The token id of this version, which has its own page. */
  id: string;
}

export interface InsightDetail extends Insight {
  version_hash: string;
  register_tx_hash: string | null;
  versions: InsightVersion[];
  summary: string | null;
  accuracy_pct: number | null;
  /** How many of the author's theses were judged. */
  judged: number;
}

export interface ListInsightsParams {
  market?: string;
  horizon?: Horizon;
  direction?: "long" | "short";
  /** Expired theses are left out unless this is true. */
  include_expired?: boolean;
  max_price?: number;
  expiry?: "soon" | "later";
  sort?: SortKey;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}

/** An API key as the Connect page lists it. The secret is never part of it. */
export interface KeyRow {
  id: string;
  /** First characters only, so the key can be recognised without being exposed. */
  prefix: string;
  label: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
  /** Set once the MCP server has said hello with this key. null means no agent has used it as MCP. */
  mcp: McpState | null;
}

export interface Stats {
  insights_listed: number;
  /** Orders linked to a thesis in the last 24 hours. null when the backend cannot say. */
  trades_today: number | null;
  paid_to_creators: number | null; // NEAR
}

/** One fee paid for a linked trade, joined with its thesis so the page can name the market. */
export interface Receipt {
  id: string;
  date: string;
  insight_id: string;
  market: string;
  version: number;
  order_id: string;
  fee: number;
  evidence: string;
  tx_hash: string;
  ledger: string;
  /** earned: this account was the creator. paid: it was the trader who paid the fee. */
  role: "earned" | "paid";
}

/** What a creator sees on the Payouts page. */
export interface Earnings {
  /** Fees paid to this account, from linked orders that filled. */
  earned: number;
  /** In the contract or mock ledger, free to withdraw. */
  available: number;
  /** Held for orders that have not filled yet. */
  reserved: number;
  ledger: string;
}

export interface ApiErrorShape {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}

export type ApiErrorCode =
  | "network_down"
  | "key_expired"
  | "key_invalid"
  | "missing_scope"
  | "session_required"
  | "subscription_required"
  | "insufficient_funds"
  | "quote_expired"
  | "insight_expired"
  | "thesis_mismatch"
  | "over_budget"
  | "insight_revoked"
  | "not_found"
  | "validation"
  | "unauthorized"
  | "contract_not_configured"
  | "wallet_rejected"
  | "server_error"
  | "unknown";

export interface InsightsApi {
  listInsights(params: ListInsightsParams): Promise<Page<Insight>>;
  getInsight(id: string): Promise<InsightDetail>;
  getStats(): Promise<Stats>;
  /** The markets that have a published thesis, for the gallery's filter. */
  listMarkets(): Promise<string[]>;
}

export interface CloseTradeInput { quantity?: string | null; limit_price?: string | null }

/** Reading a full thesis, quoting, ordering and closing. A wallet session has the read and trade scopes. */
export interface TradingApi {
  subscription(): Promise<SubscriptionStatus>;
  /** Pays one subscription period from the account's balance. */
  subscribe(): Promise<SubscriptionStatus>;
  /** Test NEAR on the mock ledger. On NEAR the account deposits to the contract itself. */
  deposit(amountNear: string): Promise<Balances>;
  balances(account: string): Promise<Balances>;
  /** The full thesis. Needs an active subscription, except for its creator. */
  read(tokenId: string): Promise<ReadInsight>;
  /** Public: the proof of thesis, its evaluation and every proof of trade. */
  proof(tokenId: string): Promise<ThesisProof>;
  quote(tokenId: string): Promise<Quote>;
  placeOrder(body: PlaceOrderBody): Promise<Order>;
  closeOrder(orderId: string, body: CloseTradeInput): Promise<ClosingOrder>;
  listOrders(): Promise<Order[]>;
  getOrder(orderId: string): Promise<Order>;
  /** Which ledger the backend runs on, and its contract when it is NEAR. */
  ledger(): Promise<{ kind: "mock" | "near"; contractId: string | null }>;
  /** After the trader signed `reserve_fee`: the backend checks it on chain and submits the order. */
  confirmApproval(orderId: string): Promise<Order>;
}

export interface CreatorsApi {
  /** Public: the creator's score, stats and published theses. */
  profile(account: string): Promise<PublisherProfile>;
  /** Fees this account has paid (as a trader) or earned (as a creator), newest first. */
  receipts(): Promise<Receipt[]>;
  earnings(account: string): Promise<Earnings>;
}

/** Wallet sign-in (NEP-413). A wallet session is what can issue keys. */
export interface AuthApi {
  challenge(): Promise<Challenge>;
  verify(body: VerifyBody): Promise<SignInResult>;
  logout(): Promise<unknown>;
  me(): Promise<Me>;
}

/** API keys for agents, and the MCP connection they prove. All of these need a wallet session. */
export interface KeysApi {
  list(): Promise<KeyRow[]>;
  /** The secret comes back once and is never listed again. */
  issue(body: IssueKeyBody): Promise<IssuedKey>;
  revoke(keyId: string): Promise<KeyRow>;
  mcpTools(): Promise<McpTool[]>;
  /** Revokes this account's MCP keys. Claude Code keeps its config, but every call now fails. */
  disconnectMcp(): Promise<{ revoked: number }>;
}

export interface Api {
  insights: InsightsApi;
  trading: TradingApi;
  creators: CreatorsApi;
  auth: AuthApi;
  keys: KeysApi;
}
