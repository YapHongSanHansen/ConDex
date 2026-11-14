// @mock-remove — delete after the backend is connected
import type { InsightDetail } from "@/lib/api/types";

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
  evaluation_deadline: iso((expiresH + 24) * H),
  title: `${market} thesis`,
  direction: i % 2 === 0 ? "short" : "long",
  summary: "Fictional example, not a real trade call.",
  accuracy_pct: i % 3 === 0 ? null : 60 + i,
  judged: i % 3 === 0 ? 0 : 5,
  version,
  creator,
  status,
  created_at: iso(-ageH * H),
  version_hash: fakeHash(i + 1),
  register_tx_hash: fakeTx(i + 1),
  versions: Array.from({ length: version }, (_, v) => ({
    id: `${id}-v${v + 1}`,
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

