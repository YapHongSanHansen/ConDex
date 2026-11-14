// @mock-remove — delete after the backend is connected
import { ApiError } from "@/lib/api/errors";
import type { Api, Borrow, Earnings, Insight, InsightDetail, KeyRow, ListInsightsParams, PendingExport, Receipt } from "@/lib/api/types";
import type { IssuedKey, McpTool, WireAccount } from "@/lib/api/wire";
import { MOCK_BORROWS, MOCK_EXPORTS, MOCK_INSIGHTS, MOCK_ME, MOCK_MY_INSIGHTS, MOCK_PRIVATE_TEXT, MOCK_RECEIPTS } from "./data";

// Mutable in-memory state so borrow/revoke/publish visibly change the UI.
const MOCK_FAIL_RATE = Number(process.env.NEXT_PUBLIC_MOCK_FAIL_RATE ?? "0");

const insights = [...MOCK_INSIGHTS];
const borrows = MOCK_BORROWS.map((b) => ({ ...b }));
const receipts = [...MOCK_RECEIPTS];
const myInsights = [...MOCK_MY_INSIGHTS];
let payoutAccount = MOCK_ME;
const exportsList = MOCK_EXPORTS.map((e) => ({ ...e }));
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
const keys = new Map<string, string>(); // borrow id -> issued key (memory only)
let counter = 100;

async function delay<T>(fn: () => T, canFail = true): Promise<T> {
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
  if (canFail && Math.random() < MOCK_FAIL_RATE) {
    throw new ApiError("server_error", "Mock failure (NEXT_PUBLIC_MOCK_FAIL_RATE)", true);
  }
  return fn();
}

const toPreview = ({ id, market, horizon, price, expires_at, version, creator, status, created_at }: InsightDetail): Insight => ({
  id, market, horizon, price, expires_at, version, creator, status, created_at,
});

const PAGE = 6;

function find(id: string): InsightDetail {
  const i = insights.find((x) => x.id === id);
  if (!i) throw new ApiError("not_found", "No such insight");
  return i;
}
function findBorrow(id: string): Borrow {
  const b = borrows.find((x) => x.id === id);
  if (!b) throw new ApiError("not_found", "No such borrow");
  return b;
}

