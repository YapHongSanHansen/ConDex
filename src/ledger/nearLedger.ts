import { type Db, transaction } from "../db.ts";
import { conflict, forbidden } from "../errors.ts";
import { newId, nowIso } from "../util.ts";
import type { CloseInput, EvaluationInput, Ledger, LedgerBalance, LedgerReserve, LedgerTx, MintInput } from "./ledger.ts";
import { MockLedger } from "./mockLedger.ts";

/** Which of ConDex's two NEAR accounts signs a call. */
export type ChainSigner = "operator" | "reporter";

export interface OutboxRow {
  seq: number; id: string; signer: ChainSigner; method: string; args: string | null; ref: string | null;
  status: "queued" | "sent" | "failed"; attempts: number; next_try_at: string; tx_hash: string | null;
  error: string | null; created_at: string; sent_at: string | null;
}

/**
 * The ledger when ConDex runs on the NEAR contract (CONDEX_LEDGER=near).
 *
 * Services call the ledger synchronously inside SQLite transactions, so this keeps a local mirror with the
 * same rules as MockLedger and, in the same transaction, queues the matching contract call in `chain_outbox`.
 * ChainSender (src/near/chainSender.ts) then sends the queue in order. Until a call is sent, its tx is
 * "pending:<id>"; the sender replaces it with the real hash wherever it was stored.
 *
 * Deposits, subscriptions and the fee approval are signed by the trader's own account, so ConDex never makes
 * them: the API reads them from the contract instead (see services/orders.ts confirmApproval).
 */
export class NearLedger implements Ledger {
  readonly kind = "near-testnet" as const;
  private readonly db: Db;
  private readonly mirror: MockLedger;

  constructor(db: Db) {
    this.db = db;
    this.mirror = new MockLedger(db);
  }

  mintToken(input: MintInput) {
    return transaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM ledger_tokens WHERE token_id = ?").get(input.tokenId)) {
        throw conflict("token_exists", `Token ${input.tokenId} is already minted`);
      }
      const tx = this.enqueue("operator", "mint_thesis", {
        token_id: input.tokenId,
        owner: input.owner,
        payout_account: input.payoutAccount,
        fee: input.feeYocto.toString(),
        content_hash: input.contentHash,
        issued_at: Date.parse(input.issuedAt),
        expires_at: Date.parse(input.expiresAt),
        expiry_set_by: input.expirySetBy,
      }, input.tokenId);
      this.db.prepare(
        `INSERT INTO ledger_tokens (token_id, owner, payout_account, fee_yocto, content_hash, issued_at, expires_at,
           expiry_set_by, mint_tx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.tokenId, input.owner, input.payoutAccount, input.feeYocto.toString(), input.contentHash,
        input.issuedAt, input.expiresAt, input.expirySetBy, tx,
      );
      return { tx };
    });
  }

  deposit(): { tx: string } {
    throw forbidden("deposit_on_chain", "Deposit NEAR by calling deposit() on the ConDex contract from your own account");
  }

  /** The local mirror holds no balances. GET /v1/ledger/balances reads the contract's balance_of instead. */
  balanceOf(account: string): LedgerBalance {
    return { account, availableYocto: 0n, reservedYocto: 0n, earnedYocto: 0n };
  }

  reserveFee(): { tx: string } {
    throw conflict("approve_on_chain", "On NEAR the trader approves the fee by calling reserve_fee from their own account");
  }

  chargeSubscription(): { tx: string } {
    throw conflict("sign_on_chain", "On NEAR the trader subscribes by calling subscribe() on the ConDex contract");
  }

  /** Records a reserve the trader made on the contract, after the API checked it (services/orders.ts). */
  mirrorReserve(r: { orderId: string; tokenId: string; payer: string; payee: string; amountYocto: bigint }) {
    this.db.prepare(
      `INSERT INTO ledger_reserves (order_id, token_id, payer, payee, amount_yocto, status, reserve_tx)
       VALUES (?, ?, ?, ?, ?, 'reserved', 'on-chain:reserve_fee')`,
    ).run(r.orderId, r.tokenId, r.payer, r.payee, r.amountYocto.toString());
  }

  settleFee(orderId: string, receiptId: string) {
    // The proof (the order and its first fill) is built from the database when the call is sent.
    return this.finalise(orderId, "settled", () => this.enqueue("reporter", "settle_fee", { order_id: orderId, receipt_id: receiptId }, receiptId));
  }

  releaseFee(orderId: string) {
    return this.finalise(orderId, "released", () => this.enqueue("reporter", "release_fee", { order_id: orderId }, orderId));
  }

  getReserve(orderId: string): LedgerReserve | undefined {
    return this.mirror.getReserve(orderId);
  }

  recordClose(orderId: string, close: CloseInput) {
    return {
      tx: this.enqueue("reporter", "record_close", {
        order_id: orderId, event_id: close.eventId, quantity: close.quantity, price: close.price,
        closed_at: Date.parse(close.closedAt), source: close.source,
      }, orderId),
    };
  }

  recordEvaluation(tokenId: string, e: EvaluationInput) {
    const ms = (iso: string | null) => (iso === null ? null : Date.parse(iso));
    return {
      tx: this.enqueue("reporter", "record_evaluation", {
        token_id: tokenId, outcome: e.outcome, conditions_met: e.conditionsMet, reference_price: e.referencePrice,
        final_price: e.finalPrice, entered_at: ms(e.enteredAt), target_hit_at: ms(e.targetHitAt),
        invalidated_at: ms(e.invalidatedAt), prices_used: e.pricesUsed, source: e.source,
      }, tokenId),
    };
  }

  /** The calls ConDex signs, newest first, with their status on NEAR. */
  listTxs(limit: number): LedgerTx[] {
    const rows = this.db.prepare("SELECT * FROM chain_outbox ORDER BY seq DESC LIMIT ?").all(limit) as unknown as OutboxRow[];
    return rows.map((r) => ({
      id: r.tx_hash ?? r.id,
      seq: r.seq,
      method: r.method,
      args: { ...(r.args ? JSON.parse(r.args) : {}), status: r.status, ...(r.error ? { error: r.error } : {}) },
      createdAt: r.created_at,
    }));
  }

  // ---- internals ----

  private enqueue(signer: ChainSigner, method: string, args: object, ref: string): string {
    const id = `pending:${newId("call")}`;
    const now = nowIso();
    this.db.prepare(
      "INSERT INTO chain_outbox (id, signer, method, args, ref, status, next_try_at, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
    ).run(id, signer, method, JSON.stringify(args), ref, now, now);
    return id;
  }

  /** Same rules as MockLedger: final once, and calling again for the same outcome returns the first tx. */
  private finalise(orderId: string, target: "settled" | "released", queue: () => string) {
    return transaction(this.db, () => {
      const reserve = this.getReserve(orderId);
      if (!reserve) throw conflict("no_reserve", `Order ${orderId} has no fee reserve`);
      if (reserve.status === target) return { tx: reserve.finalTx!, alreadyFinal: true };
      if (reserve.status !== "reserved") throw conflict("reserve_final", `Reserve for ${orderId} is already ${reserve.status}`);
      const tx = queue();
      this.db.prepare("UPDATE ledger_reserves SET status = ?, final_tx = ? WHERE order_id = ?").run(target, tx, orderId);
      return { tx, alreadyFinal: false };
    });
  }
}
