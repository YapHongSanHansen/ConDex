import type { KeyCheckMode } from "./near/accessKeys.ts";

export interface Config {
  port: number;
  /** Network interface to listen on. Dev mode defaults to 127.0.0.1, so other machines cannot reach it. */
  host: string;
  /**
   * Where off-chain state lives. ":memory:" (the dev default) keeps it in this process only: no file is
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
  walletKeyCheck: KeyCheckMode;
  /**
   * The NEP-413 `recipient`: the website's domain, e.g. "condex.app". It is also written into the sign-in
   * message, so a user can see when a look-alike site asks them to sign in to ConDex.
   */
  authRecipient: string;
  /** Origins a redirect wallet may send the user back to (`callback_url` on sign-in). */
  allowedOrigins: string[];
  challengeTtlSeconds: number;
  sessionTtlSeconds: number;
  /** New sign-in challenges each client address may request per minute. */
  signInsPerMinute: number;
  /** Number of reverse proxies in front of the server, so client addresses come from X-Forwarded-For. */
  trustProxyHops: number;
  /**
   * ConDex's AI, which sets the expiry of a thesis published without one.
   * "llm": the OpenAI-compatible model in `llm`. "claude": Claude (needs Anthropic credentials, e.g.
   * ANTHROPIC_API_KEY). "off": no AI, so ConDex's default expiry is applied.
   */
  expiryAi: "llm" | "claude" | "off";
  /** The OpenAI-compatible reasoning model. null when CONDEX_LLM_API_KEY is not set. */
  llm: LlmConfig | null;
}

/** An OpenAI-compatible chat completions endpoint. */
export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  timeoutMs: number;
}

const DEV_EXECUTION_SECRET = "dev-execution-secret";

/** Public RPC endpoints near-cli-rs uses by default (rpc.<network>.near.org is deprecated and rate-limited). */
const DEFAULT_RPC = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://rpc.mainnet.fastnear.com",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const devMode = parseBool(env, "CONDEX_DEV_MODE", true);
  const nearNetwork = parseChoice(env, "CONDEX_NEAR_NETWORK", ["testnet", "mainnet"] as const, "testnet");
  const walletKeyCheck = parseChoice(env, "CONDEX_WALLET_KEY_CHECK", ["near-rpc", "none"] as const, devMode ? "none" : "near-rpc");
  if (walletKeyCheck === "none" && !devMode) {
    throw new Error("CONDEX_WALLET_KEY_CHECK=none is only allowed when CONDEX_DEV_MODE=true");
  }
  const port = parseInteger(env, "PORT", 8787, 0);

  // Outside dev mode, the settings below have no safe default, so they must be set explicitly.
  // The execution secret guards the routes that settle and release fees; the dev value is public.
  const executionSecret = env.CONDEX_EXECUTION_SECRET || (devMode ? DEV_EXECUTION_SECRET : "");
  if (!devMode && (!executionSecret || executionSecret === DEV_EXECUTION_SECRET)) {
    throw new Error("Set CONDEX_EXECUTION_SECRET to a private value when CONDEX_DEV_MODE=false");
  }
  const dbPath = env.CONDEX_DB_PATH?.trim() || (devMode ? ":memory:" : "");
  if (!dbPath) {
    throw new Error(
      'Set CONDEX_DB_PATH when CONDEX_DEV_MODE=false: a file path keeps data across restarts, ' +
      'or ":memory:" if losing every account, key and balance on each restart is acceptable',
    );
  }
  const authRecipient = env.CONDEX_AUTH_RECIPIENT?.trim() || (devMode ? `localhost:${port}` : "");
  if (!authRecipient) {
    throw new Error("Set CONDEX_AUTH_RECIPIENT to your website's domain (for example condex.app) when CONDEX_DEV_MODE=false");
  }

  // ConDex's AI: the OpenAI-compatible model when it has a key, else Claude when Anthropic has one.
  const llm = loadLlm(env);
  const hasAnthropicKey = !!(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
  const expiryAi = parseChoice(env, "CONDEX_EXPIRY_AI", ["llm", "claude", "off"] as const, llm ? "llm" : hasAnthropicKey ? "claude" : "off");
  if (expiryAi === "llm" && !llm) throw new Error("CONDEX_EXPIRY_AI=llm needs CONDEX_LLM_API_KEY");

  return {
    port,
    host: env.CONDEX_HOST?.trim() || (devMode ? "127.0.0.1" : "0.0.0.0"),
    dbPath,
    executionSecret,
    devMode,
    quoteTtlSeconds: parseInteger(env, "CONDEX_QUOTE_TTL_SECONDS", 300),
    nearNetwork,
    nearRpcUrl: env.CONDEX_NEAR_RPC_URL?.trim() || DEFAULT_RPC[nearNetwork],
    walletKeyCheck,
    authRecipient,
    allowedOrigins: parseOrigins(env, "CONDEX_ALLOWED_ORIGINS")
      ?? (devMode ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`] : []),
    challengeTtlSeconds: parseInteger(env, "CONDEX_CHALLENGE_TTL_SECONDS", 300),
    sessionTtlSeconds: parseInteger(env, "CONDEX_SESSION_TTL_SECONDS", 60 * 60 * 24),
    signInsPerMinute: parseInteger(env, "CONDEX_SIGNINS_PER_MINUTE", 60),
    trustProxyHops: parseInteger(env, "CONDEX_TRUST_PROXY", 0, 0),
    expiryAi,
    llm,
  };
}

function loadLlm(env: NodeJS.ProcessEnv): LlmConfig | null {
  const apiKey = env.CONDEX_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.CONDEX_LLM_BASE_URL?.trim() || "https://llm.grafilab.ai/v1").replace(/\/+$/, ""),
    model: env.CONDEX_LLM_MODEL?.trim() || "qwen/qwen3.7-flash",
    reasoningEffort: parseChoice(env, "CONDEX_LLM_REASONING_EFFORT", ["low", "medium", "high"] as const, "low"),
    timeoutMs: parseInteger(env, "CONDEX_LLM_TIMEOUT_SECONDS", 60) * 1000,
  };
}

// ---- strict parsing: a typo fails at startup instead of silently changing behaviour ----

function parseBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${env[name]}"`);
}

function parseChoice<T extends string>(env: NodeJS.ProcessEnv, name: string, choices: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if ((choices as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be one of ${choices.map((c) => `"${c}"`).join(", ")}, got "${env[name]}"`);
}

/** Empty means "use the default"; anything else must be a whole number of at least `min`. */
function parseInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min) {
    throw new Error(`${name} must be a whole number of at least ${min} (seconds or a count), got "${env[name]}"`);
  }
  return Number(raw);
}

function parseOrigins(env: NodeJS.ProcessEnv, name: string): string[] | null {
  const raw = env[name]?.trim();
  if (!raw) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((value) => {
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new Error(`${name} must be a comma-separated list of origins like https://condex.app, got "${value}"`);
    }
    if (origin === "null" || origin !== value.replace(/\/$/, "")) {
      throw new Error(`${name} entries must be bare origins (scheme, host and port only), got "${value}"`);
    }
    return origin;
  });
}
