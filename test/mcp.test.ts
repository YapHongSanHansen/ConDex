import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { displayPath, findClaudeCli } from "../src/mcp/claudeCli.ts";
import { buildMcpServer, sayHello } from "../src/mcp/server.ts";
import { ETH_MESSAGES, connectWallet, futureDate, startServer } from "./helpers.ts";

const srv = await startServer();
after(() => srv.close());

async function connect(apiKey: string | undefined) {
  const server = buildMcpServer({ apiUrl: srv.base, apiKey });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function json(result: unknown) {
  const r = result as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: !!r.isError, body: r.isError ? r.content[0]!.text : JSON.parse(r.content[0]!.text) };
}

test("a creator's agent publishes and a borrower's agent reads and trades over MCP", async () => {
  const { api } = srv;
  // MCP keys can only be issued after connecting a wallet.
  const aliceSession = (await connectWallet(api, "alice-mcp.testnet")).session;
  const bobSession = (await connectWallet(api, "bob-mcp.testnet")).session;
  const alicePublish = (await api("POST", "/v1/keys", { key: aliceSession, body: { scopes: ["publish"] } })).body.secret;
  const bobAgentKey = (await api("POST", "/v1/keys", { key: bobSession, body: { scopes: ["read", "trade"] } })).body.secret;
  await api("POST", "/v1/ledger/deposit", { key: bobSession, body: { amount_near: "2" } });

  const aliceAgent = await connect(alicePublish);
  const tools = (await aliceAgent.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "condex_close_trade", "condex_get_order", "condex_get_proof", "condex_get_publisher", "condex_list_insights",
    "condex_list_receipts", "condex_place_order", "condex_publish_insight", "condex_publish_version", "condex_quote_fee",
    "condex_read_insight", "condex_subscribe", "condex_subscription_status", "condex_whoami",
  ]);

  const published = json(await aliceAgent.callTool({
    name: "condex_publish_insight",
    arguments: {
      title: "ETH failed breakout", market: "ETH-USD", direction: "short",
      entry: "A 15-minute candle closes back below yesterday's UTC high.",
      invalidation: "A 1-hour close above the sweep high.",
      expiry_date: futureDate(3), expiry_time: "13:30", fee_near: "0.1", messages: ETH_MESSAGES,
    },
  }));
  assert.equal(published.isError, false);
  const tokenId = published.body.token_id;
  assert.equal(published.body.expires_at, `${futureDate(3)}T13:30:00.000Z`);
  assert.equal(published.body.expiry.set_by, "creator");

  // An agent that leaves out a condition is told, and nothing is published.
  const incomplete = json(await aliceAgent.callTool({
    name: "condex_publish_insight",
    arguments: { title: "No conditions", market: "ETH-USD", fee_near: "0.1", messages: ETH_MESSAGES },
  }));
  assert.equal(incomplete.isError, true);

  // Without an expiry date ConDex sets one, and the result tells the agent so it can tell the creator.
  const undated = json(await aliceAgent.callTool({
    name: "condex_publish_insight",
    arguments: {
      title: "ETH no date", market: "ETH-USD", direction: "short", entry: "Close below the high.",
      invalidation: "Close above the sweep high.", fee_near: "0.1", messages: ETH_MESSAGES,
    },
  }));
  assert.equal(undated.isError, false);
  assert.equal(undated.body.expiry.set_by, "condex_default");
  assert.match(undated.body.notice, /No expiry date was given/);

  // Alice's publish-only key cannot read.
  const denied = json(await aliceAgent.callTool({ name: "condex_read_insight", arguments: { token_id: tokenId } }));
  assert.equal(denied.isError, true);
  assert.match(denied.body, /403/);

  const bobAgent = await connect(bobAgentKey);
  const list = json(await bobAgent.callTool({ name: "condex_list_insights", arguments: { market: "ETH-USD" } }));
  const abstract = list.body.tokens.find((t: { token_id: string }) => t.token_id === tokenId);
  assert.equal(abstract.author_score.borrowers.trades, 0);
  assert.equal(abstract.conditions, undefined);
  const publisher = json(await bobAgent.callTool({ name: "condex_get_publisher", arguments: { near_account_id: "alice-mcp.testnet" } }));
  assert.deepEqual(publisher.body.score, abstract.author_score);

  // The full thesis needs a subscription, which the agent pays for from Bob's balance.
  const locked = json(await bobAgent.callTool({ name: "condex_read_insight", arguments: { token_id: tokenId } }));
  assert.equal(locked.isError, true);
  assert.match(locked.body, /402.*subscription_required/);
  assert.equal(json(await bobAgent.callTool({ name: "condex_subscription_status", arguments: {} })).body.active, false);
  const subscribed = json(await bobAgent.callTool({ name: "condex_subscribe", arguments: {} }));
  assert.equal(subscribed.body.active, true);

  const read = json(await bobAgent.callTool({ name: "condex_read_insight", arguments: { token_id: tokenId } }));
  assert.equal(read.body.charge.near, "0");
  assert.equal(read.body.messages.length, 2);
  assert.equal(read.body.conditions.direction, "short");
  assert.equal(read.body.conditions.invalidation, "A 1-hour close above the sweep high.");

  // The borrower's agent cannot link an order that opens against the thesis.
  const wrongWay = json(await bobAgent.callTool({ name: "condex_quote_fee", arguments: { token_id: tokenId } }));
  const refused = json(await bobAgent.callTool({
    name: "condex_place_order",
    arguments: { quote_id: wrongWay.body.quote_id, side: "buy", quantity: "1", authorise_fee: true },
  }));
  assert.equal(refused.isError, true);
  assert.match(refused.body, /direction_mismatch/);

  const quote = json(await bobAgent.callTool({ name: "condex_quote_fee", arguments: { token_id: tokenId } }));
  const order = json(await bobAgent.callTool({
    name: "condex_place_order",
    arguments: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true },
  }));
  assert.equal(order.body.status, "open");

  await api("POST", `/v1/sim/orders/${order.body.id}/fill`, { body: { price: "3500" } });
  const after = json(await bobAgent.callTool({ name: "condex_get_order", arguments: { order_id: order.body.id } }));
  assert.equal(after.body.settlement.status, "settled");
  const receipts = json(await bobAgent.callTool({ name: "condex_list_receipts", arguments: {} }));
  assert.equal(receipts.body.receipts.length, 1);

  // The borrower's agent closes the trade; the closing fill brings the result.
  const closing = json(await bobAgent.callTool({ name: "condex_close_trade", arguments: { order_id: order.body.id } }));
  assert.equal(closing.isError, false);
  assert.equal(closing.body.side, "buy");
  await api("POST", `/v1/sim/orders/${closing.body.id}/fill`, { body: { price: "3400" } });
  const closed = json(await bobAgent.callTool({ name: "condex_get_order", arguments: { order_id: order.body.id } }));
  assert.equal(closed.body.trade.status, "closed");
  assert.equal(closed.body.trade.result.outcome, "win");
  assert.equal(closed.body.trade.result.pnl, "100");
  // Alice's publish-only key cannot close someone else's trade.
  assert.equal(json(await aliceAgent.callTool({ name: "condex_close_trade", arguments: { order_id: order.body.id } })).isError, true);

  const noKey = await connect(undefined);
  assert.equal(json(await noKey.callTool({ name: "condex_whoami", arguments: {} })).isError, true);
});

