// One full ConDex trade through the API running on the NEAR contract (CONDEX_LEDGER=near), on testnet.
//
//   node scripts/testnet-flow.ts [creator-account] [trader-account]
//
// Needs: the API running with CONDEX_LEDGER=near on CONDEX_API_URL (default http://localhost:8787), near-cli
// with the trader's key in the Keychain, and the trader already subscribed (or enough NEAR to subscribe).
// The creator signs in with a throwaway key, which only works while the API runs in dev mode.
import { spawnSync } from "node:child_process";
import { connectWallet, ETH_MESSAGES } from "../test/helpers.ts";

const BASE = process.env.CONDEX_API_URL ?? "http://localhost:8787";
const NEAR = process.env.NEAR_CLI ?? `${process.env.HOME}/.cargo/bin/near`;
const CREATOR = process.argv[2] ?? "goodtie1551.testnet";
const TRADER = process.argv[3] ?? "trader.dryward2518.testnet";

async function api(method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  // A fresh connection each time: signing with near-cli takes longer than the server keeps an idle one open.
  const res = await fetch(BASE + path, {
    method,
    headers: {
      connection: "close",
      ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const step = (n: string, detail: unknown) => console.log(`${n.padEnd(34)} ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);

/** Signs a call on the contract as `signer` with near-cli, using the key near-cli keeps in the Keychain. */
function nearCall(contract: string, signer: string, method: string, args: object, deposit = "0 NEAR") {
  const run = spawnSync(NEAR, [
    "contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "30 Tgas", "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "send",
  ], { encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`; // near-cli writes its report to stderr
  const tx = /Transaction ID: (\w+)/.exec(out)?.[1] ?? "?";
  if (run.status !== 0 || /ERROR/.test(out)) throw new Error(`${method} by ${signer} failed (tx ${tx}): ${/panicked: [^\n"]*/.exec(out)?.[0] ?? out.slice(-400)}`);
  return tx;
}

async function view(contract: string, method: string, args: object) {
  const res = await fetch("https://test.rpc.fastnear.com", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: {
      request_type: "call_function", finality: "final", account_id: contract, method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    } }),
  });
  const j: any = await res.json();
  return JSON.parse(Buffer.from(j.result.result).toString());
}

/** Waits until the API's outbox has sent every queued call. */
async function sent(what: string) {
  for (let i = 0; i < 90; i++) {
    const calls = (await api("GET", "/v1/chain/outbox")).body.calls as Array<{ method: string; status: string; tx_hash: string | null; error: string | null }>;
    const failed = calls.find((c) => c.status === "failed");
    if (failed) throw new Error(`${failed.method} failed on NEAR: ${failed.error}`);
    if (!calls.some((c) => c.status === "queued")) return calls;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what}: still queued after 90 s`);
}

const health = (await api("GET", "/health")).body;
if (health?.ledger !== "near-testnet") throw new Error(`The API at ${BASE} is not on NEAR (ledger: ${health?.ledger}). Start it with CONDEX_LEDGER=near`);
const contract = (await api("GET", "/v1/chain/outbox")).body.contract as string;
step("API", `${BASE} on ${contract}`);

const creator = (await connectWallet(api as never, CREATOR)).session;
const trader = (await connectWallet(api as never, TRADER)).session;
const publishKey = (await api("POST", "/v1/keys", { key: creator, body: { scopes: ["publish"] } })).body.secret;

const expiry = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
const published = await api("POST", "/v1/insights", { key: publishKey, body: {
  title: "ETH failed breakout (testnet run)", market: "ETH-USD", direction: "short",
  entry: "A 15-minute close back below yesterday's UTC high.", invalidation: "A 1-hour close above the sweep high.",
  expiry_date: expiry, fee_near: "0.1", messages: ETH_MESSAGES,
} });
if (published.status !== 201) throw new Error(`publish: ${JSON.stringify(published.body)}`);
const tokenId = published.body.token_id;
step("1. published", `${tokenId}, mint ${published.body.mint.tx}`);
let calls = await sent("mint");
step("   mint_thesis on NEAR", `tx ${calls.find((c) => c.method === "mint_thesis")!.tx_hash}`);
const token = await view(contract, "nft_token", { token_id: tokenId });
step("   nft_token", { token_id: token.token_id, owner: token.owner_id });

const read = await api("GET", `/v1/tokens/${tokenId}`, { key: trader });
step("2. full read (subscription_of)", read.status === 200 ? "allowed: the trader is subscribed on NEAR" : `${read.status} ${read.body.error?.code}`);

const quote = await api("POST", "/v1/quotes", { key: trader, body: { token_id: tokenId } });
const order = (await api("POST", "/v1/orders", { key: trader, body: { quote_id: quote.body.quote_id, side: "sell", quantity: "2", authorise_fee: true } })).body;
step("3. order", `${order.id} ${order.status}`);

const balance = await view(contract, "balance_of", { account_id: TRADER });
if (BigInt(balance.available) < BigInt(order.approval.args.fee)) {
  step("   trader deposits 0.1 NEAR", `tx ${nearCall(contract, TRADER, "deposit", {}, "0.1 NEAR")}`);
}
step("   trader signs reserve_fee", `tx ${nearCall(contract, TRADER, "reserve_fee", order.approval.args)}`);
const confirmed = await api("POST", `/v1/orders/${order.id}/confirm-approval`, { key: trader });
step("4. confirm-approval", `${confirmed.status} → order ${confirmed.body.status ?? confirmed.body.error?.code}`);

await api("POST", `/v1/sim/orders/${order.id}/fill`, { body: { price: "3500" } });
calls = await sent("settle");
step("5. fill → settle_fee on NEAR", `tx ${calls.find((c) => c.method === "settle_fee")!.tx_hash}`);
await api("POST", `/v1/sim/orders/${order.id}/close`, { body: { price: "3400" } });
calls = await sent("close");
step("6. close → record_close on NEAR", `tx ${calls.find((c) => c.method === "record_close")!.tx_hash}`);

const proof = (await view(contract, "get_proofs", { token_id: tokenId, from_index: 0, limit: 5 }))[0];
step("7. proof of trade on NEAR", {
  trader: proof.trader, fill: `${proof.fill.quantity} @ ${proof.fill.price}`, fee_paid: proof.fee_paid,
  closes: proof.closing_fills.map((c: any) => `${c.quantity} @ ${c.price}`),
});
const earned = await view(contract, "balance_of", { account_id: CREATOR });
step("   creator's balance in the contract", { available: earned.available, earned_total: earned.earned_total });
