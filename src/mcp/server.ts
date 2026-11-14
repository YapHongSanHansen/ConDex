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
  market: z.string().min(1).max(64).describe('Market the thesis trades, e.g. "ETH-USD". A linked order must be in this market.'),
  direction: z.enum(["long", "short"]).describe("Direction of the thesis. A linked order must open this way: buy for long, sell for short."),
  entry: z.string().min(1).max(500).describe("When to enter, in the creator's own words"),
  invalidation: z.string().min(1).max(500).describe("What would prove the idea wrong, in the creator's own words"),
  target: z.string().max(500).optional().describe("Optional. When to take profit or close"),
  entry_price: z.string().optional().describe(
    "Optional. The entry as a price, if the creator gave one. With price levels ConDex can evaluate the thesis against " +
    "market data after the expiry and count it in the creator's accuracy.",
  ),
  invalidation_price: z.string().optional().describe("Optional. The price that would prove the idea wrong"),
  target_price: z.string().optional().describe("Optional. The price at which the thesis is right"),
  expiry_date: z.string().optional().describe(
    "Last day a trade can be linked to the thesis, YYYY-MM-DD in UTC. Ask the creator for it before publishing. " +
    "If they give none, leave it out: ConDex sets one and the result says so.",
  ),
  expiry_time: z.string().optional().describe(
    'Time on that day in UTC, HH:MM. Only when the thesis depends on a time, such as "by the US open". ' +
    "Without it the thesis expires at 23:59 UTC on the expiry date.",
  ),
  expires_at: z.string().optional().describe("Alternative to expiry_date and expiry_time: a full ISO date-time. Do not send both."),
  evaluation_deadline: z.string().optional().describe(
    "Optional. A date (YYYY-MM-DD, UTC) or ISO date-time, on or after the expiry and at most 30 days later. Market prices up to " +
    "then are used to judge the thesis, so a trade opened just before the expiry has time to play out. Without it, the expiry is used.",
  ),
  summary: z.string().max(1000).optional().describe("Public one-paragraph preview. Do not include private details."),
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
      "Publish creator-approved messages from this conversation as a new ConDex insight, with the thesis conditions: " +
      "market, direction, entry, invalidation and an optional target. Before publishing, ask the creator when the thesis " +
      "expires: a date is always recorded, and a time only if the thesis depends on one. If the creator gives no date, " +
      "ConDex sets it; tell the creator the expiry and the reason from the result. ConDex stores the messages privately " +
      "and mints a token on NEAR for this version. Readers read for free; the creator earns fee_near once per linked order that fills.",
    inputSchema: publishShape,
  }, (args) => call("POST", "/v1/insights", args));

  server.registerTool("condex_publish_version", {
    title: "Publish new version",
    description:
      "Publish an updated version of an existing insight, for example to change its conditions or expiry, which are " +
      "fixed once published. It gets a new token; earlier tokens keep working. Ask the creator for the expiry as for a new insight.",
    inputSchema: { insight_id: z.string().describe("Insight id, e.g. ins_..."), ...publishShape },
  }, ({ insight_id, ...rest }) => call("POST", `/v1/insights/${encodeURIComponent(insight_id)}/versions`, rest));

  server.registerTool("condex_list_insights", {
    title: "List insights",
    description:
      "List the free abstracts of published theses: title, summary, market, direction, expiry, fee, and the author's " +
      "score (accuracy against market data, and borrowers' net return %, net profit $ and maximum drawdown %). " +
      "No conditions or messages: those need a subscription (condex_read_insight).",
    inputSchema: { market: z.string().optional().describe("Filter by market") },
  }, ({ market }) => call("GET", `/v1/tokens${market ? `?market=${encodeURIComponent(market)}` : ""}`));

  server.registerTool("condex_get_proof", {
    title: "Get proof",
    description:
      "Proof of thesis (creator, publish time, expiry and who set it, fingerprint, whether it is still preserved), " +
      "the evaluation against market data after the expiry (whether the conditions were met), every proof of trade " +
      "(trader, order, first fill, fee paid, closing fill and result) and the thesis's verified results " +
      "(net return %, net profit $, maximum drawdown %). Public; never includes the conversation.",
    inputSchema: { token_id: z.string().describe("Token id, e.g. ins_...-v1") },
  }, ({ token_id }) => call("GET", `/v1/tokens/${encodeURIComponent(token_id)}/proof`));

  server.registerTool("condex_read_insight", {
    title: "Read insight",
    description:
      "Read the full approved conversation behind a token, with its conditions (market, direction, entry, invalidation, " +
      "target, price levels) and its expiry. Needs a key with read scope and an active ConDex subscription; without " +
      "one ConDex answers 402 subscription_required with the terms (see condex_subscribe). Reads cost nothing extra.",
    inputSchema: { token_id: z.string() },
  }, ({ token_id }) => call("GET", `/v1/tokens/${encodeURIComponent(token_id)}`));

  server.registerTool("condex_quote_fee", {
    title: "Quote fee",
    description:
      "Get the fee for linking an order to this insight. Show it to the user before placing the order. Refused once the insight has expired.",
    inputSchema: { token_id: z.string() },
  }, ({ token_id }) => call("POST", "/v1/quotes", { token_id }));

  server.registerTool("condex_place_order", {
    title: "Place linked order",
    description:
      "Place an order linked to an insight using a quote. Reserves the quoted fee, which is paid to the creator only if " +
      "the order fills. ConDex refuses the link unless the order is in the insight's market, opens in its direction " +
      "(buy for long, sell for short) and is placed before it expires. Only call this after the user has approved the " +
      "trade and the fee. Needs a key with trade scope. When ConDex runs on NEAR, the order comes back as " +
      "awaiting_approval with an \"approval\" call: the user signs that reserve_fee call on the ConDex contract from " +
      "their own NEAR account, then you call condex_confirm_approval.",
    inputSchema: {
      quote_id: z.string(),
      side: z.enum(["buy", "sell"]),
      quantity: z.string().describe('Order size as a decimal string, e.g. "0.5"'),
      market: z.string().optional().describe("Optional. If given, it must be the insight's market."),
      limit_price: z.string().optional(),
      authorise_fee: z.boolean().describe("Must be true: the user has approved reserving the quoted fee"),
    },
  }, (args) => call("POST", "/v1/orders", args));

  server.registerTool("condex_confirm_approval", {
    title: "Confirm approval on NEAR",
    description:
      "After the user signed the order's reserve_fee call on the ConDex contract, ConDex checks the approval on NEAR " +
      "(payer, fee and order fingerprint) and submits the order. Answers approval_missing if it is not on chain yet. " +
      "Needs a key with trade scope.",
    inputSchema: { order_id: z.string() },
  }, ({ order_id }) => call("POST", `/v1/orders/${encodeURIComponent(order_id)}/confirm-approval`));

  server.registerTool("condex_get_order", {
    title: "Get order",
    description: "Show an order's status, fills, fee settlement, and once it has filled, the trade: open or closed, and its result.",
    inputSchema: { order_id: z.string() },
  }, ({ order_id }) => call("GET", `/v1/orders/${encodeURIComponent(order_id)}`));

  server.registerTool("condex_close_trade", {
    title: "Close trade",
    description:
      "Close the open position of a filled order with a closing order on the opposite side. It carries no fee and is allowed " +
      "after the thesis expired. Its confirmed fills become the closing fills of the proof of trade, and the result of the trade " +
      "(entry, exit, profit or loss, return %) is calculated from them. Needs a key with trade scope.",
    inputSchema: {
      order_id: z.string().describe("The filled order that opened the trade, e.g. ord_..."),
      quantity: z.string().optional().describe("How much to close. Defaults to everything still open."),
      limit_price: z.string().optional().describe("Optional limit price for the closing order"),
    },
  }, ({ order_id, ...rest }) => call("POST", `/v1/orders/${encodeURIComponent(order_id)}/close`, rest));

  server.registerTool("condex_list_receipts", {
    title: "List receipts",
    description: "List settlement receipts where this account is the borrower or the creator.",
    inputSchema: {},
  }, () => call("GET", "/v1/receipts"));

  server.registerTool("condex_subscription_status", {
    title: "Subscription status",
    description: "Show whether this account has an active ConDex subscription, when it ends, and its fee and period.",
    inputSchema: {},
  }, () => call("GET", "/v1/subscription"));

  server.registerTool("condex_subscribe", {
    title: "Subscribe",
    description:
      "Pay one ConDex subscription period from the account's ledger balance. It unlocks every thesis's conditions and " +
      "conversation; trading needs no subscription. The fee goes to ConDex. Renewing early adds a period after the current one. " +
      "Only call this after the user has approved the fee. Needs a key with trade scope.",
    inputSchema: {},
  }, () => call("POST", "/v1/subscription"));

  server.registerTool("condex_get_publisher", {
    title: "Get publisher",
    description:
      "A creator's public page: their score (accuracy of their theses against market data, and borrowers' net return %, " +
      "net profit $ and maximum drawdown % from closed trades), stats and the abstracts of what they published. Public.",
    inputSchema: { near_account_id: z.string().describe("The creator's NEAR account, e.g. alice.testnet") },
  }, ({ near_account_id }) => call("GET", `/v1/publishers/${encodeURIComponent(near_account_id)}`));

  return server;
}

/** How often a running MCP server tells ConDex it is still there. */
export const HELLO_EVERY_MS = 30_000;

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
  // Say hello again every so often, so "connected" means this process is still running now, and so a restarted ConDex
  // learns about a Claude Code session that was already open. It does not keep the process alive.
  setInterval(() => void sayHello(opts), HELLO_EVERY_MS).unref();
}
