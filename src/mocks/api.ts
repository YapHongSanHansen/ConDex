// @mock-remove — delete after the backend is connected
import { ApiError } from "@/lib/api/errors";
import type { Api, Insight, InsightDetail, KeyRow, ListInsightsParams, Receipt } from "@/lib/api/types";
import type { ClosingOrder, IssuedKey, McpTool, Order, Quote, SubscriptionStatus, WireAccount } from "@/lib/api/wire";
import { MOCK_INSIGHTS, MOCK_ME, MOCK_PRIVATE_TEXT } from "./data";

// Mutable in-memory state so borrow/revoke/publish visibly change the UI.
const MOCK_FAIL_RATE = Number(process.env.NEXT_PUBLIC_MOCK_FAIL_RATE ?? "0");

const insights = [...MOCK_INSIGHTS];
const receipts: Receipt[] = [];
const orders: Order[] = [];
const quotes = new Map<string, Quote>();
let subscribedUntil: string | null = null;
let balance = 5; // test NEAR on the mock ledger
let earned = 0;
// Keys and sign-in, in the backend's own shapes (see wire.ts), so the pages never notice the switch.
const mockKeys: Array<KeyRow & { secret: string }> = [];
const MOCK_TOOLS: McpTool[] = [
  ["condex_whoami", "Who am I", "Show the ConDex account and scopes of the connected key."],
  ["condex_list_insights", "List insights", "List the public previews of published theses."],
  ["condex_read_insight", "Read an insight", "Read a full conversation. Needs the read scope. Always free."],
  ["condex_publish_insight", "Publish an insight", "Publish a thesis with its conditions and an expiry."],
  ["condex_publish_version", "Publish a new version", "Publish a new version of one of your theses."],
  ["condex_quote_fee", "Quote the fee", "Get the fee for linking an order to a thesis."],
  ["condex_place_order", "Place an order", "Place an order linked to a thesis. Needs the trade scope."],
  ["condex_get_order", "Get an order", "Check an order, its fills and its trade result."],
  ["condex_close_trade", "Close a trade", "Close an open position with a closing order."],
  ["condex_get_proof", "Get the proof", "Read the proof of thesis and the proofs of trade."],
  ["condex_list_receipts", "List receipts", "List the fees you have paid or earned."],
].map(([name, title, description]) => ({ name, title, description }));
/** A key without its secret, which is never listed. */
const toRow = (k: KeyRow & { secret: string }): KeyRow => ({ id: k.id, prefix: k.prefix, label: k.label, scopes: [...k.scopes], createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, revoked: k.revoked, mcp: k.mcp });
const MOCK_ACCOUNT = (id: string): WireAccount => ({ id: "acct_mock", near_account_id: id, display_name: id, created_at: new Date().toISOString() });
let counter = 100;

async function delay<T>(fn: () => T, canFail = true): Promise<T> {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  if (canFail && Math.random() < MOCK_FAIL_RATE) {
    throw new ApiError("server_error", "Mock failure (NEXT_PUBLIC_MOCK_FAIL_RATE)", true);
  }
  return fn();
}

const toPreview = ({ id, market, horizon, price, expires_at, evaluation_deadline, version, creator, status, created_at, direction, title }: InsightDetail): Insight => ({
  id, market, horizon, price, expires_at, evaluation_deadline, version, creator, status, created_at, direction, title,
});

const PAGE = 6;

