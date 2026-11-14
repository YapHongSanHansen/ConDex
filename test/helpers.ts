import { type KeyObject, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { type AppDeps, createApp } from "../src/api/app.ts";
import { type Config, loadConfig } from "../src/config.ts";
import { signNep413, toNearPublicKey } from "../src/near/nep413.ts";
import type { ExpiryEvaluator } from "../src/services/expiry.ts";

/** Stands in for ConDex's AI: always answers "three days from now", and counts how often it was asked. */
export function fakeAdvisor(): ExpiryEvaluator & { calls: number } {
  return {
    model: "fake",
    calls: 0,
    async evaluate(thesis) {
      this.calls++;
      return {
        expiresAt: new Date(thesis.now.getTime() + 3 * 24 * 3600 * 1000).toISOString(),
        timeGiven: true,
        reason: "The thesis is a short-term fade, valid for a few days.",
      };
    },
  };
}

/**
 * In-memory server on a random port. near-cli signing is off unless a test passes its own signer,
 * so no test can ever reach the real keychain on the machine running the tests. Every test signs in
 * from 127.0.0.1, so the per-client sign-in rate is raised unless a test sets its own.
 */
export async function startServer(deps: AppDeps = {}, overrides: Partial<Config> = {}) {
  const config = {
    ...loadConfig({}), dbPath: ":memory:", port: 0, devMode: true, executionSecret: "test-secret", signInsPerMinute: 100_000,
    ...overrides,
  };
  const { app, ctx } = createApp(config, { nearCli: null, ...deps });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function api(method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = text ? JSON.parse(text) : null;
    return { status: res.status, body };
  }

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { base, api, close, ctx, config };
}

export type Api = Awaited<ReturnType<typeof startServer>>["api"];

export const ETH_MESSAGES = [
  { role: "user", content: "ETH swept yesterday's high. Is the breakout real?" },
  {
    role: "assistant",
    content:
      "Treat it as failed if a 15-minute candle closes back below yesterday's UTC high. Short trigger: that close. " +
      "Invalidation: a 1-hour close above the sweep high. Walk away if neither happens by the US open.",
  },
];

/** A date `days` from now as YYYY-MM-DD (UTC), for an expiry that is still ahead whenever the tests run. */
export function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** A complete publish request: the approved messages plus the conditions and expiry every thesis records. */
export const ETH_THESIS = {
  title: "ETH failed breakout",
  market: "ETH-USD",
  direction: "short",
  entry: "A 15-minute candle closes back below yesterday's UTC high.",
  invalidation: "A 1-hour close above the sweep high.",
  target: "Yesterday's UTC low.",
  expiry_date: futureDate(7),
  summary: "Fade a failed sweep of yesterday's high.",
  fee_near: "0.1",
  messages: ETH_MESSAGES,
};

/** Does what a NEAR wallet does on "Connect wallet": signs the NEP-413 challenge with an ed25519 key. */
export async function connectWallet(api: Api, accountId: string, opts: { displayName?: string; key?: KeyObject } = {}) {
  const privateKey = opts.key ?? generateKeyPairSync("ed25519").privateKey;
  const publicKey = toNearPublicKey(createPublicKey(privateKey));
  const challenge = (await api("POST", "/v1/auth/challenge")).body;
  const signature = signNep413(privateKey, {
    message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"), recipient: challenge.recipient,
  });
  const verify = await api("POST", "/v1/auth/verify", {
    body: { account_id: accountId, public_key: publicKey, signature, nonce: challenge.nonce, display_name: opts.displayName },
  });
  return { verify, session: verify.body?.session?.token as string, challenge, publicKey, privateKey, signature };
}

/**
 * Pays one subscription period, after depositing exactly its fee, so the account's balance is the same
 * afterwards. Reading the full thesis and trading need it.
 */
export async function subscribe(api: Api, key: string) {
  const status = await api("GET", "/v1/subscription", { key });
  await api("POST", "/v1/ledger/deposit", { key, body: { amount_near: status.body.terms.fee.near } });
  const paid = await api("POST", "/v1/subscription", { key });
  if (paid.status !== 201) throw new Error(`subscribe failed: ${JSON.stringify(paid.body)}`);
  return paid;
}

/**
 * Alice (creator) with a publish key, Bob (borrower) with separate read and trade keys, an active
 * subscription and 1 test NEAR.
 */
export async function setupAliceAndBob(api: Api) {
  const aliceSession = (await connectWallet(api, "alice.testnet", { displayName: "Alice" })).session;
  const bobSession = (await connectWallet(api, "bob.testnet", { displayName: "Bob" })).session;
  const alicePublish = (await api("POST", "/v1/keys", { key: aliceSession, body: { scopes: ["publish"], label: "alice agent" } })).body.secret as string;
  const bobRead = (await api("POST", "/v1/keys", { key: bobSession, body: { scopes: ["read"], label: "bob research" } })).body.secret as string;
  const bobTrade = (await api("POST", "/v1/keys", { key: bobSession, body: { scopes: ["trade"], label: "bob trading" } })).body.secret as string;
  await subscribe(api, bobSession);
  await api("POST", "/v1/ledger/deposit", { key: bobSession, body: { amount_near: "1" } });
  const published = await api("POST", "/v1/insights", { key: alicePublish, body: ETH_THESIS });
  return { aliceSession, bobSession, alicePublish, bobRead, bobTrade, tokenId: published.body.token_id as string, published };
}

/** Quotes and places an order that matches the short ETH thesis: a sell. */
export async function placeOrder(api: Api, tradeKey: string, tokenId: string, quantity = "2") {
  const quote = await api("POST", "/v1/quotes", { key: tradeKey, body: { token_id: tokenId } });
  const order = await api("POST", "/v1/orders", {
    key: tradeKey, body: { quote_id: quote.body.quote_id, side: "sell", quantity, authorise_fee: true },
  });
  return { quote, order };
}
