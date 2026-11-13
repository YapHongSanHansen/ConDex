// Shared source of truth for every request/response shape. Mocks and the real
// client both implement the interfaces at the bottom of this file.

export type Horizon = "intraday" | "days" | "weeks";
export type InsightStatus = "live" | "expired" | "revoked";
/** active: fee reserved. retrieved: agent fetched the context, fee still reserved.
 *  traded: agent reported the trade executed, fee charged once and paid out.
 *  expired: reserve released, zero charge. revoked: key blocked. */
export type BorrowStatus = "active" | "retrieved" | "traded" | "expired" | "revoked";
export type ReceiptStatus = "settled" | "pending" | "released";
export type SortKey = "newest" | "cheapest" | "expiring";

/** Public preview only. Private text is never part of this type. */
export interface Insight {
  id: string;
  market: string;
  horizon: Horizon;
  /** Flat retrieval fee, in NEAR. */
  price: number;
  expires_at: string; // ISO 8601
  version: number;
  creator: string; // NEAR account id
  status: InsightStatus;
  created_at: string;
}

export interface InsightVersion {
  version: number;
  version_hash: string;
  created_at: string;
}

export interface InsightDetail extends Insight {
  version_hash: string;
  register_tx_hash: string | null;
  versions: InsightVersion[];
}

export interface ListInsightsParams {
  market?: string;
  horizon?: Horizon;
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

/** Context the creator exported from Claude Code through the MCP server.
 *  Only metadata and a hash reach the platform. The text itself never does. */
export interface PendingExport {
  id: string;
  exported_at: string;
  suggested_market: string;
  suggested_horizon: Horizon;
  message_count: number;
  /** Creator opted to include their own PNL in the private context. Never shown publicly. */
  includes_pnl: boolean;
  version_hash: string;
  /** Present when the creator set it in Claude Code; otherwise chosen on the Publish page. */
  suggested_expires_at: string | null;
  previous_insight_id?: string;
}

export interface PublishExportInput {
  export_id: string;
  market: string;
  horizon: Horizon;
  expires_at: string;
  fee: number;
  payout_account: string;
  /** Hash of the NEAR transaction that registered this version. */
  register_tx_hash: string;
}

export interface PublishExportResult {
  insight: InsightDetail;
}

export interface CreatorKeyInfo {
  has_key: boolean;
  /** First characters only, so the key can be recognised without being exposed. */
  key_prefix: string | null;
  created_at: string | null;
  mcp_connected: boolean;
  mcp_last_seen: string | null;
}

export interface CreatorKeyIssued {
  info: CreatorKeyInfo;
  /** Returned exactly once. Never persist it. */
  api_key: string;
}

export interface Stats {
  insights_listed: number;
  borrows_today: number;
  paid_to_creators: number; // NEAR
}

export interface Borrow {
  id: string;
  insight_id: string;
  market: string;
  insight_version: number;
  status: BorrowStatus;
  fee_cap: number;
  charged: number;
  created_at: string;
  expires_at: string;
  retrieved_at: string | null;
  receipt_id: string | null;
}

export interface CreateBorrowInput {
  fee_cap: number;
  /** Hash of the wallet transaction that reserved the fee, if any. */
  reserve_tx_hash?: string;
}

export interface CreateBorrowResult {
  borrow: Borrow;
  /** Returned exactly once. Never persist it. */
  api_key: string;
}

export interface RetrievedInsight {
  borrow_id: string;
  text: string;
  /** True when this delivery was a repeat under the same borrow. */
  repeat: boolean;
  /** Retrieval never charges. The fee is charged only when a trade is reported. */
  charged_now: number;
}

export interface TradeReportResult {
  borrow: Borrow;
  /** True when this call charged the fee. Repeating the report charges nothing. */
  charged: boolean;
}

export interface Earnings {
  total_earned: number;
  pending: number;
  released: number;
  payout_account: string;
}

export interface Receipt {
  id: string;
  date: string;
  insight_id: string;
  market: string;
  version: number;
  borrower: string;
  fee: number;
  status: ReceiptStatus;
  tx_hash: string;
}

export interface MyInsight {
  id: string;
  market: string;
  version: number;
  status: InsightStatus;
  borrows: number;
  retrievals: number;
  earned: number;
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
}

export interface BorrowsApi {
  createBorrow(insightId: string, input: CreateBorrowInput): Promise<CreateBorrowResult>;
  listBorrows(): Promise<Borrow[]>;
  getBorrow(id: string): Promise<Borrow>;
  revokeBorrow(id: string): Promise<Borrow>;
  retrieveInsight(borrowId: string, apiKey: string): Promise<RetrievedInsight>;
  /** The borrowing agent reports the trade executed. Charges the fee once. Self-reported. */
  reportTrade(borrowId: string, apiKey: string): Promise<TradeReportResult>;
  /** Mock-only helper; undefined on the real implementation. */
  simulateExpiry?(id: string): Promise<Borrow>;
}

export interface CreatorsApi {
  getEarnings(): Promise<Earnings>;
  listReceipts(): Promise<Receipt[]>;
  listMyInsights(): Promise<MyInsight[]>;
  updatePayoutAccount(account: string): Promise<Earnings>;
  getCreatorKey(): Promise<CreatorKeyInfo>;
  createCreatorKey(): Promise<CreatorKeyIssued>;
  listExports(): Promise<PendingExport[]>;
  publishExport(input: PublishExportInput): Promise<PublishExportResult>;
  /** Mock-only helper; undefined on the real implementation. */
  simulateExport?(): Promise<PendingExport>;
}

export interface Api {
  insights: InsightsApi;
  borrows: BorrowsApi;
  creators: CreatorsApi;
}
