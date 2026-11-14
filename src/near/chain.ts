import { createHash } from "node:crypto";
import type { NearLedgerConfig } from "../config.ts";
import type { Db } from "../db.ts";
import { NearLedger } from "../ledger/nearLedger.ts";
import { nowIso } from "../util.ts";
import type { ChainClient } from "./chainClient.ts";
import { ChainSender } from "./chainSender.ts";

/** How long a subscription read from the contract is trusted before asking again. */
const SUBSCRIPTION_TTL_MS = 30_000;

interface SubscriptionView { account_id: string; subscribed_until: number; active: boolean; price: string; period: number }
interface BalanceView { account_id: string; available: string; reserved: string; earned_total: string }
export interface ReserveView {
  order_id: string; token_id: string; payer: string; amount: string; order_hash: string;
  status: "reserved" | "settled" | "released";
}

/**
 * Everything the API needs to run on the ConDex contract: the ledger that queues ConDex's own calls, the
 * sender that delivers them, and reads of what traders did themselves (subscriptions, balances, approvals).
 */
export class NearChain {
  readonly client: ChainClient;
  readonly ledger: NearLedger;
  readonly sender: ChainSender;
  /** The contract's current subscription terms, once read. */
  terms: { priceYocto: bigint; periodMs: number } | null = null;
  private readonly db: Db;

  constructor(db: Db, client: ChainClient, config: NearLedgerConfig) {
    this.db = db;
    this.client = client;
    this.ledger = new NearLedger(db);
    this.sender = new ChainSender(db, client, {
      operator: { accountId: config.operatorId, secretKey: config.operatorKey },
      reporter: { accountId: config.reporterId, secretKey: config.reporterKey },
    });
  }

  /** Asks the contract until when this account is subscribed, unless it was asked in the last 30 seconds. */
  async refreshSubscription(account: string, force = false): Promise<void> {
    const cached = this.db.prepare("SELECT checked_at FROM chain_subscriptions WHERE account = ?").get(account) as
      | { checked_at: string } | undefined;
    if (!force && cached && Date.now() - Date.parse(cached.checked_at) < SUBSCRIPTION_TTL_MS) return;
    const view = await this.client.view<SubscriptionView>("subscription_of", { account_id: account });
    this.terms = { priceYocto: BigInt(view.price), periodMs: view.period };
    const until = view.subscribed_until > 0 ? new Date(view.subscribed_until).toISOString() : null;
    this.db.prepare(
      `INSERT INTO chain_subscriptions (account, subscribed_until, checked_at) VALUES (?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET subscribed_until = excluded.subscribed_until, checked_at = excluded.checked_at`,
    ).run(account, until, nowIso());
  }

  /** What the contract last said (see refreshSubscription), or null when the account never subscribed. */
  subscribedUntil(account: string): string | null {
    const row = this.db.prepare("SELECT subscribed_until FROM chain_subscriptions WHERE account = ?").get(account) as
      | { subscribed_until: string | null } | undefined;
    return row?.subscribed_until ?? null;
  }

  async balanceOf(account: string) {
    const b = await this.client.view<BalanceView>("balance_of", { account_id: account });
    return { availableYocto: BigInt(b.available), reservedYocto: BigInt(b.reserved), earnedYocto: BigInt(b.earned_total) };
  }

  async reserveOf(orderId: string): Promise<ReserveView | null> {
    return await this.client.view<ReserveView | null>("get_reserve", { order_id: orderId });
  }
}

/**
 * The fingerprint of an order the trader approves with reserve_fee, as docs/near-contract.md defines it.
 * The reporter later sends the same market, side and quantity, and the contract rebuilds and compares it.
 */
export function orderHash(o: { orderId: string; tokenId: string; market: string; side: string; quantity: string }): string {
  return createHash("sha256").update(`condex-order-v1|${o.orderId}|${o.tokenId}|${o.market}|${o.side}|${o.quantity}`).digest("hex");
}
