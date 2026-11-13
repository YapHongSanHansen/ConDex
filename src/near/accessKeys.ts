/**
 * Proves that the key which signed a sign-in message belongs to the NEAR account it claims.
 * A valid signature alone only proves control of a key pair, not of the account.
 */
export interface AccessKeyChecker {
  /** "near-rpc" checks on chain. "none" skips the check and is only allowed in dev mode. */
  readonly mode: "near-rpc" | "none";
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
    const body = (await res.json()) as { result?: { permission?: unknown }; error?: unknown };
    // Unknown account or key comes back as an error: treat as "not this account's key".
    if (body.error || !body.result) return false;
    return body.result.permission === "FullAccess";
  }
}

/** Dev mode only: trusts the claimed account. The signature is still verified. */
export class NoAccessKeyCheck implements AccessKeyChecker {
  readonly mode = "none" as const;
  async isFullAccessKey(): Promise<boolean> {
    return true;
  }
}
