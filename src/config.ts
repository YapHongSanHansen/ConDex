export interface Config {
  port: number;
  /** SQLite file path, or ":memory:". Holds private storage and all off-chain state. */
  dbPath: string;
  /** Shared secret the execution integration sends in `X-Execution-Secret`. */
  executionSecret: string;
  /** Enables /v1/dev/* and /v1/sim/* routes and the /test page. Never enable in production. */
  devMode: boolean;
  /** How long a fee quote stays valid. */
  quoteTtlSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: env.CONDEX_DB_PATH ?? "data/condex.db",
    executionSecret: env.CONDEX_EXECUTION_SECRET ?? "dev-execution-secret",
    devMode: (env.CONDEX_DEV_MODE ?? "true") === "true",
    quoteTtlSeconds: Number(env.CONDEX_QUOTE_TTL_SECONDS ?? 300),
  };
}
