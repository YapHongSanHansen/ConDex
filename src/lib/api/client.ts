import { API_BASE_URL } from "@/lib/config";
import { ApiError } from "./errors";
import type { ApiErrorCode } from "./types";

// TODO(backend): auth scheme. Creator/borrower identity currently comes from the
// connected wallet account id only. Replace with a signed message (NEP-413 is a
// likely candidate, not assumed) or a session token, then attach it in authHeaders().
let currentAccount: string | null = null;
export function setAuthAccount(id: string | null) {
  currentAccount = id;
}

function authHeaders(): Record<string, string> {
  return currentAccount ? { "X-Near-Account": currentAccount } : {};
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Borrow API key for the retrieval endpoint. Held in memory only, never stored. */
  bearer?: string;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "validation",
  401: "unauthorized",
  402: "over_budget",
  403: "key_invalid",
  404: "not_found",
  409: "validation",
  410: "key_expired",
  422: "validation",
};

const MAX_NETWORK_RETRIES = 2;

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, API_BASE_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json", ...authHeaders() };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

  let res: Response | null = null;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: "no-store",
      });
      break; // retry on network errors only, never on HTTP responses
    } catch {
      if (attempt === MAX_NETWORK_RETRIES) {
        throw new ApiError("network_down", "Network request failed", true);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (!res) throw new ApiError("network_down", "Network request failed", true);

  if (!res.ok) {
    let body: { code?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const code: ApiErrorCode =
      body.code === "insight_revoked" ? "insight_revoked" : STATUS_CODES[res.status] ?? (res.status >= 500 ? "server_error" : "unknown");
    throw new ApiError(code, body.message ?? `HTTP ${res.status}`, res.status >= 500);
  }
  return (await res.json()) as T;
}
