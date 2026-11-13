import { request } from "./client";
import type { CreatorsApi } from "./types";

export const creatorsApi: CreatorsApi = {
  getEarnings: () => request("/v1/creators/me/earnings"),
  listReceipts: () => request("/v1/creators/me/receipts"),
  listMyInsights: () => request("/v1/creators/me/insights"),
  updatePayoutAccount: (account) =>
    request("/v1/creators/me/payout-account", { method: "PUT", body: { payout_account: account } }),
  getCreatorKey: () => request("/v1/creators/me/api-key"),
  createCreatorKey: () => request("/v1/creators/me/api-key", { method: "POST" }),
  listExports: () => request("/v1/creators/me/exports"),
  publishExport: (input) => request("/v1/creators/me/exports/publish", { method: "POST", body: input }),
};
