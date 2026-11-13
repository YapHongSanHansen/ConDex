export interface Config {
  port: number;
  /**
   * Where off-chain state lives. ":memory:" (the default) keeps it in this process only: no file is
   * written and everything starts empty on each restart. A file path keeps it across restarts.
   */
  dbPath: string;
  /** Shared secret the execution integration sends in `X-Execution-Secret`. */
  executionSecret: string;
  /** Enables /v1/dev/* and /v1/sim/* routes and the /test page. Never enable in production. */
  devMode: boolean;
  /** How long a fee quote stays valid. */
  quoteTtlSeconds: number;
  /** NEAR network that wallet sign-ins are checked against. */
  nearNetwork: "testnet" | "mainnet";
  nearRpcUrl: string;
  /**
   * How to confirm the signing key belongs to the account: "near-rpc" asks the chain;
   * "none" skips it (dev mode only, so the test page's dev wallet can sign in as any name).
   */
  walletKeyCheck: "near-rpc" | "none";
  /** The NEP-413 `recipient` the wallet signs for. Wallets show it to the user. */
  authRecipient: string;
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
}

const DEV_EXECUTION_SECRET = "dev-execution-secret";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devMode = (env.CONDEX_DEV_MODE ?? "true") === "true";
  const nearNetwork = env.CONDEX_NEAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const walletKeyCheck = (env.CONDEX_WALLET_KEY_CHECK ?? (devMode ? "none" : "near-rpc")) as Config["walletKeyCheck"];
  if (walletKeyCheck !== "near-rpc" && walletKeyCheck !== "none") {
    throw new Error('CONDEX_WALLET_KEY_CHECK must be "near-rpc" or "none"');
  }
  if (walletKeyCheck === "none" && !devMode) {
    throw new Error('CONDEX_WALLET_KEY_CHECK=none is only allowed when CONDEX_DEV_MODE=true');
  }
  // The execution secret guards the routes that settle and release fees. The dev default is public
  // (it is in this repo and the test console), so outside dev mode a private value is required.
  const executionSecret = env.CONDEX_EXECUTION_SECRET || (devMode ? DEV_EXECUTION_SECRET : "");
  if (!devMode && (!executionSecret || executionSecret === DEV_EXECUTION_SECRET)) {
    throw new Error("Set CONDEX_EXECUTION_SECRET to a private value when CONDEX_DEV_MODE=false");
  }
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: env.CONDEX_DB_PATH || ":memory:",
    executionSecret,
    devMode,
    quoteTtlSeconds: Number(env.CONDEX_QUOTE_TTL_SECONDS ?? 300),
    nearNetwork,
    nearRpcUrl: env.CONDEX_NEAR_RPC_URL ?? `https://rpc.${nearNetwork}.near.org`,
    walletKeyCheck,
    authRecipient: env.CONDEX_AUTH_RECIPIENT ?? "ConDex",
    challengeTtlSeconds: Number(env.CONDEX_CHALLENGE_TTL_SECONDS ?? 300),
    sessionTtlSeconds: Number(env.CONDEX_SESSION_TTL_SECONDS ?? 60 * 60 * 24),
  };
}
