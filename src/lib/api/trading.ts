import { request } from "./client";
import type { TradingApi } from "./types";

const id = encodeURIComponent;

/** Every call here uses the wallet session as its bearer: a session holds the read and trade scopes. */
export const tradingApi: TradingApi = {
  subscription: () => request("/v1/subscription"),
  subscribe: () => request("/v1/subscription", { method: "POST" }),
  deposit: (amountNear) => request("/v1/ledger/deposit", { method: "POST", body: { amount_near: amountNear } }),
  balances: (account) => request(`/v1/ledger/balances/${id(account)}`),
  read: (tokenId) => request(`/v1/tokens/${id(tokenId)}`),
  proof: (tokenId) => request(`/v1/tokens/${id(tokenId)}/proof`),
  quote: (tokenId) => request("/v1/quotes", { method: "POST", body: { token_id: tokenId } }),
  placeOrder: (body) => request("/v1/orders", { method: "POST", body }),
  closeOrder: (orderId, body) => request(`/v1/orders/${id(orderId)}/close`, { method: "POST", body }),
  listOrders: async () => (await request<{ orders: import("./wire").Order[] }>("/v1/orders")).orders,
  getOrder: (orderId) => request(`/v1/orders/${id(orderId)}`),
};
