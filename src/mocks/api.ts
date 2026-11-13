// @mock-remove — delete after the backend is connected
import { ApiError } from "@/lib/api/errors";
import type { Api, Borrow, CreatorKeyInfo, Earnings, Insight, InsightDetail, ListInsightsParams, PendingExport, Receipt } from "@/lib/api/types";
import { MOCK_BORROWS, MOCK_EXPORTS, MOCK_INSIGHTS, MOCK_ME, MOCK_MY_INSIGHTS, MOCK_PRIVATE_TEXT, MOCK_RECEIPTS } from "./data";

// Mutable in-memory state so borrow/revoke/publish visibly change the UI.
const MOCK_FAIL_RATE = Number(process.env.NEXT_PUBLIC_MOCK_FAIL_RATE ?? "0");

const insights = [...MOCK_INSIGHTS];
const borrows = MOCK_BORROWS.map((b) => ({ ...b }));
const receipts = [...MOCK_RECEIPTS];
const myInsights = [...MOCK_MY_INSIGHTS];
let payoutAccount = MOCK_ME;
const exportsList = MOCK_EXPORTS.map((e) => ({ ...e }));
let creatorKey: CreatorKeyInfo = { has_key: false, key_prefix: null, created_at: null, mcp_connected: false, mcp_last_seen: null };
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
  creators: {
    getEarnings: () => delay(earnings),
    listReceipts: () => delay(() => [...receipts]),
    listMyInsights: () => delay(() => [...myInsights]),
    getCreatorKey: () => delay(() => ({ ...creatorKey })),
    createCreatorKey: () =>
      delay(() => {
        const api_key = `cdx_creator_MOCK${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
        creatorKey = { has_key: true, key_prefix: api_key.slice(0, 18), created_at: new Date().toISOString(), mcp_connected: false, mcp_last_seen: null };
        return { info: { ...creatorKey }, api_key };
      }),
    listExports: () =>
      delay(() => {
        // The mock treats the first exported context as proof the MCP server connected.
        if (exportsList.length && creatorKey.has_key) creatorKey = { ...creatorKey, mcp_connected: true, mcp_last_seen: new Date().toISOString() };
        return exportsList.map((e) => ({ ...e }));
      }),
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
          id: `ins_${n}`, market: input.market, horizon: input.horizon, price: input.fee, expires_at: input.expires_at,
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
