import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

/**
 * Calls to the ConDex contract on NEAR. The real client signs with near-api-js; tests use a stand-in, so
 * nothing in the test suite reaches the network.
 */
export interface ChainClient {
  readonly contractId: string;
  /** Signs and sends one function call, and waits until it is final. Returns the transaction hash. */
  call(signer: Signer, method: string, args: object, depositYocto?: bigint): Promise<{ txHash: string }>;
  /** A free, read-only call. */
  view<T>(method: string, args: object): Promise<T>;
}

export interface Signer {
  accountId: string;
  /** "ed25519:..." */
  secretKey: string;
}

/** Thrown when the contract itself refused the call (it panicked). Sending it again would fail the same way. */
export class ContractRefused extends Error {}

const GAS = 100_000_000_000_000n; // 100 Tgas, well above what each ConDex call uses

export class NearRpcClient implements ChainClient {
  readonly contractId: string;
  private readonly rpcUrl: string;
  private readonly provider: JsonRpcProvider;

  constructor(contractId: string, rpcUrl: string) {
    this.contractId = contractId;
    this.rpcUrl = rpcUrl;
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  async call(signer: Signer, method: string, args: object, depositYocto = 0n) {
    const account = new Account(signer.accountId, this.rpcUrl, signer.secretKey as KeyPairString);
    try {
      const res = await account.callFunctionRaw({
        contractId: this.contractId, methodName: method, args: args as Record<string, unknown>,
        deposit: depositYocto, gas: GAS, waitUntil: "FINAL",
      });
      return { txHash: res.transaction.hash };
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      // An execution failure is final; anything else (network, timeout, nonce) may succeed when sent again.
      if (/panicked|FunctionCallError|ExecutionError|ActionError/i.test(message)) throw new ContractRefused(message);
      throw err;
    }
  }

  async view<T>(method: string, args: object): Promise<T> {
    return (await this.provider.callFunction({ contractId: this.contractId, method, args: args as Record<string, unknown>, blockQuery: { finality: "final" } })) as T;
  }
}
