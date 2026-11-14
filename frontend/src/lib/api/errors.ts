import type { ApiErrorCode, ApiErrorShape } from "./types";

export class ApiError extends Error implements ApiErrorShape {
  code: ApiErrorCode;
  retryable: boolean;
  constructor(code: ApiErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryable = retryable;
  }
}

const FRIENDLY: Record<ApiErrorCode, { title: string; next: string }> = {
  network_down: { title: "We can't reach the ConDex API.", next: "Check your connection and try again." },
  key_expired: { title: "This key has expired.", next: "Create a new key on the Connect page." },
  key_invalid: { title: "That key was refused.", next: "Check the key, or create a new one on the Connect page." },
  missing_scope: { title: "This key can't do that.", next: "Create a key with the right access: publish, read or trade." },
  session_required: { title: "Sign in with your wallet first.", next: "Keys are managed from a wallet session, not from another key." },
  subscription_required: { title: "Reading the full thesis needs a subscription.", next: "The abstract is free. Subscribe to read the conditions and the conversation." },
  insufficient_funds: { title: "Not enough test NEAR in your balance.", next: "Add test NEAR to your balance and try again." },
  quote_expired: { title: "That fee quote is no longer valid.", next: "Ask for a new quote and try again." },
  insight_expired: { title: "This thesis has expired.", next: "Browse the gallery for one that is still open." },
  thesis_mismatch: { title: "That order doesn't match the thesis.", next: "Check the market and the direction: a long opens with a buy, a short with a sell." },
  over_budget: { title: "Payment is needed first.", next: "Check your balance and try again." },
  insight_revoked: { title: "The creator revoked this insight.", next: "Browse the gallery for another insight." },
  not_found: { title: "We couldn't find that.", next: "It may have been removed. Go back to the gallery." },
  validation: { title: "Some details need fixing.", next: "Check the highlighted fields and try again." },
  unauthorized: { title: "Sign in to ConDex first.", next: "You are not signed in, or your session ended. Use the Sign in button." },
  contract_not_configured: { title: "The NEAR contract isn't set up yet.", next: "The backend did not say which contract to use. Check that it runs with CONDEX_LEDGER=near." },
  wallet_rejected: { title: "The wallet transaction was cancelled.", next: "Nothing was reserved or charged. You can try again." },
  server_error: { title: "Something went wrong on our side.", next: "Try again in a moment." },
  unknown: { title: "Something unexpected happened.", next: "Try again. If it keeps happening, tell the team." },
};

/** Never show a raw error: always a plain explanation plus a next step. */
export function friendlyError(err: unknown): { title: string; next: string; retryable: boolean } {
  const e = err instanceof ApiError ? err : new ApiError("unknown", "", true);
  const f = FRIENDLY[e.code] ?? FRIENDLY.unknown;
  // For problems the backend explains better than a generic line can (a refused order, a bad field), its own message is the next step.
  const own = ["validation", "unknown", "key_invalid", "over_budget"].includes(e.code) && e.message && !/^HTTP \d+$/.test(e.message) && e.message !== "Unexpected error";
  return { ...f, next: own ? e.message : f.next, retryable: e.retryable };
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const msg = err instanceof Error ? err.message.toLowerCase() : "";
  if (msg.includes("reject") || msg.includes("cancel") || msg.includes("denied")) {
    return new ApiError("wallet_rejected", "Wallet request was rejected", false);
  }
  return new ApiError("unknown", "Unexpected error", true);
}
