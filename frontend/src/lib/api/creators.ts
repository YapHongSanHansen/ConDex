import { toReceipt } from "./adapters";
import { request } from "./client";
import type { CreatorsApi } from "./types";
import { ApiError } from "./errors";
import type { Balances, Me, PublisherProfile, TokenPreview, WireReceipt } from "./wire";

export const creatorsApi: CreatorsApi = {
  // An account that has not published yet has no publisher page. That is an empty list, not an error.
  profile: async (account) => {
    try {
      return await request<PublisherProfile>(`/v1/publishers/${encodeURIComponent(account)}`);
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== "not_found") throw e;
      const empty = { accuracy: { evaluated: 0, met: 0, accuracy_pct: null, pending: 0, not_judged: 0 }, borrowers: { trades: 0, net_return_pct: 0, net_profit_usd: 0, max_drawdown_pct: 0, costs: "" } };
      return { publisher: { id: "", near_account_id: account, display_name: account, created_at: "" }, score: empty, stats: { insights: 0, reads: 0, paid_orders: 0, fees_paid: { yocto: "0", near: "0" }, payout_accounts: [] }, tokens: [] };
    }
  },
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
