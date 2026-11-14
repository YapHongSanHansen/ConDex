import { authApi } from "./auth";
import { creatorsApi } from "./creators";
import { insightsApi } from "./insights";
import { keysApi } from "./keys";
import { tradingApi } from "./trading";
import type { Api } from "./types";
// @mock-remove-start
import { USE_MOCKS } from "@/lib/config";
import { MOCK_API } from "@/mocks/api";
// @mock-remove-end

export let api: Api = { insights: insightsApi, trading: tradingApi, creators: creatorsApi, auth: authApi, keys: keysApi };

// @mock-remove-start
if (USE_MOCKS) api = MOCK_API;
// @mock-remove-end

export * from "./types";
export { ApiError, friendlyError, toApiError } from "./errors";
export { getSession, setSession, type StoredSession } from "./client";
export * from "./wire";
export { horizonOf, latestVersions, tokenToDetail, tokenToInsight } from "./adapters";
