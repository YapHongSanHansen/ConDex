import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.ts";
import { ETH_MESSAGES, startServer } from "./helpers.ts";

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
  const alice = await api("POST", "/v1/accounts", { body: { near_account_id: "alice-mcp.testnet", display_name: "Alice" } });
  const bob = await api("POST", "/v1/accounts", { body: { near_account_id: "bob-mcp.testnet", display_name: "Bob" } });
  const alicePublish = (await api("POST", "/v1/keys", { key: alice.body.owner_key.secret, body: { scopes: ["publish"] } })).body.secret;
  const bobAgentKey = (await api("POST", "/v1/keys", { key: bob.body.owner_key.secret, body: { scopes: ["read", "trade"] } })).body.secret;
  await api("POST", "/v1/ledger/deposit", { key: bob.body.owner_key.secret, body: { amount_near: "1" } });

  const aliceAgent = await connect(alicePublish);
  const tools = (await aliceAgent.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, [
    "condex_get_order", "condex_list_insights", "condex_list_receipts", "condex_place_order", "condex_publish_insight",
    "condex_publish_version", "condex_quote_fee", "condex_read_insight", "condex_whoami",
  ]);

  const published = json(await aliceAgent.callTool({
    name: "condex_publish_insight",
    arguments: { title: "ETH failed breakout", market: "ETH-USD", fee_near: "0.1", messages: ETH_MESSAGES },
  }));
  assert.equal(published.isError, false);
  const tokenId = published.body.token_id;

  // Alice's publish-only key cannot read.
  const denied = json(await aliceAgent.callTool({ name: "condex_read_insight", arguments: { token_id: tokenId } }));
  assert.equal(denied.isError, true);
  assert.match(denied.body, /403/);

  const bobAgent = await connect(bobAgentKey);
  const list = json(await bobAgent.callTool({ name: "condex_list_insights", arguments: { market: "ETH-USD" } }));
  assert.ok(list.body.tokens.some((t: { token_id: string }) => t.token_id === tokenId));

  const read = json(await bobAgent.callTool({ name: "condex_read_insight", arguments: { token_id: tokenId } }));
  assert.equal(read.body.charge.near, "0");
  assert.equal(read.body.messages.length, 2);

  const quote = json(await bobAgent.callTool({ name: "condex_quote_fee", arguments: { token_id: tokenId } }));
  const order = json(await bobAgent.callTool({
    name: "condex_place_order",
    arguments: { quote_id: quote.body.quote_id, side: "sell", quantity: "1", authorise_fee: true },
  }));
  assert.equal(order.body.status, "open");

  await api("POST", `/v1/sim/orders/${order.body.id}/fill`);
  const after = json(await bobAgent.callTool({ name: "condex_get_order", arguments: { order_id: order.body.id } }));
  assert.equal(after.body.settlement.status, "settled");
  const receipts = json(await bobAgent.callTool({ name: "condex_list_receipts", arguments: {} }));
  assert.equal(receipts.body.receipts.length, 1);

  const noKey = await connect(undefined);
  assert.equal(json(await noKey.callTool({ name: "condex_whoami", arguments: {} })).isError, true);
});
