import { type Db, transaction } from "../db.ts";
import { conflict, paymentRequired } from "../errors.ts";
import { nowIso, sha256Hex } from "../util.ts";
import type { CloseInput, Ledger, LedgerBalance, LedgerReserve, LedgerTx, MintInput } from "./ledger.ts";

interface BalanceRow { account: string; available_yocto: string; reserved_yocto: string; earned_yocto: string }
interface ReserveRow {
  order_id: string; token_id: string; payer: string; payee: string; amount_yocto: string;
  status: LedgerReserve["status"]; reserve_tx: string; final_tx: string | null;
}

/** SQLite stand-in for the NEAR contract. Every call writes a pseudo-transaction to `ledger_txs`. */
export class MockLedger implements Ledger {
  readonly kind = "mock" as const;
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  mintToken(input: MintInput) {
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT mint_tx FROM ledger_tokens WHERE token_id = ?").get(input.tokenId) as
        | { mint_tx: string } | undefined;
      if (existing) throw conflict("token_exists", `Token ${input.tokenId} is already minted`);
      const tx = this.recordTx("mint_insight_token", {
        token_id: input.tokenId,
        owner: input.owner,
        payout_account: input.payoutAccount,
        fee_yocto: input.feeYocto.toString(),
        content_hash: input.contentHash,
        issued_at: input.issuedAt,
        expires_at: input.expiresAt,
        expiry_set_by: input.expirySetBy,
      });
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

  deposit(account: string, amountYocto: bigint) {
    return transaction(this.db, () => {
      const bal = this.balanceOf(account);
      this.writeBalance({ ...bal, availableYocto: bal.availableYocto + amountYocto });
      return { tx: this.recordTx("deposit", { account, amount_yocto: amountYocto.toString() }) };
    });
  }

  balanceOf(account: string): LedgerBalance {
    const row = this.db.prepare("SELECT * FROM ledger_balances WHERE account = ?").get(account) as BalanceRow | undefined;
    return {
      account,
      availableYocto: BigInt(row?.available_yocto ?? 0),
      reservedYocto: BigInt(row?.reserved_yocto ?? 0),
      earnedYocto: BigInt(row?.earned_yocto ?? 0),
    };
  }

  reserveFee(input: { orderId: string; tokenId: string; payer: string; payee: string; amountYocto: bigint }) {
    return transaction(this.db, () => {
      if (this.getReserve(input.orderId)) throw conflict("reserve_exists", `Order ${input.orderId} already has a reserve`);
      const bal = this.balanceOf(input.payer);
      if (bal.availableYocto < input.amountYocto) {
        throw paymentRequired(
          "insufficient_balance",
          `${input.payer} has ${bal.availableYocto} yocto available but the fee needs ${input.amountYocto}`,
        );
      }
      this.writeBalance({
        ...bal,
        availableYocto: bal.availableYocto - input.amountYocto,
        reservedYocto: bal.reservedYocto + input.amountYocto,
      });
      const tx = this.recordTx("reserve_fee", {
        order_id: input.orderId, token_id: input.tokenId, payer: input.payer, payee: input.payee,
        amount_yocto: input.amountYocto.toString(),
      });
      this.db.prepare(
        `INSERT INTO ledger_reserves (order_id, token_id, payer, payee, amount_yocto, status, reserve_tx)
         VALUES (?, ?, ?, ?, ?, 'reserved', ?)`,
      ).run(input.orderId, input.tokenId, input.payer, input.payee, input.amountYocto.toString(), tx);
      return { tx };
    });
  }

  chargeSubscription(input: { subscriptionId: string; payer: string; payee: string; amountYocto: bigint }) {
    return transaction(this.db, () => {
      const existing = this.db.prepare("SELECT tx FROM ledger_subscriptions WHERE subscription_id = ?").get(input.subscriptionId) as
        | { tx: string } | undefined;
      if (existing) return { tx: existing.tx };
      const payer = this.balanceOf(input.payer);
      if (payer.availableYocto < input.amountYocto) {
        throw paymentRequired(
          "insufficient_balance",
          `${input.payer} has ${payer.availableYocto} yocto available but the subscription needs ${input.amountYocto}`,
        );
      }
      this.writeBalance({ ...payer, availableYocto: payer.availableYocto - input.amountYocto });
      const payee = this.balanceOf(input.payee);
      this.writeBalance({ ...payee, earnedYocto: payee.earnedYocto + input.amountYocto });
      const tx = this.recordTx("charge_subscription", {
        subscription_id: input.subscriptionId, payer: input.payer, payee: input.payee, amount_yocto: input.amountYocto.toString(),
      });
      this.db.prepare("INSERT INTO ledger_subscriptions (subscription_id, payer, payee, amount_yocto, tx) VALUES (?, ?, ?, ?, ?)")
        .run(input.subscriptionId, input.payer, input.payee, input.amountYocto.toString(), tx);
      return { tx };
    });
  }

  settleFee(orderId: string, receiptId: string) {
    return this.finalise(orderId, "settled", (reserve) => {
      const payer = this.balanceOf(reserve.payer);
      this.writeBalance({ ...payer, reservedYocto: payer.reservedYocto - reserve.amountYocto });
      const payee = this.balanceOf(reserve.payee);
      this.writeBalance({ ...payee, earnedYocto: payee.earnedYocto + reserve.amountYocto });
      return this.recordTx("settle_fee", {
        order_id: orderId, receipt_id: receiptId, payee: reserve.payee, amount_yocto: reserve.amountYocto.toString(),
      });
    });
  }

  releaseFee(orderId: string) {
    return this.finalise(orderId, "released", (reserve) => {
      const payer = this.balanceOf(reserve.payer);
      this.writeBalance({
        ...payer,
        reservedYocto: payer.reservedYocto - reserve.amountYocto,
        availableYocto: payer.availableYocto + reserve.amountYocto,
      });
      return this.recordTx("release_fee", {
        order_id: orderId, payer: reserve.payer, amount_yocto: reserve.amountYocto.toString(),
      });
    });
  }

  getReserve(orderId: string): LedgerReserve | undefined {
    const row = this.db.prepare("SELECT * FROM ledger_reserves WHERE order_id = ?").get(orderId) as ReserveRow | undefined;
    if (!row) return undefined;
    return {
      orderId: row.order_id, tokenId: row.token_id, payer: row.payer, payee: row.payee,
      amountYocto: BigInt(row.amount_yocto), status: row.status, reserveTx: row.reserve_tx, finalTx: row.final_tx,
    };
  }

  recordClose(orderId: string, close: CloseInput) {
    return {
      tx: this.recordTx("record_close", {
        order_id: orderId, event_id: close.eventId, quantity: close.quantity, price: close.price,
        closed_at: close.closedAt, source: close.source,
      }),
    };
  }

  listTxs(limit: number): LedgerTx[] {
    const rows = this.db.prepare("SELECT * FROM ledger_txs ORDER BY seq DESC LIMIT ?").all(limit) as unknown as Array<{
      id: string; seq: number; method: string; args: string; created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, seq: r.seq, method: r.method, args: JSON.parse(r.args), createdAt: r.created_at }));
  }

  // ---- internals ----

  private finalise(orderId: string, target: "settled" | "released", apply: (r: LedgerReserve) => string) {
    return transaction(this.db, () => {
      const reserve = this.getReserve(orderId);
      if (!reserve) throw conflict("no_reserve", `Order ${orderId} has no fee reserve`);
      if (reserve.status === target) return { tx: reserve.finalTx!, alreadyFinal: true };
      if (reserve.status !== "reserved") {
        throw conflict("reserve_final", `Reserve for ${orderId} is already ${reserve.status}`);
      }
      const tx = apply(reserve);
      this.db.prepare("UPDATE ledger_reserves SET status = ?, final_tx = ? WHERE order_id = ?").run(target, tx, orderId);
      return { tx, alreadyFinal: false };
    });
  }

  private writeBalance(b: LedgerBalance) {
    this.db.prepare(
      `INSERT INTO ledger_balances (account, available_yocto, reserved_yocto, earned_yocto) VALUES (?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET available_yocto = excluded.available_yocto,
         reserved_yocto = excluded.reserved_yocto, earned_yocto = excluded.earned_yocto`,
    ).run(b.account, b.availableYocto.toString(), b.reservedYocto.toString(), b.earnedYocto.toString());
  }

  private recordTx(method: string, args: Record<string, unknown>): string {
    const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM ledger_txs").get() as { seq: number };
    const createdAt = nowIso();
    const id = `mocktx_${sha256Hex(`${seq}:${method}:${JSON.stringify(args)}:${createdAt}`).slice(0, 16)}`;
    this.db.prepare("INSERT INTO ledger_txs (id, seq, method, args, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, seq, method, JSON.stringify(args), createdAt);
    return id;
  }
}