test("an MCP server saying hello makes its key show as connected, with its tools", async () => {
  const { api } = srv;
  const session = (await connectWallet(api, "carol-mcp.testnet")).session;
  const issued = (await api("POST", "/v1/keys", { key: session, body: { scopes: ["publish", "read"], label: "MCP agent" } })).body;

  const before = (await api("GET", "/v1/keys", { key: session })).body.keys.find((k: { id: string }) => k.id === issued.id);
  assert.equal(before.mcp, null, "a key nobody has used is not connected");

  // Using the key for ordinary API calls does not count as an MCP connection.
  await api("GET", "/v1/me", { key: issued.secret });
  const stillNot = (await api("GET", "/v1/keys", { key: session })).body.keys.find((k: { id: string }) => k.id === issued.id);
  assert.equal(stillNot.mcp, null);

  // The wallet session cannot say hello: only the MCP key can.
  assert.equal((await api("POST", "/v1/mcp/hello", { key: session, body: {} })).status, 400);

  await sayHello({ apiUrl: srv.base, apiKey: issued.secret });
  const after = (await api("GET", "/v1/keys", { key: session })).body.keys.find((k: { id: string }) => k.id === issued.id);
  assert.ok(after.mcp.connectedAt);
  assert.equal(after.mcp.client, "condex-mcp");
  assert.ok(after.mcp.tools.includes("condex_publish_insight"));

  const tools = (await api("GET", "/v1/mcp/tools")).body.tools.map((t: { name: string }) => t.name);
  assert.equal(tools.length, 14);
  assert.ok(tools.includes("condex_place_order"));

  await sayHello({ apiUrl: srv.base, apiKey: "cdx_not-a-real-key" }); // must not throw
});

