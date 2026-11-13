/**
 * ConDex MCP server (stdio). Lets a trader's agent publish, read and trade on insights.
 *
 * It is a thin client of the ConDex HTTP API, so it carries exactly the permissions of
 * the API key it is given:
 *   CONDEX_API_URL  default http://localhost:8787
 *   CONDEX_API_KEY  a ConDex key (publish, read and/or trade scope)
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface McpToolInfo {
  name: string;
  title: string;
  description: string;
}

/** Filled as tools are registered, so the console can show exactly what an agent will get. */
export const MCP_TOOLS: McpToolInfo[] = [];

export interface McpOptions {
  apiUrl: string;
  apiKey: string | undefined;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const message = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1),
  at: z.string().optional().describe("ISO timestamp of the message, if known"),
});

const publishShape = {
  title: z.string().min(1).max(200).describe("Short title for the insight"),
  market: z.string().max(64).optional().describe('Market the insight is about, e.g. "ETH-USD"'),
  summary: z.string().max(1000).optional().describe("Public one-paragraph preview. Do not include private details."),
  expires_at: z.string().optional().describe("ISO date-time after which the insight can no longer be traded on"),
  fee_near: z.string().describe('Flat fee per filled order, in NEAR, e.g. "0.1"'),
  payout_account: z.string().optional().describe("NEAR account that receives fees. Defaults to the creator's account."),
  messages: z.array(message).min(1).describe(
    "Only the messages the creator approved for sharing. Never include unrelated positions or wallet details.",
  ),
};

export function buildMcpServer(opts: McpOptions): McpServer {
  const server = new McpServer({ name: "condex", version: "0.1.0" });

  // Record each tool as it is registered, so the console can list exactly what an agent gets.
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { title?: string; description?: string }, cb: never) => {
    if (!MCP_TOOLS.some((t) => t.name === name)) {
      MCP_TOOLS.push({ name, title: config.title ?? name, description: config.description ?? "" });
    }
    return (register as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as typeof server.registerTool;

  const call = async (method: string, path: string, body?: unknown): Promise<ToolResult> => {
    if (!opts.apiKey) {
      return { isError: true, content: [{ type: "text", text: "CONDEX_API_KEY is not set for this MCP server." }] };
    }
    try {
      const res = await fetch(new URL(path, opts.apiUrl), {
        method,
        headers: { authorization: `Bearer ${opts.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return res.ok
        ? { content: [{ type: "text", text }] }
        : { isError: true, content: [{ type: "text", text: `ConDex API ${res.status}: ${text}` }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: `Could not reach ConDex at ${opts.apiUrl}: ${String(err)}` }] };
    }
  };

  server.registerTool("condex_whoami", {
    title: "Who am I",
    description: "Show the ConDex account and scopes of the configured API key.",
    inputSchema: {},
  }, () => call("GET", "/v1/me"));

  server.registerTool("condex_publish_insight", {
    title: "Publish insight",
    description:
      "Publish creator-approved messages from this conversation as a new ConDex insight. ConDex stores them privately " +
      "and mints a token on NEAR for this version. Readers read for free; the creator earns fee_near once per linked order that fills.",
    inputSchema: publishShape,
  }, (args) => call("POST", "/v1/insights", args));

  server.registerTool("condex_publish_version", {
    title: "Publish new version",
    description: "Publish an updated version of an existing insight. It gets a new token; earlier tokens keep working.",
    inputSchema: { insight_id: z.string().describe("Insight id, e.g. ins_..."), ...publishShape },
  }, ({ insight_id, ...rest }) => call("POST", `/v1/insights/${encodeURIComponent(insight_id)}/versions`, rest));

  server.registerTool("condex_list_insights", {
    title: "List insights",
    description: "List public previews of published insight tokens (no message content).",
    inputSchema: { market: z.string().optional().describe("Filter by market") },
  }, ({ market }) => call("GET", `/v1/tokens${market ? `?market=${encodeURIComponent(market)}` : ""}`));

  server.registerTool("condex_read_insight", {
    title: "Read insight",
    description: "Read the full approved conversation behind a token. Always free. Needs a key with read scope.",
    inputSchema: { token_id: z.string() },
  }, ({ token_id }) => call("GET", `/v1/tokens/${encodeURIComponent(token_id)}`));

  server.registerTool("condex_quote_fee", {
    title: "Quote fee",
    description: "Get the fee for linking an order to this insight. Show it to the user before placing the order.",
    inputSchema: { token_id: z.string() },
  }, ({ token_id }) => call("POST", "/v1/quotes", { token_id }));

  server.registerTool("condex_place_order", {
    title: "Place linked order",
    description:
      "Place an order linked to an insight using a quote. Reserves the quoted fee, which is paid to the creator only if " +
      "the order fills. Only call this after the user has approved the trade and the fee. Needs a key with trade scope.",
    inputSchema: {
      quote_id: z.string(),
      side: z.enum(["buy", "sell"]),
      quantity: z.string().describe('Order size as a decimal string, e.g. "0.5"'),
      market: z.string().optional().describe("Defaults to the insight's market"),
      limit_price: z.string().optional(),
      authorise_fee: z.boolean().describe("Must be true: the user has approved reserving the quoted fee"),
    },
  }, (args) => call("POST", "/v1/orders", args));

  server.registerTool("condex_get_order", {
    title: "Get order",
    description: "Show an order's status, fills and fee settlement.",
    inputSchema: { order_id: z.string() },
  }, ({ order_id }) => call("GET", `/v1/orders/${encodeURIComponent(order_id)}`));

  server.registerTool("condex_list_receipts", {
    title: "List receipts",
    description: "List settlement receipts where this account is the borrower or the creator.",
    inputSchema: {},
  }, () => call("GET", "/v1/receipts"));

  return server;
}

/**
 * Tell ConDex this key's MCP server has started, so the console can show "connected" and the tool list.
 * Failure is only logged (to stderr: stdout is the MCP protocol channel).
 */
export async function sayHello(opts: McpOptions): Promise<void> {
  if (!opts.apiKey) return;
  try {
    const res = await fetch(new URL("/v1/mcp/hello", opts.apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ client: "condex-mcp", version: "0.1.0", tools: MCP_TOOLS.map((t) => t.name) }),
    });
    if (!res.ok) console.error(`condex-mcp: ConDex answered ${res.status} to the hello (is the key still valid?)`);
  } catch (err) {
    console.error(`condex-mcp: could not reach ConDex at ${opts.apiUrl}: ${String(err)}`);
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const opts = {
    apiUrl: process.env.CONDEX_API_URL ?? "http://localhost:8787",
    apiKey: process.env.CONDEX_API_KEY,
  };
  const server = buildMcpServer(opts);
  await server.connect(new StdioServerTransport());
  void sayHello(opts);
}
