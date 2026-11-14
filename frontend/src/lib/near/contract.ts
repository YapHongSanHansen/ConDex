import { actions, nearToYocto } from "near-api-js";
import type { NearWalletBase } from "@hot-labs/near-connect";
import { ApiError, toApiError } from "@/lib/api/errors";
import type { Order } from "@/lib/api/wire";

// The calls the trader signs on the ConDex contract when the backend runs on the NEAR ledger (CONDEX_LEDGER=near).
// Method names and arguments are the deployed contract's: deposit(), subscribe(), reserve_fee(order_id, token_id, fee,
// order_hash). The backend never signs for the trader: it checks these on chain, then goes on.

const GAS = BigInt("30000000000000"); // 30 TGas

export interface TxResult {
  txHash: string;
}

async function call(wallet: NearWalletBase | null, contractId: string, methodName: string, args: object, depositYocto: bigint): Promise<TxResult> {
  if (!contractId) throw new ApiError("contract_not_configured", "The backend did not report its contract id");
  if (!wallet) throw new ApiError("unauthorized", "Wallet not connected");
  try {
    const outcome = await wallet.signAndSendTransaction({
      receiverId: contractId,
      actions: [actions.functionCall(methodName, args, GAS, depositYocto)],
    });
    return { txHash: outcome.transaction_outcome.id };
  } catch (e) {
    throw toApiError(e);
  }
}

/** Adds test NEAR to the trader's balance in the contract. The fee for an order is reserved from this balance. */
export const depositToContract = (wallet: NearWalletBase | null, contractId: string, amountNear: string) =>
  call(wallet, contractId, "deposit", {}, BigInt(nearToYocto(amountNear as `${number}`)));

/** Pays one subscription period. The price is attached to the call. */
export const subscribeOnContract = (wallet: NearWalletBase | null, contractId: string, priceYocto: string) =>
  call(wallet, contractId, "subscribe", {}, BigInt(priceYocto));

/** Approves one order and its fee: the arguments are exactly what the backend put in the order's `approval`. */
export function approveFeeOnContract(wallet: NearWalletBase | null, approval: NonNullable<Order["approval"]>) {
  return call(wallet, approval.contract, approval.method, approval.args, BigInt(0));
}
