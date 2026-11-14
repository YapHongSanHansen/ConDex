// Stands in for CoinGecko's pool OHLCV endpoint, so no test reaches the network. It serves candles the way
// the real endpoint does (newest first, ending with the candle that contains `before_timestamp`, at most
// `limit` of them, minutes with no trades simply absent) and records every request it gets.

/** [start (Unix seconds), open, high, low, close, volume], as the endpoint returns them. */
export type FeedCandle = [start: number, open: number, high: number, low: number, close: number, volume: number];

export function fakeCoinGecko(candles: FeedCandle[] = []) {
  const state = {
    candles,
    calls: [] as Array<{ url: string; key: string | null; before: number; limit: number }>,
    /** Answer with this HTTP status, time out, or answer with something that is not candles. null: answer normally. */
    fail: null as null | number | "timeout" | "garbage",
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const query = new URL(url).searchParams;
    const before = Number(query.get("before_timestamp"));
    const limit = Number(query.get("limit"));
    state.calls.push({ url, key: new Headers(init?.headers).get("x-cg-demo-api-key"), before, limit });
    if (state.fail === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (state.fail === "garbage") return Response.json({ status: "ok" });
    if (typeof state.fail === "number") return new Response("{}", { status: state.fail });
    const rows = state.candles.filter((c) => c[0] <= before).sort((a, b) => b[0] - a[0]).slice(0, limit);
    return Response.json({ data: { attributes: { ohlcv_list: rows } } });
  }) as typeof fetch;
  return { fetcher, state };
}

/** One candle a minute from `fromS` up to (not including) `toS`, with no range, all at `price`. */
export function flat(fromS: number, toS: number, price: number): FeedCandle[] {
  const out: FeedCandle[] = [];
  for (let s = fromS; s < toS; s += 60) out.push([s, price, price, price, price, 1000]);
  return out;
}

/** Replaces the candle that starts at `startS`, or adds it. */
export function withCandle(candles: FeedCandle[], startS: number, open: number, high: number, low: number, close: number): FeedCandle[] {
  return [...candles.filter((c) => c[0] !== startS), [startS, open, high, low, close, 1000]];
}
