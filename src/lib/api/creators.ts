import { toReceipt } from "./adapters";
import { request } from "./client";
import type { CreatorsApi } from "./types";
import type { Balances, Me, TokenPreview, WireReceipt } from "./wire";

export const creatorsApi: CreatorsApi = {
  profile: (account) => request(`/v1/publishers/${encodeURIComponent(account)}`),
  receipts: async () => {
    const [{ receipts }, { tokens }, me] = await Promise.all([
      request<{ receipts: WireReceipt[] }>("/v1/receipts"),
      request<{ tokens: TokenPreview[] }>("/v1/tokens"),
      request<Me>("/v1/me"),
    ]);
    const byToken = new Map(tokens.map((t) => [t.token_id, t]));
    return receipts.map((r) => toReceipt(r, byToken.get(r.token_id), me.account.id)).sort((a, b) => b.date.localeCompare(a.date));
  },
  earnings: async (account) => {
    const b = await request<Balances>(`/v1/ledger/balances/${encodeURIComponent(account)}`);
    return { earned: Number(b.earned.near), available: Number(b.available.near), reserved: Number(b.reserved.near), ledger: b.ledger };
  },
};
