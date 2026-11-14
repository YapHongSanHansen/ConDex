import type { Db } from "../db.ts";
import type { ChainSigner, OutboxRow } from "../ledger/nearLedger.ts";
import { nowIso } from "../util.ts";
import { type ChainClient, ContractRefused, type Signer } from "./chainClient.ts";

/** Where a "pending:<id>" tx can be stored, so the real hash replaces it once the call is sent. */
const TX_COLUMNS: Array<[table: string, column: string]> = [
  ["insight_versions", "mint_tx"], ["ledger_tokens", "mint_tx"], ["receipts", "settle_tx"], ["ledger_reserves", "final_tx"],
  ["thesis_evaluations", "evaluation_tx"],
];

const MAX_BACKOFF_MS = 60_000;

/**
 * Sends the calls NearLedger queued, oldest first and one at a time, so the contract sees them in the order
 * the API made them (a mint before the settle that refers to it).
 *
 * - A call the contract refuses is marked failed, with the message, and the queue moves on.
 * - Any other error (network, timeout) keeps the call at the head of the queue and retries it with backoff.
 */
export class ChainSender {
  private readonly db: Db;
  private readonly client: ChainClient;
  private readonly signers: Record<ChainSigner, Signer>;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(db: Db, client: ChainClient, signers: Record<ChainSigner, Signer>) {
    this.db = db;
    this.client = client;
    this.signers = signers;
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sends the next call if one is due. Returns false when there was nothing to send. */
  async tick(): Promise<boolean> {
    if (this.busy) return true;
    const row = this.db.prepare("SELECT * FROM chain_outbox WHERE status = 'queued' ORDER BY seq LIMIT 1").get() as OutboxRow | undefined;
    if (!row || row.next_try_at > nowIso()) return false;
    this.busy = true;
    try {
      const args = row.method === "settle_fee" ? this.withProof(JSON.parse(row.args!)) : JSON.parse(row.args ?? "{}");
      const { txHash } = await this.client.call(this.signers[row.signer], row.method, args);
      this.db.prepare("UPDATE chain_outbox SET status = 'sent', tx_hash = ?, args = ?, sent_at = ?, error = NULL WHERE seq = ?")
        .run(txHash, JSON.stringify(args), nowIso(), row.seq);
      for (const [table, column] of TX_COLUMNS) {
        this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(txHash, row.id);
      }
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 2000);
      // The block clock can be a little behind ours at a thesis's expiry: that refusal is worth trying again.
      const tooEarly = /cannot be evaluated before its deadline/.test(message);
      if ((err instanceof ContractRefused && !tooEarly) || err instanceof ProofMissing) {
        this.db.prepare("UPDATE chain_outbox SET status = 'failed', error = ?, attempts = attempts + 1 WHERE seq = ?").run(message, row.seq);
      } else {
        const wait = Math.min(1000 * 2 ** row.attempts, MAX_BACKOFF_MS);
        this.db.prepare("UPDATE chain_outbox SET attempts = attempts + 1, error = ?, next_try_at = ? WHERE seq = ?")
          .run(message, new Date(Date.now() + wait).toISOString(), row.seq);
      }
    } finally {
      this.busy = false;
    }
    return true;
  }

  /** Sends everything that is queued, ignoring backoff. For tests and scripts. */
  async drain(maxCalls = 1000) {
    for (let i = 0; i < maxCalls; i++) {
      this.db.prepare("UPDATE chain_outbox SET next_try_at = ? WHERE status = 'queued'").run(nowIso());
      const before = this.db.prepare("SELECT COUNT(*) AS n FROM chain_outbox WHERE status = 'queued'").get() as { n: number };
      if (before.n === 0) return;
      await this.tick();
    }
  }

  /** settle_fee needs the order as the trader approved it and its first fill, as docs/near-contract.md defines. */
  private withProof(args: { order_id: string; receipt_id: string }) {
    const row = this.db.prepare(
      `SELECT o.market, o.side, o.quantity, e.id AS event_id, e.received_at, e.price, e.quantity AS fill_quantity, e.source
         FROM receipts r JOIN orders o ON o.id = r.order_id JOIN execution_events e ON e.id = r.first_fill_event_id
        WHERE r.id = ?`,
    ).get(args.receipt_id) as {
      market: string; side: string; quantity: string; event_id: string; received_at: string; price: string | null;
      fill_quantity: string; source: string;
    } | undefined;
    if (!row) throw new ProofMissing(`Receipt ${args.receipt_id} or its first fill is missing`);
    return {
      ...args,
      proof: {
        market: row.market, side: row.side, quantity: row.quantity,
        fill: {
          event_id: row.event_id, at: Date.parse(row.received_at), price: row.price, quantity: row.fill_quantity, source: row.source,
        },
      },
    };
  }
}

class ProofMissing extends Error {}
