// Converts what the backend sends (`wire.ts`) into the shapes the pages already use (`types.ts`).
// Keeping this in one place means a backend change touches this file, not every page.

import type { Horizon, Insight, InsightDetail, InsightVersion, KeyRow, Receipt, Stats } from "./types";
import type { McpState, PlatformStats, TokenPreview, WireKey, WireReceipt } from "./wire";

const HOUR = 3_600_000;

/** The backend has no "time horizon". It is worked out from how long the thesis runs. */
export function horizonOf(t: Pick<TokenPreview, "published_at" | "expires_at">): Horizon {
  const span = new Date(t.expires_at).getTime() - new Date(t.published_at).getTime();
  return span <= 36 * HOUR ? "intraday" : span <= 10 * 24 * HOUR ? "days" : "weeks";
}

/** One thesis version as a gallery entry. The id is the token id, so each version has its own page. */
export function tokenToInsight(t: TokenPreview): Insight {
  return {
    id: t.token_id,
    market: t.market,
    horizon: horizonOf(t),
    price: Number(t.fee_per_filled_order.near),
    expires_at: t.expires_at,
    evaluation_deadline: t.expiry.evaluation_deadline,
    version: t.version,
    creator: t.creator.near_account_id,
    status: t.expired ? "expired" : "live",
    created_at: t.published_at,
    direction: t.direction,
    title: t.title,
  };
}

/** The gallery shows the newest version of each thesis. Older versions stay reachable from its page. */
export function latestVersions(tokens: TokenPreview[]): TokenPreview[] {
  const best = new Map<string, TokenPreview>();
  for (const t of tokens) {
    const seen = best.get(t.insight_id);
    if (!seen || t.version > seen.version) best.set(t.insight_id, t);
  }
  return [...best.values()];
}

export function tokenToDetail(t: TokenPreview, siblings: TokenPreview[]): InsightDetail {
  const versions: InsightVersion[] = siblings
    .filter((s) => s.insight_id === t.insight_id)
    .sort((a, b) => a.version - b.version)
    .map((s) => ({ id: s.token_id, version: s.version, version_hash: s.content_hash, created_at: s.published_at }));
  const acc = t.author_score.accuracy;
  return {
    ...tokenToInsight(t), version_hash: t.content_hash, register_tx_hash: t.mint.tx, versions, summary: t.summary,
    accuracy_pct: acc.accuracy_pct, judged: acc.evaluated,
  };
}

/** GET /v1/stats. */
export function toStats(p: PlatformStats): Stats {
  return { insights_listed: p.insights_live, trades_today: p.trades_linked_24h, paid_to_creators: Number(p.fees_paid_to_creators.near) };
}

/** A receipt with the market and version of its thesis, which the receipt itself does not carry. */
export function toReceipt(r: WireReceipt, token: TokenPreview | undefined, myAccountId: string): Receipt {
  return {
    id: r.id, date: r.created_at, insight_id: r.token_id, market: token?.market ?? "unknown market", version: token?.version ?? 0,
    order_id: r.order_id, fee: Number(r.fee.near), evidence: r.evidence_label, tx_hash: r.settlement.tx, ledger: r.settlement.ledger,
    role: r.creator_id === myAccountId ? "earned" : "paid",
  };
}

export function toKeyRow(k: WireKey & { mcp?: McpState | null }): KeyRow {
  return {
    id: k.id, prefix: k.prefix, label: k.label, scopes: k.scopes, createdAt: k.created_at,
    lastUsedAt: k.last_used_at, revoked: !!k.revoked_at, mcp: k.mcp ?? null,
  };
}