test("claude cli finder reports a CLI that is installed but not on PATH", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "condex-home-"));
  const bin = join(home, ".vscode", "extensions", "anthropic.claude-code-9.9.9-darwin-arm64", "resources", "native-binary");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, process.platform === "win32" ? "claude.exe" : "claude"), "");
  const found = findClaudeCli({ PATH: "" }, home);
  assert.equal(found.onPath, null);
  assert.ok(found.fallback?.includes("anthropic.claude-code-9.9.9"));
  assert.deepEqual(findClaudeCli({ PATH: "" }, mkdtempSync(join(tmpdir(), "condex-empty-"))), { onPath: null, fallback: null });
});

test("disconnecting MCP revokes the key and clears the connected state", async () => {
  const { api } = srv;
  const session = (await connectWallet(api, "dave-mcp.testnet")).session;
  const issued = (await api("POST", "/v1/keys", { key: session, body: { scopes: ["read"], label: "MCP agent" } })).body;
  await sayHello({ apiUrl: srv.base, apiKey: issued.secret });
  const connected = (await api("GET", "/v1/keys", { key: session })).body.keys.find((k: { id: string }) => k.id === issued.id);
  assert.ok(connected.mcp);

  // Only a wallet session can disconnect, not the agent's own key.
  assert.equal((await api("POST", "/v1/mcp/disconnect", { key: issued.secret })).status, 403);

  const res = await api("POST", "/v1/mcp/disconnect", { key: session });
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, 1);
  const after = (await api("GET", "/v1/keys", { key: session })).body.keys.find((k: { id: string }) => k.id === issued.id);
  assert.ok(after.revoked_at);
  assert.equal(after.mcp, null);
  assert.equal((await api("GET", "/v1/me", { key: issued.secret })).status, 401, "the agent's key stops working");
  assert.equal((await api("POST", "/v1/mcp/disconnect", { key: session })).body.revoked, 0, "nothing left to disconnect");
});

test("paths shown to people never include the home folder", () => {
  assert.equal(displayPath("/Users/someone/code/ConDex/src/mcp/server.ts", "/Users/someone"), "$HOME/code/ConDex/src/mcp/server.ts");
  assert.equal(displayPath("/opt/condex/server.ts", "/Users/someone"), "/opt/condex/server.ts");
  assert.equal(displayPath("/Users/someoneelse/x", "/Users/someone"), "/Users/someoneelse/x");
  const found = findClaudeCli({ PATH: "" }, "/nonexistent-home-for-test");
  assert.deepEqual(found, { onPath: null, fallback: null });
});
