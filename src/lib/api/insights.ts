import { request } from "./client";
import type { InsightsApi } from "./types";

export const insightsApi: InsightsApi = {
  listInsights: (params) => request("/v1/insights", { query: { ...params } }),
  getInsight: (id) => request(`/v1/insights/${encodeURIComponent(id)}`),
  getStats: () => request("/v1/stats"),
};
