import { actions, nearToYocto } from "near-api-js";
import type { NearWalletBase } from "@hot-labs/near-connect";
import { ApiError, toApiError } from "@/lib/api/errors";
// @mock-remove-start
import { USE_MOCKS } from "@/lib/config";
// @mock-remove-end
import { CONTRACT_ID } from "@/lib/config";

// PROPOSED: align with deployed contract. Method names and argument shapes
// below are guesses until the NEAR contract exists.

const GAS = BigInt("30000000000000"); // 30 TGas

export interface RegisterInsightArgs {
  version_hash: string;
  payout_account: string;
  fee: string; // yoctoNEAR
  expires_at_ms: number;
}
export interface ReserveFeeArgs {
  borrow_id: string;
  insight_id: string;
  cap: string; // yoctoNEAR
}

export interface TxResult {
  txHash: string;
}

async function call(
  wallet: NearWalletBase | null,
  methodName: string,
  args: object,
  depositNear: number,
): Promise<TxResult> {
  // @mock-remove-start
  if (USE_MOCKS && !CONTRACT_ID) {
    await new Promise((r) => setTimeout(r, 900));
    return { txHash: `MOCKTX${Date.now()}NOTAREALTRANSACTION` };
  }
  // @mock-remove-end
  if (!CONTRACT_ID) throw new ApiError("contract_not_configured", "NEXT_PUBLIC_CONTRACT_ID is empty");
  if (!wallet) throw new ApiError("unauthorized", "Wallet not connected");
  try {
    const outcome = await wallet.signAndSendTransaction({
      receiverId: CONTRACT_ID,
      actions: [actions.functionCall(methodName, args, GAS, nearToYocto(depositNear))],
    });
    return { txHash: outcome.transaction_outcome.id };
  } catch (e) {
    throw toApiError(e);
  }
}

export function registerInsight(
  wallet: NearWalletBase | null,
  p: { versionHash: string; payoutAccount: string; feeNear: number; expiresAt: string },
) {
  const args: RegisterInsightArgs = {
    version_hash: p.versionHash,
    payout_account: p.payoutAccount,
    fee: nearToYocto(p.feeNear).toString(),
    expires_at_ms: new Date(p.expiresAt).getTime(),
  };
  return call(wallet, "register_insight", args, 0);
}

export function reserveFee(
  wallet: NearWalletBase | null,
  p: { borrowId: string; insightId: string; capNear: number },
) {
  const args: ReserveFeeArgs = {
    borrow_id: p.borrowId,
    insight_id: p.insightId,
    cap: nearToYocto(p.capNear).toString(),
  };
  // The cap is attached as the deposit so it is reserved at borrow time.
  return call(wallet, "reserve_fee", args, p.capNear);
}

// PROPOSED view call for receipts: `get_receipts({ creator })`. Not wired yet;
// receipts currently come from GET /v1/creators/me/receipts.
