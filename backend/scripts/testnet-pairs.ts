// A few real pairs of theses, one long and one short on the same window, each with one linked trade,
// opened and closed at live CoinGecko prices. Nobody can predict a live window, but of each pair one side
// comes out right, so this prepares genuine examples to show: minted before the window, traded during it,
// judged after it.
//
//   npm run testnet:pairs -- <creator-account> <trader-account> [minutes ...]     windows, default 15 30 45
//   npm run testnet:pairs -- --mock <creator> <trader> [minutes ...]              dry run on the mock ledger
//
// On NEAR it needs: the API running with CONDEX_LEDGER=near and the CoinGecko feed (CONDEX_API_URL, default
// http://localhost:8787), in dev mode, on this computer; near-cli with the trader's key in its keychain; and
// about 0.1 NEAR per thesis on the trader's account. Every thesis, approval, fill, close and evaluation is a
// real testnet transaction. Use CONDEX_DB_PATH on the API so the orders are still there afterwards.
import { spawnSync } from "node:child_process";
import { findNearCli } from "../src/near/nearCli.ts";
import { connectWallet } from "../test/helpers.ts";

const BASE = process.env.CONDEX_API_URL ?? "http://localhost:8787";
const args = process.argv.slice(2);
const mock = args[0] === "--mock";
if (mock) args.shift();
const [CREATOR, TRADER, ...minuteArgs] = args;
const WINDOWS = (minuteArgs.length ? minuteArgs : ["15", "30", "45"]).map(Number);
if (!CREATOR || !TRADER || WINDOWS.some((m) => !Number.isFinite(m) || m < 6)) {
  console.error("Usage: npm run testnet:pairs -- [--mock] <creator-account> <trader-account> [minutes ...]\n" +
    "  Each window must be at least 6 minutes. Example: npm run testnet:pairs -- alice.testnet bob.testnet 15 30");
  process.exit(1);
}

const QUANTITY = "1";
const FEE_NEAR = "0.1";
const EXPLORER = "https://explorer.testnet.near.org/transactions/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = () => new Date().toISOString().slice(11, 19);
const say = (text: string) => console.log(`[${clock()}] ${text}`);

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

/** Like `api`, but a refusal stops the run with the API's own message. */
async function must(what: string, method: string, path: string, opts: { key?: string; body?: unknown } = {}) {
  const res = await api(method, path, opts);
  if (res.status >= 400) throw new Error(`${what}: ${res.body?.error?.message ?? `the API answered ${res.status}`}`);
  return res.body;
}

// ---- NEAR ----

const nearCli = mock ? null : findNearCli();
/** Signs a call on the contract as `signer`, with the key near-cli keeps for that account. Returns the transaction. */
function nearCall(contract: string, signer: string, method: string, callArgs: object, deposit = "0 NEAR"): string {
  const run = spawnSync(nearCli!, [
    "contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(callArgs),
    "prepaid-gas", "30 Tgas", "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-keychain", "send",
  ], { encoding: "utf8", windowsHide: true });
  const out = `${run.stdout}${run.stderr}`; // near-cli writes its report to stderr
  const tx = /Transaction ID: (\w+)/.exec(out)?.[1];
  if (run.status !== 0 || /ERROR/.test(out) || !tx) {
    throw new Error(`${method} signed by ${signer} failed${tx ? ` (transaction ${tx})` : ""}: ${/panicked[^\n"]*/.exec(out)?.[0] ?? out.slice(-400)}`);
  }
  return tx;
}

interface OutboxCall { method: string; ref: string | null; status: string; tx_hash: string | null; error: string | null }
const outbox = async () => (await must("outbox", "GET", "/v1/chain/outbox")).calls as OutboxCall[];

/** Waits until the API has sent a call about `ref` on NEAR, and returns its transaction. */
async function sent(method: string, ref: string, timeoutSeconds = 180): Promise<string> {
  for (let i = 0; i < timeoutSeconds; i++) {
    const call = (await outbox()).find((c) => c.method === method && c.ref === ref);
    if (call?.status === "failed") throw new Error(`${method} for ${ref} was refused on NEAR: ${call.error}`);
    if (call?.status === "sent" && call.tx_hash) return call.tx_hash;
    await sleep(1000);
  }
  throw new Error(`${method} for ${ref} was still not sent on NEAR after ${timeoutSeconds} seconds`);
}

// ---- the run ----

