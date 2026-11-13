import { borrowsApi } from "./borrows";
import { creatorsApi } from "./creators";
import { insightsApi } from "./insights";
import type { Api } from "./types";
// @mock-remove-start
import { USE_MOCKS } from "@/lib/config";
import { MOCK_API } from "@/mocks/api";
// @mock-remove-end

export let api: Api = { insights: insightsApi, borrows: borrowsApi, creators: creatorsApi };

// @mock-remove-start
if (USE_MOCKS) api = MOCK_API;
// @mock-remove-end

export * from "./types";
export { ApiError, friendlyError, toApiError } from "./errors";
export { setAuthAccount } from "./client";
