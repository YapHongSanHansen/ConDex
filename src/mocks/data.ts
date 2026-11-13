// @mock-remove — delete after the backend is connected
import type { Borrow, InsightDetail, MyInsight, PendingExport, Receipt } from "@/lib/api/types";

export const MOCK_ME = "demo-user.testnet";
export const MOCK_DISCLAIMER = "Fictional example, not a real trade call";

const H = 3600 * 1000;
const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const fakeHash = (n: number) => `MOCKHASH${String(n).padStart(4, "0")}FAKEFAKEFAKEFAKEFAKEFAKE`;
const fakeTx = (n: number) => `MOCKTX${String(n).padStart(4, "0")}NOTAREALTRANSACTION`;

type Seed = [id: string, market: string, horizon: InsightDetail["horizon"], price: number, expiresH: number, version: number, creator: string, status: InsightDetail["status"], ageH: number];

const seeds: Seed[] = [
  ["ins_001", "ETH/USDT", "intraday", 0.5, 14, 3, MOCK_ME, "live", 6],
  ["ins_002", "BTC/USDT", "days", 1.2, 72, 1, "demo-creator-a.testnet", "live", 20],
  ["ins_003", "NEAR/USDT", "weeks", 0.25, 240, 2, "demo-creator-b.testnet", "live", 50],
  ["ins_004", "SOL/USDT", "intraday", 0.4, 5, 1, "demo-creator-c.testnet", "live", 30],
  ["ins_005", "EUR/USD", "days", 0.8, 96, 4, "demo-creator-a.testnet", "live", 70],
  ["ins_006", "XAU/USD", "weeks", 2, 400, 1, "demo-creator-d.testnet", "live", 100],
  ["ins_007", "WTI Crude", "days", 0.6, 120, 2, MOCK_ME, "live", 9],
  ["ins_008", "S&P 500 futures", "intraday", 1.5, 9, 5, "demo-creator-e.testnet", "live", 3],
  ["ins_009", "ARB/USDT", "days", 0.3, 48, 1, "demo-creator-b.testnet", "revoked", 120],
  ["ins_010", "DXY index", "weeks", 0.9, -10, 2, MOCK_ME, "expired", 300],
];

export const MOCK_INSIGHTS: InsightDetail[] = seeds.map(([id, market, horizon, price, expiresH, version, creator, status, ageH], i) => ({
  id,
  market,
  horizon,
  price,
  expires_at: iso(expiresH * H),
  version,
  creator,
  status,
  created_at: iso(-ageH * H),
  version_hash: fakeHash(i + 1),
  register_tx_hash: fakeTx(i + 1),
  versions: Array.from({ length: version }, (_, v) => ({
    version: v + 1,
    version_hash: fakeHash((i + 1) * 10 + v),
    created_at: iso(-(ageH + (version - v) * 20) * H),
  })),
}));

export const MOCK_PRIVATE_TEXT: Record<string, string> = {
  default:
    `${MOCK_DISCLAIMER}.\n\nRationale: the move above the prior session high looks like a liquidity sweep, not demand.\n` +
    "Trigger: a push above the prior high followed by a 15-minute close back below it.\n" +
    "Invalidation: a 15-minute close above the prior high that holds for two candles.\n\n" +
    "This text is invented sample content for the demo.",
};

export const MOCK_BORROWS: Borrow[] = [
  { id: "bor_001", insight_id: "ins_001", market: "ETH/USDT", insight_version: 3, status: "active", fee_cap: 0.5, charged: 0, created_at: iso(-1 * H), expires_at: iso(6 * H), retrieved_at: null, receipt_id: null },
  { id: "bor_002", insight_id: "ins_002", market: "BTC/USDT", insight_version: 1, status: "traded", fee_cap: 1.5, charged: 1.2, created_at: iso(-30 * H), expires_at: iso(40 * H), retrieved_at: iso(-28 * H), receipt_id: "rcp_001" },
  { id: "bor_003", insight_id: "ins_004", market: "SOL/USDT", insight_version: 1, status: "retrieved", fee_cap: 0.4, charged: 0, created_at: iso(-2 * H), expires_at: iso(4 * H), retrieved_at: iso(-1 * H), receipt_id: null },
  { id: "bor_004", insight_id: "ins_005", market: "EUR/USD", insight_version: 4, status: "expired", fee_cap: 0.8, charged: 0, created_at: iso(-80 * H), expires_at: iso(-20 * H), retrieved_at: null, receipt_id: null },
  { id: "bor_005", insight_id: "ins_009", market: "ARB/USDT", insight_version: 1, status: "revoked", fee_cap: 0.3, charged: 0, created_at: iso(-100 * H), expires_at: iso(-10 * H), retrieved_at: null, receipt_id: null },
  { id: "bor_006", insight_id: "ins_003", market: "NEAR/USDT", insight_version: 2, status: "traded", fee_cap: 0.3, charged: 0.25, created_at: iso(-45 * H), expires_at: iso(150 * H), retrieved_at: iso(-44 * H), receipt_id: "rcp_002" },
];

export const MOCK_RECEIPTS: Receipt[] = [
  { id: "rcp_001", date: iso(-28 * H), insight_id: "ins_001", market: "ETH/USDT", version: 3, borrower: "demo-agent-1.testnet", fee: 0.5, status: "settled", tx_hash: fakeTx(101) },
  { id: "rcp_002", date: iso(-44 * H), insight_id: "ins_007", market: "WTI Crude", version: 2, borrower: "demo-agent-2.testnet", fee: 0.6, status: "settled", tx_hash: fakeTx(102) },
  { id: "rcp_003", date: iso(-60 * H), insight_id: "ins_001", market: "ETH/USDT", version: 2, borrower: "demo-agent-3.testnet", fee: 0.5, status: "settled", tx_hash: fakeTx(103) },
  { id: "rcp_004", date: iso(-3 * H), insight_id: "ins_007", market: "WTI Crude", version: 2, borrower: "demo-agent-4.testnet", fee: 0.6, status: "pending", tx_hash: fakeTx(104) },
  { id: "rcp_005", date: iso(-90 * H), insight_id: "ins_010", market: "DXY index", version: 2, borrower: "demo-agent-1.testnet", fee: 0.9, status: "released", tx_hash: fakeTx(105) },
  { id: "rcp_006", date: iso(-120 * H), insight_id: "ins_010", market: "DXY index", version: 1, borrower: "demo-agent-5.testnet", fee: 0.9, status: "settled", tx_hash: fakeTx(106) },
];

export const MOCK_MY_INSIGHTS: MyInsight[] = [
  { id: "ins_001", market: "ETH/USDT", version: 3, status: "live", borrows: 5, retrievals: 2, earned: 1.0 },
  { id: "ins_007", market: "WTI Crude", version: 2, status: "live", borrows: 3, retrievals: 1, earned: 0.6 },
  { id: "ins_010", market: "DXY index", version: 2, status: "expired", borrows: 2, retrievals: 1, earned: 0.9 },
];

export const MOCK_EXPORTS: PendingExport[] = [
  { id: "exp_001", exported_at: iso(-0.5 * H), suggested_market: "BTC/USDT", suggested_horizon: "intraday", message_count: 14, includes_pnl: true, version_hash: fakeHash(901), suggested_expires_at: iso(12 * H) },
];