const health = (await api("GET", "/health").catch(() => null))?.body;
if (!health) throw new Error(`No ConDex API answered at ${BASE}. Start it with npm start`);
const onNear = health.ledger === "near-testnet";
if (!onNear && !mock) {
  throw new Error(`The API at ${BASE} is on the ${health.ledger} ledger. Start it with CONDEX_LEDGER=near and the NEAR keys in .env, or pass --mock for a dry run`);
}
if (onNear && mock) throw new Error("--mock is for the mock ledger, but this API is on NEAR");
if (health.market_data !== "feed:coingecko") {
  throw new Error(`The API judges theses on "${health.market_data}". Set CONDEX_COINGECKO_API_KEY so fills and evaluations use real prices`);
}
if (health.clock?.mode !== "real") throw new Error("A replay clock is set on the API. Reset it first: npm run replay -- reset");
if (onNear && !nearCli) throw new Error("near-cli was not found. Install it with: npm install -g near-cli-rs");
const contract = onNear ? (await must("outbox", "GET", "/v1/chain/outbox")).contract as string : null;
say(`API ${BASE}, ${onNear ? `NEAR testnet, contract ${contract}` : "MOCK LEDGER (dry run: nothing is sent to NEAR)"}, prices from CoinGecko`);

/** Signs in with the account's real key through near-cli when it has one, so the same account can connect later. */
async function signIn(account: string, needsRealKey: boolean): Promise<string> {
  if (onNear) {
    const real = await api("POST", "/v1/dev/wallet/near-cli", { body: { account_id: account } });
    if (real.status === 201) return real.body.session.token as string;
    if (needsRealKey) throw new Error(`Could not sign in as ${account} with near-cli: ${real.body?.error?.message ?? real.status}`);
  }
  const session = (await connectWallet(api as never, account)).session;
  if (!session) throw new Error(`Could not sign in as ${account}. If it signed in before with another key, use a file database from scratch or the account's real key`);
  if (onNear) say(`${account} has no key in near-cli here, so it signed in with a throwaway key (dev mode only)`);
  return session;
}
const creator = await signIn(CREATOR, false);
const trader = await signIn(TRADER, onNear);
const publishKey = (await must("publish key", "POST", "/v1/keys", { key: creator, body: { scopes: ["publish"] } })).secret as string;

interface Leg {
  minutes: number; direction: "long" | "short"; tokenId: string; orderId: string; expiresAt: string;
  txs: Record<string, string>; fill?: string; close?: string; result?: any; evaluation?: any;
}
const legs: Leg[] = [];

// 1. Publish each pair. Both sides see the same market and the same window; only the direction differs.
for (const minutes of WINDOWS) {
  const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
  for (const direction of ["long", "short"] as const) {
    const published = await must(`publish the ${minutes}-minute ${direction}`, "POST", "/v1/insights", { key: publishKey, body: {
      title: `ETH ${direction} for the next ${minutes} minutes`,
      market: "ETH-USD", direction,
      entry: "At the market, now.",
      invalidation: `ETH is not ${direction === "long" ? "higher" : "lower"} when the window ends.`,
      summary: `One side of a long and short pair on the same ${minutes}-minute window. Judged on direction only.`,
      expires_at: expiresAt, fee_near: FEE_NEAR,
      messages: [
        { role: "user", content: `Where is ETH in ${minutes} minutes: higher or lower than now?` },
        { role: "assistant", content: `This thesis says ${direction === "long" ? "higher" : "lower"}. Its twin says the opposite, so exactly one of them can be right.` },
      ],
    } });
    legs.push({ minutes, direction, tokenId: published.token_id, orderId: "", expiresAt, txs: {} });
    say(`published ${published.token_id} (${direction}, expires ${expiresAt.slice(11, 19)} UTC)`);
  }
}
if (onNear) for (const leg of legs) leg.txs.mint = await sent("mint_thesis", leg.tokenId);