function filterInsights(p: ListInsightsParams): InsightDetail[] {
  const now = Date.now();
  let out = insights.filter((i) => {
    if (p.market && !i.market.toLowerCase().includes(p.market.toLowerCase())) return false;
    if (p.horizon && i.horizon !== p.horizon) return false;
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

function earnings(): Earnings {
  const sum = (s: Receipt["status"]) => receipts.filter((r) => r.status === s).reduce((a, r) => a + r.fee, 0);
  return { total_earned: sum("settled"), pending: sum("pending"), released: sum("released"), payout_account: payoutAccount };
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
    getStats: () =>
      delay(() => ({
        insights_listed: insights.filter((i) => i.status === "live").length,
        borrows_today: 14 + borrows.length,
        paid_to_creators: 31.4,
      })),
  },
  borrows: {
    createBorrow: (insightId, input) =>
      delay(() => {
        const ins = find(insightId);
        if (ins.status === "revoked") throw new ApiError("insight_revoked", "revoked");
        if (input.fee_cap < ins.price) throw new ApiError("over_budget", "cap below fee");
        const id = `bor_${++counter}`;
        const borrow: Borrow = {
          id, insight_id: ins.id, market: ins.market, insight_version: ins.version, status: "active",
          fee_cap: input.fee_cap, charged: 0, created_at: new Date().toISOString(),
          expires_at: new Date(Math.min(new Date(ins.expires_at).getTime(), Date.now() + 24 * 3600 * 1000)).toISOString(),
          retrieved_at: null, receipt_id: null,
        };
        borrows.unshift(borrow);
        const api_key = `cdx_test_MOCK${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
        keys.set(id, api_key);
        return { borrow, api_key };
      }),
    listBorrows: () => delay(() => borrows.map((b) => ({ ...b }))),
    getBorrow: (id) => delay(() => ({ ...findBorrow(id) })),
    revokeBorrow: (id) =>
      delay(() => {
        const b = findBorrow(id);
        if (b.status === "active") b.status = "revoked";
        return { ...b };
      }),
    retrieveInsight: (borrowId, apiKey) =>
      delay(() => {
        const b = findBorrow(borrowId);
        const issued = keys.get(borrowId);
        // Seeded borrows have no issued key; accept any non-empty key for the demo.
        if (issued && issued !== apiKey) throw new ApiError("key_invalid", "bad key");
        if (!apiKey) throw new ApiError("key_invalid", "no key");
        if (b.status === "revoked") throw new ApiError("insight_revoked", "revoked");
        if (b.status === "expired" || new Date(b.expires_at).getTime() < Date.now()) throw new ApiError("key_expired", "expired");
        const repeat = b.status !== "active";
        if (!repeat) {
          b.status = "retrieved";
          b.retrieved_at = new Date().toISOString();
        }
        // Retrieval never charges. The fee is charged when a trade is reported.
        return { borrow_id: borrowId, text: MOCK_PRIVATE_TEXT.default, repeat, charged_now: 0 };
      }),
    reportTrade: (borrowId, apiKey) =>
      delay(() => {
        const b = findBorrow(borrowId);
        const issued = keys.get(borrowId);
        if (!apiKey || (issued && issued !== apiKey)) throw new ApiError("key_invalid", "bad key");
        if (b.status === "revoked") throw new ApiError("insight_revoked", "revoked");
        if (b.status === "expired") throw new ApiError("key_expired", "expired");
        if (b.status === "traded") return { borrow: { ...b }, charged: false };
        if (b.status === "active") throw new ApiError("validation", "Retrieve the context before reporting a trade");
        const ins = find(b.insight_id);
        b.status = "traded";
        b.charged = Math.min(ins.price, b.fee_cap);
        b.receipt_id = `rcp_${++counter}`;
        receipts.unshift({
          id: b.receipt_id, date: new Date().toISOString(), insight_id: ins.id, market: ins.market, version: ins.version,
          borrower: "demo-agent-1.testnet", fee: b.charged, status: "settled", tx_hash: `MOCKTX${counter}NOTAREALTRANSACTION`,
        });
        return { borrow: { ...b }, charged: true };
      }),
    simulateExpiry: (id) =>
      delay(() => {
        const b = findBorrow(id);
        if (b.status === "active") {
          b.status = "expired";
          b.expires_at = new Date().toISOString();
        }
        return { ...b };
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
    getEarnings: () => delay(earnings),
    listReceipts: () => delay(() => [...receipts]),
    listMyInsights: () => delay(() => [...myInsights]),
    listExports: () =>
      delay(() => exportsList.map((e) => ({ ...e }))),
    simulateExport: () =>
      delay(() => {
        const n = ++counter;
        const e: PendingExport = { id: `exp_${n}`, exported_at: new Date().toISOString(), suggested_market: "ETH/USDT", suggested_horizon: "days", message_count: 9, includes_pnl: false, version_hash: `MOCKHASH${n}FAKEFAKEFAKEFAKEFAKEFAKE`, suggested_expires_at: null };
        exportsList.unshift(e);
        return { ...e };
      }, false),
    publishExport: (input) =>
      delay(() => {
        const idx = exportsList.findIndex((e) => e.id === input.export_id);
        if (idx < 0) throw new ApiError("not_found", "No such export");
        const ex = exportsList[idx];
        const prev = ex.previous_insight_id ? find(ex.previous_insight_id) : null;
        const n = ++counter;
        const detail: InsightDetail = {
          id: `ins_${n}`, market: input.market, horizon: input.horizon, price: input.fee,
          // With no expiry given, ConDex sets one. The backend uses the end of the day seven days out (UTC).
          expires_at: input.expires_at ?? new Date(`${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)}T23:59:59Z`).toISOString(),
          version: prev ? prev.version + 1 : 1, creator: MOCK_ME, status: "live", created_at: new Date().toISOString(),
          version_hash: ex.version_hash, register_tx_hash: input.register_tx_hash,
          versions: [{ version: 1, version_hash: ex.version_hash, created_at: new Date().toISOString() }],
        };
        insights.unshift(detail);
        myInsights.unshift({ id: detail.id, market: detail.market, version: detail.version, status: "live", borrows: 0, retrievals: 0, earned: 0 });
        exportsList.splice(idx, 1);
        return { insight: detail };
      }),
    updatePayoutAccount: (account) =>
      delay(() => {
        payoutAccount = account;
        return earnings();
      }),
  },
};
