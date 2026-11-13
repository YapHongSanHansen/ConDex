import { request } from "./client";
import type { BorrowsApi } from "./types";

export const borrowsApi: BorrowsApi = {
  createBorrow: (insightId, input) =>
    request(`/v1/insights/${encodeURIComponent(insightId)}/borrows`, { method: "POST", body: input }),
  listBorrows: () => request("/v1/borrows"),
  getBorrow: (id) => request(`/v1/borrows/${encodeURIComponent(id)}`),
  revokeBorrow: (id) => request(`/v1/borrows/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  retrieveInsight: (borrowId, apiKey) =>
    request(`/v1/borrows/${encodeURIComponent(borrowId)}/insight`, { bearer: apiKey }),
  reportTrade: (borrowId, apiKey) =>
    request(`/v1/borrows/${encodeURIComponent(borrowId)}/trade-executed`, { method: "POST", bearer: apiKey }),
};
