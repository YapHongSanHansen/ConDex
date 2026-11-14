import { authApi } from "./auth";
import { creatorsApi } from "./creators";
import { insightsApi } from "./insights";
import { keysApi } from "./keys";
import { tradingApi } from "./trading";
import type { Api } from "./types";

export const api: Api = { insights: insightsApi, trading: tradingApi, creators: creatorsApi, auth: authApi, keys: keysApi };

export * from "./types";
export { ApiError, friendlyError, toApiError } from "./errors";
export { getSession, setSession, subscribeSession, type StoredSession } from "./client";
export * from "./wire";
export { horizonOf, latestVersions, tokenToDetail, tokenToInsight } from "./adapters";
