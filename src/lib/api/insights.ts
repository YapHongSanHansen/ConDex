import { latestVersions, statsFromTokens, tokenToDetail, tokenToInsight } from "./adapters";
import { request } from "./client";
import type { Insight, InsightsApi, ListInsightsParams } from "./types";
import type { TokenPreview } from "./wire";

const PAGE = 6;
const DAY = 86_400_000;

async function allTokens(): Promise<TokenPreview[]> {
  return (await request<{ tokens: TokenPreview[] }>("/v1/tokens")).tokens;
}

/** The backend lists every thesis version and filters nothing but the creator and the exact market. So the gallery's filters, sorting and paging happen here. */
function filter(items: Insight[], p: ListInsightsParams): Insight[] {
  const now = Date.now();
  const out = items.filter((i) => {
    if (p.market && !i.market.toLowerCase().includes(p.market.toLowerCase())) return false;
    if (p.horizon && i.horizon !== p.horizon) return false;
    if (p.max_price !== undefined && i.price > Number(p.max_price)) return false;
    const left = new Date(i.expires_at).getTime() - now;
    if (p.expiry === "soon" && !(left > 0 && left < DAY)) return false;
    if (p.expiry === "later" && left < DAY) return false;
    return true;
  });
  return out.sort((a, b) => {
    if (p.sort === "cheapest") return a.price - b.price;
    if (p.sort === "expiring") return new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime();
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export const insightsApi: InsightsApi = {
  listInsights: async (params) => {
    const all = filter(latestVersions(await allTokens()).map(tokenToInsight), params);
    const start = params.cursor ? Number(params.cursor) : 0;
    return { items: all.slice(start, start + PAGE), next_cursor: start + PAGE < all.length ? String(start + PAGE) : null, total: all.length };
  },
  getInsight: async (id) => {
    const preview = await request<TokenPreview>(`/v1/tokens/${encodeURIComponent(id)}/preview`);
    return tokenToDetail(preview, await allTokens());
  },
  getStats: async () => statsFromTokens(await allTokens()),
};
