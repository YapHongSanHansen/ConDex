import type { AddressInfo } from "node:net";
import { createApp } from "../src/api/app.ts";
import { loadConfig } from "../src/config.ts";

export async function startServer() {
  const config = { ...loadConfig({}), dbPath: ":memory:", port: 0, devMode: true, executionSecret: "test-secret" };
  const { app, ctx } = createApp(config);
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

/** Alice (creator) with a publish key, Bob (borrower) with separate read and trade keys and 1 test NEAR. */
export async function setupAliceAndBob(api: Api) {
  const alice = await api("POST", "/v1/accounts", { body: { near_account_id: "alice.testnet", display_name: "Alice" } });
  const bob = await api("POST", "/v1/accounts", { body: { near_account_id: "bob.testnet", display_name: "Bob" } });
  const aliceOwner = alice.body.owner_key.secret as string;
  const bobOwner = bob.body.owner_key.secret as string;
  const alicePublish = (await api("POST", "/v1/keys", { key: aliceOwner, body: { scopes: ["publish"], label: "alice agent" } })).body.secret as string;
  const bobRead = (await api("POST", "/v1/keys", { key: bobOwner, body: { scopes: ["read"], label: "bob research" } })).body.secret as string;
  const bobTrade = (await api("POST", "/v1/keys", { key: bobOwner, body: { scopes: ["trade"], label: "bob trading" } })).body.secret as string;
  await api("POST", "/v1/ledger/deposit", { key: bobOwner, body: { amount_near: "1" } });
  const published = await api("POST", "/v1/insights", {
    key: alicePublish,
    body: { title: "ETH failed breakout", market: "ETH-USD", summary: "Fade a failed sweep of yesterday's high.", fee_near: "0.1", messages: ETH_MESSAGES },
  });
  return { aliceOwner, bobOwner, alicePublish, bobRead, bobTrade, tokenId: published.body.token_id as string, published };
}

export async function placeOrder(api: Api, tradeKey: string, tokenId: string, quantity = "2") {
  const quote = await api("POST", "/v1/quotes", { key: tradeKey, body: { token_id: tokenId } });
  const order = await api("POST", "/v1/orders", {
    key: tradeKey, body: { quote_id: quote.body.quote_id, side: "sell", quantity, authorise_fee: true },
  });
  return { quote, order };
}