function find(id: string): InsightDetail {
  const i = insights.find((x) => x.id === id.replace(/-v\d+$/, ""));
  if (!i) throw new ApiError("not_found", "No such insight");
  return i;
}
function filterInsights(p: ListInsightsParams): InsightDetail[] {
  const now = Date.now();
  let out = insights.filter((i) => {
    if (p.market && !i.market.toLowerCase().includes(p.market.toLowerCase())) return false;
    if (p.horizon && i.horizon !== p.horizon) return false;
    if (p.direction && i.direction !== p.direction) return false;
    if (!p.include_expired && i.status !== "live") return false;
    if (p.max_price !== undefined && i.price > Number(p.max_price)) return false;
    const left = new Date(i.expires_at).getTime() - now;
    if (p.expiry === "soon" && !(left > 0 && left < 24 * 3600 * 1000)) return false;
    if (p.expiry === "later" && left < 24 * 3600 * 1000) return false;
    return true;
  });
  out = [...out].sort((a, b) => {
    if (p.sort === "cheapest") return a.price - b.price;
    if (p.sort === "expiring") return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return out;
}

const money = (n: number) => ({ yocto: String(Math.round(n * 1e6)) + "0".repeat(18), near: String(n) });
const FEE_SUB = 1;

function subscriptionStatus(): SubscriptionStatus {
  const active = !!subscribedUntil && new Date(subscribedUntil).getTime() > Date.now();
  return {
    account_id: MOCK_ME, active, subscribed_until: active ? subscribedUntil : null,
    terms: { fee: money(FEE_SUB), period_days: 30, paid_to: "condex-treasury.testnet", unlocks: "Every thesis's conditions and conversation. Trading needs no subscription.", how: "POST /v1/subscription" },
  };
}

function findOrder(id: string): Order {
  const o = orders.find((x) => x.id === id);
  if (!o) throw new ApiError("not_found", "No such order");
  return o;
}

/** The trade of an order: open until closing fills add up to what was filled. */
function tradeOf(o: Order): Order["trade"] {
  const opened = Number(o.filled_quantity);
  if (opened <= 0) return null;
  const closed = o.closing_orders.reduce((a, c) => a + Number(c.filled_quantity), 0);
  const fills = o.closing_orders.flatMap((c) => c.fills);
  const dir = o.side === "buy" ? "long" : "short";
  const last = fills.at(-1) ?? null;
  const entry = Number(o.execution_events.find((e) => e.type === "fill")?.price ?? 0);
  const exit = last ? Number(last.price) : 0;
  const done = closed >= opened;
  const pnl = (dir === "long" ? exit - entry : entry - exit) * opened;
  return {
    status: done ? "closed" : closed > 0 ? "partially_closed" : "open", direction: dir, opened_quantity: String(opened),
    closed_quantity: String(closed), open_quantity: String(opened - closed), closing_fills: fills, closing_fill: last,
    result: done ? { available: true, entry_price: String(entry), exit_price: String(exit), quantity: String(opened), pnl: String(pnl), return_pct: String(Math.round((pnl / (entry * opened)) * 1e4) / 100), outcome: pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat" } : null,
  };
}

export const MOCK_API: Api = {
  insights: {
    listInsights: (params) =>
      delay(() => {
        const all = filterInsights(params);
        const start = params.cursor ? Number(params.cursor) : 0;
        const slice = all.slice(start, start + PAGE);
        return { items: slice.map(toPreview), next_cursor: start + PAGE < all.length ? String(start + PAGE) : null, total: all.length };
      }),
    getInsight: (id) => delay(() => find(id)),
    listMarkets: () => delay(() => [...new Set(insights.map((i) => i.market))].sort()),
    getStats: () =>
      delay(() => ({
        insights_listed: insights.filter((i) => i.status === "live").length,
        trades_today: 14 + orders.length,
        paid_to_creators: 31.4 + earned,
      })),
  },
  trading: {
    subscription: () => delay(subscriptionStatus),
    subscribe: () =>
      delay(() => {
        if (balance < FEE_SUB) throw new ApiError("insufficient_funds", "Not enough test NEAR");
        balance -= FEE_SUB;
        subscribedUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
        return subscriptionStatus();
      }),
    deposit: (amount) => delay(() => { balance += Number(amount); return { ledger: "mock", account: MOCK_ME, available: money(balance), reserved: money(0), earned: money(earned) }; }),
    balances: (account) => delay(() => ({ ledger: "mock", account, available: money(balance), reserved: money(orders.filter((o) => o.settlement.status === "pending").length * 0.5), earned: money(earned) })),
    read: (tokenId) =>
      delay(() => {
        const i = find(tokenId);
        if (!subscriptionStatus().active && i.creator !== MOCK_ME) throw new ApiError("subscription_required", "A subscription unlocks the full thesis.");
        return {
          token_id: i.id, insight_id: i.id, version: i.version, title: i.title, market: i.market, direction: i.direction, summary: i.summary,
          published_at: i.created_at, expires_at: i.expires_at, expired: i.status !== "live",
          expiry: { expires_at: i.expires_at, evaluation_deadline: i.evaluation_deadline, date: i.expires_at.slice(0, 10), time: i.expires_at.slice(11, 19), time_given: true, set_by: "creator" as const, reason: null },
          message_count: 2, creator: MOCK_ACCOUNT(i.creator), payout_account: i.creator, fee_per_filled_order: money(i.price),
          author_score: { accuracy: { evaluated: 0, met: 0, accuracy_pct: null, pending: 1, not_judged: 0 }, borrowers: { trades: 0, net_return_pct: 0, net_profit_usd: 0, max_drawdown_pct: 0, costs: "" } },
          unlock: subscriptionStatus().terms, content_hash: i.version_hash, mint: { ledger: "mock", tx: "mocktx" }, created_at: i.created_at,
          conditions: { market: i.market, direction: i.direction, entry: "A 15-minute candle closes back below the prior session high.", invalidation: "A 1-hour close above the sweep high.", target: null },
          messages: [{ role: "user" as const, content: "Is the breakout real?" }, { role: "assistant" as const, content: MOCK_PRIVATE_TEXT.default }],
          integrity: { content_hash: i.version_hash, recomputed_hash: i.version_hash, matches: true },
          charge: money(0), your_reads: { count: 1, total_charged: money(0) },
        };
      }),
    proof: (tokenId) =>
      delay(() => {
        const i = find(tokenId);
        const mine = orders.filter((o) => o.token_id === tokenId);
        return {
          proof_of_thesis: {
            token_id: i.id, insight_id: i.id, version: i.version, creator: MOCK_ACCOUNT(i.creator), published_at: i.created_at, expires_at: i.expires_at,
            evaluation_deadline: i.evaluation_deadline,
            expiry: { expires_at: i.expires_at, evaluation_deadline: i.evaluation_deadline, date: i.expires_at.slice(0, 10), time: i.expires_at.slice(11, 19), time_given: true, set_by: "creator" as const, reason: null },
            content_hash: i.version_hash, preserved: true, usage_fee_per_filled_trade: money(i.price), payout_account: i.creator, mint: { ledger: "mock", tx: "mocktx" },
          },
          evaluation: { status: "pending" as const, deadline: i.evaluation_deadline, source: "simulated" },
          proofs_of_trade: mine.filter((o) => Number(o.filled_quantity) > 0).map((o) => ({
            receipt_id: o.settlement.receipt_id ?? "", thesis: { token_id: i.id, content_hash: i.version_hash }, trader: MOCK_ME, role: "borrower" as const,
            order: { id: o.id, market: o.market, side: o.side, quantity: o.quantity, authorised_at: o.created_at, status: o.status },
            fill: { at: o.updated_at, price: o.execution_events.find((e) => e.type === "fill")?.price ?? "0", quantity: o.filled_quantity, source: "simulated" },
            fee_paid: o.fee, settlement: { ledger: "mock", tx: "mocktx" }, trade: o.trade!, closing_fill: o.trade?.closing_fill ?? null, proven_at: o.updated_at,
          })),
          verified_results: { trades: mine.filter((o) => o.trade?.status === "closed").length, net_return_pct: 0, net_profit_usd: 0, max_drawdown_pct: 0, costs: "Before trading costs." },
        };
      }),
    quote: (tokenId) =>
      delay(() => {
        const i = find(tokenId);
        if (i.status !== "live") throw new ApiError("insight_expired", "expired");
        const q: Quote = { quote_id: `quote_${++counter}`, token_id: i.id, fee: money(i.price), fee_rule: "Charged once, on the first confirmed fill of the order you link to this thesis.", payout_account: i.creator, content_hash: i.version_hash, expires_at: new Date(Date.now() + 600_000).toISOString() };
        quotes.set(q.quote_id, q);
        return q;
      }),
    placeOrder: (body) =>
      delay(() => {
        const q = quotes.get(body.quote_id);
        if (!q) throw new ApiError("quote_expired", "No such quote");
        const i = find(q.token_id);
        if ((i.direction === "long" ? "buy" : "sell") !== body.side) throw new ApiError("thesis_mismatch", "direction");
        if (balance < Number(q.fee.near)) throw new ApiError("insufficient_funds", "Not enough test NEAR");
        quotes.delete(body.quote_id);
        const now = new Date().toISOString();
        const o: Order = {
          id: `ord_${++counter}`, token_id: i.id, quote_id: q.quote_id, market: i.market, side: body.side, quantity: String(body.quantity), limit_price: null,
          filled_quantity: "0", status: "open", venue: { name: "simulated", order_id: `simord_${counter}`, status_known: true },
          thesis_match: { token_id: i.id, content_hash: i.version_hash, market: i.market, direction: i.direction, opens_with: body.side, thesis_expires_at: i.expires_at, authorised_at: now, checked: ["market", "direction", "authorised_before_expiry"] },
          fee: q.fee, approval: null,
          settlement: { status: "pending", receipt_id: null, ledger: "mock", reserve: { status: "reserved", payer: MOCK_ME, payee: i.creator, reserve_tx: "mocktx", final_tx: null } },
          trade: null, closing_orders: [], execution_events: [], created_at: now, updated_at: now,
        };
        orders.unshift(o);
        return structuredClone(o);
      }),
    closeOrder: (orderId, body) =>
      delay(() => {
        const o = findOrder(orderId);
        if (!o.trade || o.trade.status === "closed") throw new ApiError("validation", "There is no open position to close.");
        const c: ClosingOrder = {
          id: `cls_${++counter}`, order_id: o.id, side: o.side === "buy" ? "sell" : "buy", quantity: body.quantity ?? o.trade.open_quantity, limit_price: null,
          filled_quantity: "0", status: "open", venue: { name: "simulated", order_id: `simord_${counter}` }, fills: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        o.closing_orders.push(c);
        return structuredClone(c);
      }),
    listOrders: () => delay(() => structuredClone(orders)),
    getOrder: (id) => delay(() => structuredClone(findOrder(id))),
    simulate: (id, action) =>
      delay(() => {
        const now = new Date().toISOString();
        const closing = orders.flatMap((o) => o.closing_orders).find((c) => c.id === id);
        if (closing) {
          const o = findOrder(closing.order_id);
          closing.filled_quantity = closing.quantity; closing.status = "filled";
          closing.fills.push({ event_id: `simevt_${++counter}`, at: now, price: "3400", quantity: closing.quantity, source: "simulated" });
          o.trade = tradeOf(o);
          return {};
        }
        const o = findOrder(id);
        if (action !== "fill") { o.status = action === "cancel" ? "cancelled" : "rejected"; return {}; }
        o.filled_quantity = o.quantity; o.status = "filled"; o.updated_at = now;
        o.execution_events.push({ id: `simevt_${++counter}`, type: "fill", quantity: o.quantity, price: "3600", source: "simulated", effect: "settled", receipt_id: `rcpt_${counter}`, received_at: now });
        o.settlement = { ...o.settlement, status: "settled", receipt_id: `rcpt_${counter}`, reserve: { ...o.settlement.reserve, status: "settled" } };
        const i = find(o.token_id);
        balance -= Number(o.fee.near); earned += Number(o.fee.near);
        receipts.unshift({ id: `rcpt_${counter}`, date: now, insight_id: i.id, market: i.market, version: i.version, order_id: o.id, fee: Number(o.fee.near), evidence: "Simulated fill (not a live venue)", tx_hash: `mocktx_${counter}`, ledger: "mock", role: i.creator === MOCK_ME ? "earned" : "paid" });
        o.trade = tradeOf(o);
        return {};
      }, false),
  },
  auth: {
    challenge: () => delay(() => ({ message: "Sign in to ConDex (mock). This proves you control this account.", nonce: "bW9jay1ub25jZS0wMDAwMDAwMDAwMDAwMDAwMDAwMDA=", recipient: "localhost", network: "testnet" as const, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }), false),
    verify: (body) =>
      delay(() => ({
        account: MOCK_ACCOUNT(body.account_id), new_account: false,
        session: { id: "sess_mock", token: `cdxs_MOCK${Math.random().toString(36).slice(2, 12)}`, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(), wallet_public_key: body.public_key, key_check: "none" },
      }), false),
    logout: () => delay(() => ({ ok: true }), false),
    me: () => delay(() => ({ account: MOCK_ACCOUNT(MOCK_ME), credential: { type: "session" as const, id: "sess_mock", scopes: ["publish", "read", "trade"], token_ids: null } }), false),
  },
  keys: {
    list: () => delay(() => mockKeys.map(toRow)),
    issue: (body) =>
      delay(() => {
        const secret = `cdx_MOCK${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 14)}`;
        const row = { id: `key_${++counter}`, prefix: secret.slice(0, 10), label: body.label ?? body.scopes.join("+"), scopes: [...body.scopes], createdAt: new Date().toISOString(), lastUsedAt: null, revoked: false, mcp: null };
        mockKeys.unshift({ ...row, secret });
        const issued: IssuedKey = {
          id: row.id, prefix: row.prefix, label: row.label, scopes: body.scopes, token_ids: body.token_ids ?? null, expires_at: null,
          revoked_at: null, last_used_at: null, created_at: row.createdAt, secret,
        };
        return issued;
      }),
    revoke: (keyId) =>
      delay(() => {
        const k = mockKeys.find((x) => x.id === keyId);
        if (!k) throw new ApiError("not_found", "No such key");
        k.revoked = true; k.mcp = null;
        return toRow(k);
      }),
    mcpTools: () => delay(() => MOCK_TOOLS, false),
    disconnectMcp: () =>
      delay(() => {
        const live = mockKeys.filter((k) => !k.revoked && (k.label === "MCP agent" || k.mcp));
        for (const k of live) { k.revoked = true; k.mcp = null; }
        return { revoked: live.length };
      }),
    simulateMcpHello: (keyId) =>
      delay(() => {
        const k = mockKeys.find((x) => x.id === keyId);
        if (!k || k.revoked) throw new ApiError("not_found", "No such key");
        const now = new Date().toISOString();
        k.mcp = { connectedAt: k.mcp?.connectedAt ?? now, lastSeenAt: now, client: "condex-mcp", tools: MOCK_TOOLS.map((t) => t.name) };
        k.lastUsedAt = now;
      }, false),
  },
  creators: {
    profile: (account) =>
      delay(() => {
        const mine = insights.filter((i) => i.creator === account);
        return {
          publisher: MOCK_ACCOUNT(account),
          score: { accuracy: { evaluated: 3, met: 2, accuracy_pct: 66.67, pending: 1, not_judged: 0 }, borrowers: { trades: 2, net_return_pct: 4.2, net_profit_usd: 310, max_drawdown_pct: 1.1, costs: "Before trading costs." } },
          stats: { insights: mine.length, reads: 7, paid_orders: receipts.length, fees_paid: money(earned), payout_accounts: [account] },
          tokens: mine.map((i) => ({
            token_id: i.id, insight_id: i.id, version: i.version, title: i.title, market: i.market, direction: i.direction, summary: i.summary, published_at: i.created_at,
            expires_at: i.expires_at, expired: i.status !== "live",
            expiry: { expires_at: i.expires_at, evaluation_deadline: i.evaluation_deadline, date: i.expires_at.slice(0, 10), time: i.expires_at.slice(11, 19), time_given: true, set_by: "creator" as const, reason: null },
            message_count: 2, creator: MOCK_ACCOUNT(account), payout_account: account, fee_per_filled_order: money(i.price),
            author_score: { accuracy: { evaluated: 0, met: 0, accuracy_pct: null, pending: 0, not_judged: 0 }, borrowers: { trades: 0, net_return_pct: 0, net_profit_usd: 0, max_drawdown_pct: 0, costs: "" } },
            unlock: subscriptionStatus().terms, content_hash: i.version_hash, mint: { ledger: "mock", tx: "mocktx" }, created_at: i.created_at,
          })),
        };
      }),
    receipts: () => delay(() => [...receipts]),
    earnings: () => delay(() => ({ earned, available: balance, reserved: 0, ledger: "mock" })),
  },
};
