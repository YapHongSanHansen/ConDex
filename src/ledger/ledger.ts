/**
 * The on-chain side of ConDex, as seen by the off-chain services.
 *
 * `MockLedger` implements it in SQLite so the whole flow runs before the NEAR
 * contract exists. A NEAR testnet implementation should keep the same method
 * semantics, in particular that settle and release are idempotent per order.
 */
export interface Ledger {
  /** "mock" until a real NEAR adapter is plugged in. Shown in API responses as evidence labelling. */
  readonly kind: "mock" | "near-testnet";

  mintToken(input: MintInput): { tx: string };

  /** Test-only top-up of a borrower's fee balance (stands in for a NEAR deposit into the contract). */
  deposit(account: string, amountYocto: bigint): { tx: string };

  balanceOf(account: string): LedgerBalance;

  /** Moves `amount` from the payer's available balance into a reserve for this order. */
  reserveFee(input: {
    orderId: string;
    tokenId: string;
    payer: string;
    payee: string;
    amountYocto: bigint;
  }): { tx: string };

  /**
   * Charges a subscription to ConDex: moves `amount` from the payer's available balance to the treasury.
   * Calling it again with the same subscription id returns the original tx and charges nothing.
   */
  chargeSubscription(input: { subscriptionId: string; payer: string; payee: string; amountYocto: bigint }): { tx: string };

  /** Pays the reserved fee to the payee. Calling it again for the same order returns the original tx. */
  settleFee(orderId: string, receiptId: string): { tx: string; alreadyFinal: boolean };

  /** Returns the reserved fee to the payer. Calling it again for the same order returns the original tx. */
  releaseFee(orderId: string): { tx: string; alreadyFinal: boolean };

  getReserve(orderId: string): LedgerReserve | undefined;

  /**
   * Adds one closing fill to the proof of trade of an order that has one. Calling it again with the same
   * event id records nothing new.
   */
  recordClose(orderId: string, close: CloseInput): { tx: string };

  listTxs(limit: number): LedgerTx[];
}

export interface CloseInput {
  eventId: string;
  quantity: string;
  price: string;
  /** ISO 8601. */
  closedAt: string;
  /** "simulated" or "venue:<name>". */
  source: string;
}

/** What the token record of one thesis version holds. Only the fingerprint of the content goes on chain. */
export interface MintInput {
  tokenId: string;
  owner: string;
  payoutAccount: string;
  feeYocto: bigint;
  contentHash: string;
  /**
   * When the thesis was published and when it expires (ISO 8601, UTC). On NEAR these are the NEP-177
   * metadata fields `issued_at` and `expires_at`, which hold Unix milliseconds.
   */
  issuedAt: string;
  expiresAt: string;
  /** Whether the creator set the expiry, or ConDex did (its AI, or its default when the AI is off). */
  expirySetBy: "creator" | "condex_ai" | "condex_default";
}

export interface LedgerBalance {
  account: string;
  availableYocto: bigint;
  reservedYocto: bigint;
  earnedYocto: bigint;
}

export interface LedgerReserve {
  orderId: string;
  tokenId: string;
  payer: string;
  payee: string;
  amountYocto: bigint;
  status: "reserved" | "settled" | "released";
  reserveTx: string;
  finalTx: string | null;
}

export interface LedgerTx {
  id: string;
  seq: number;
  method: string;
  args: Record<string, unknown>;
  createdAt: string;
}
