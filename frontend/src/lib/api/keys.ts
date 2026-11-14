import { toKeyRow } from "./adapters";
import { request } from "./client";
import type { KeysApi } from "./types";
import type { KeyWithMcp, McpTool, WireKey } from "./wire";

export const keysApi: KeysApi = {
  list: async () => (await request<{ keys: KeyWithMcp[] }>("/v1/keys")).keys.map(toKeyRow),
  issue: (body) => request("/v1/keys", { method: "POST", body }),
  revoke: async (keyId) => toKeyRow(await request<WireKey>(`/v1/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" })),
  mcpTools: async () => (await request<{ tools: McpTool[] }>("/v1/mcp/tools")).tools,
  disconnectMcp: () => request("/v1/mcp/disconnect", { method: "POST" }),
};
