/** "near-rpc" checks keys on chain. "none" skips the check and is only allowed in dev mode. */
export type KeyCheckMode = "near-rpc" | "none";

/**
 * Proves that the key which signed a sign-in message belongs to the NEAR account it claims.
 * A valid signature alone only proves control of a key pair, not of the account.
 */
export interface AccessKeyChecker {
  readonly mode: KeyCheckMode;
  /** Resolves true only if `publicKey` is a full-access key of `accountId`. */
  isFullAccessKey(accountId: string, publicKey: string): Promise<boolean>;
}

/** Asks a NEAR RPC node for the access key (`view_access_key`). */
export class RpcAccessKeyChecker implements AccessKeyChecker {
  readonly mode = "near-rpc" as const;
  private readonly rpcUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(rpcUrl: string, fetchFn: typeof fetch = fetch) {
    this.rpcUrl = rpcUrl;
    this.fetchFn = fetchFn;
  }

  async isFullAccessKey(accountId: string, publicKey: string): Promise<boolean> {
    const res = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "condex",
        method: "query",
        params: { request_type: "view_access_key", finality: "final", account_id: accountId, public_key: publicKey },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`NEAR RPC returned HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { permission?: unknown; error?: unknown };
      error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown };
    };
    // Only "this key or account does not exist" means "not this account's key". Any other error
    // (node not synced, rate limit, bad block) is a failure to check, which the caller reports as retryable.
    if (body.error) {
      if (NOT_THIS_ACCOUNTS_KEY.has(body.error.cause?.name ?? "")) return false;
      const reason = body.error.cause?.name ?? body.error.name ?? "error";
      throw new Error(`NEAR RPC ${reason}: ${body.error.message ?? JSON.stringify(body.error.data ?? "")}`);
    }
    if (!body.result) throw new Error("NEAR RPC returned no result");
    // Some nodes (FastNEAR included) answer HTTP 200 with result.error instead of a JSON-RPC error.
    if (typeof body.result.error === "string") {
      if (/does not exist/i.test(body.result.error)) return false;
      throw new Error(`NEAR RPC: ${body.result.error}`);
    }
    return body.result.permission === "FullAccess";
  }
}

const NOT_THIS_ACCOUNTS_KEY = new Set(["UNKNOWN_ACCESS_KEY", "UNKNOWN_ACCOUNT", "INVALID_ACCOUNT"]);

/** Dev mode only: trusts the claimed account. The signature is still verified. */
export class NoAccessKeyCheck implements AccessKeyChecker {
  readonly mode = "none" as const;
  async isFullAccessKey(): Promise<boolean> {
    return true;
  }
}