// 2. The trader links one order to each thesis and approves its fee.
if (onNear) {
  const need = BigInt(legs.length) * 10n ** 23n; // 0.1 NEAR each
  const balance = await must("balance", "GET", `/v1/ledger/balances/${TRADER}`);
  const available = BigInt(balance.available.yocto ?? "0");
  if (available < need) {
    const missing = Number(need - available) / 1e24;
    say(`${TRADER} deposits ${missing} NEAR into the contract (transaction ${nearCall(contract!, TRADER, "deposit", {}, `${missing} NEAR`)})`);
  }
} else {
  await must("deposit", "POST", "/v1/ledger/deposit", { key: trader, body: { amount_near: String(legs.length * 0.1 + 0.1) } });
}
for (const leg of legs) {
  const quote = await must("quote", "POST", "/v1/quotes", { key: trader, body: { token_id: leg.tokenId } });
  const order = await must("order", "POST", "/v1/orders", { key: trader, body: {
    quote_id: quote.quote_id, side: leg.direction === "long" ? "buy" : "sell", quantity: QUANTITY, authorise_fee: true,
  } });
  leg.orderId = order.id;
  if (onNear) {
    leg.txs.approval = nearCall(contract!, TRADER, "reserve_fee", order.approval.args);
    await must("confirm the approval", "POST", `/v1/orders/${order.id}/confirm-approval`, { key: trader });
  }
  // No price given: the simulated venue fills at the feed's current price.
  const filled = await must("fill", "POST", `/v1/sim/orders/${order.id}/fill`, { body: {} });
  leg.fill = filled.event.price;
  if (onNear) leg.txs.settlement = await sent("settle_fee", order.id);
  say(`${leg.direction} ${leg.minutes} min: order ${order.id} filled at ${leg.fill}, fee settled`);
}

// 3. Close each trade as its window ends, at the feed's price then. The trade then runs over the same
// stretch the thesis is judged on: from the price at publishing to the price at the deadline.
for (const minutes of WINDOWS) {
  const pair = legs.filter((l) => l.minutes === minutes);
  const closeAt = Date.parse(pair[0]!.expiresAt) + 5_000;
  say(`waiting until ${new Date(closeAt).toISOString().slice(11, 19)} UTC to close the ${minutes}-minute pair`);
  await sleep(Math.max(0, closeAt - Date.now()));
  for (const leg of pair) {
    const closed = await must("close", "POST", `/v1/sim/orders/${leg.orderId}/close`, { body: {} });
    leg.close = closed.event.price;
    if (onNear) leg.txs.close = await sent("record_close", leg.orderId);
    say(`${leg.direction} ${minutes} min: closed at ${leg.close}`);
  }
}

// 4. A few minutes after each deadline the sweep has the candles, judges the thesis and records the result.
for (const leg of legs) {
  const giveUp = Date.parse(leg.expiresAt) + 12 * 60_000;
  for (;;) {
    const proof = await must("proof", "GET", `/v1/tokens/${leg.tokenId}/proof`);
    if (proof.evaluation.status === "evaluated") {
      leg.evaluation = proof.evaluation;
      leg.result = proof.proofs_of_trade[0]?.result ?? null;
      if (onNear) leg.txs.evaluation = await sent("record_evaluation", leg.tokenId);
      break;
    }
    if (Date.now() > giveUp) {
      say(`${leg.tokenId} is still not judged 12 minutes after its deadline. It will be when the API's sweep gets its candles`);
      break;
    }
    await sleep(20_000);
  }
}

// ---- what happened ----
console.log("\nResults");
for (const leg of legs) {
  const ev = leg.evaluation;
  console.log(`\n${leg.minutes}-minute ${leg.direction.toUpperCase()}  ${leg.tokenId}`);
  console.log(`  trade       ${leg.direction === "long" ? "bought" : "sold"} ${QUANTITY} ETH at ${leg.fill}, closed at ${leg.close}` +
    (leg.result ? `: ${leg.result.net_profit_usd >= 0 ? "+" : ""}${leg.result.net_profit_usd} USD (${leg.result.net_return_pct}%), before costs` : ""));
  console.log(ev
    ? `  evaluation  ${ev.outcome}: conditions ${ev.conditions_met ? "MET" : "not met"} (ETH ${ev.reference_price} at publish, ${ev.final_price} at the deadline, ${ev.source})`
    : "  evaluation  pending");
  for (const [what, tx] of Object.entries(leg.txs)) console.log(`  ${what.padEnd(11)} ${EXPLORER}${tx}`);
  console.log(`  proof       ${BASE}/v1/tokens/${leg.tokenId}/proof`);
}
// The one to show is right on both counts: its conditions were met and the trade on it made money.
const met = legs.filter((l) => l.evaluation?.conditions_met);
const winners = met.filter((l) => l.result?.net_profit_usd > 0);
console.log(winners.length
  ? `\nTo show on stage: ${winners.map((l) => `${l.tokenId} (${l.minutes}-minute ${l.direction})`).join(", ")}`
  : "\nNo thesis came out right with a profitable trade (ETH ended a window about where it started, or evaluations are still pending). Run another pair.");
for (const l of met.filter((x) => !winners.includes(x))) {
  console.log(`Not for the stage: ${l.tokenId} was judged right, but its trade did not make money. The trade's fills were seconds away from the candles the evaluation used, and the price barely moved.`);
}
