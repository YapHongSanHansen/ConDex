import { API_BASE_URL } from "@/lib/config";
import { ApiError } from "./errors";
import type { ApiErrorCode } from "./types";
import type { WireError } from "./wire";

// Auth: the wallet session token (`cdxs_...`) from the NEP-413 sign-in. It is sent as `Authorization: Bearer`
// on every call. A call may pass its own `bearer` instead, such as an agent key (`cdx_...`) on the test pages.
// It is kept for this browser tab only (sessionStorage), so a reload does not make the user sign in again but
// closing the tab does. It is never put in a URL or a cookie.
const SESSION_KEY = "condex.session";
export interface StoredSession { token: string; accountId: string; expiresAt: string }

let session: StoredSession | null = null;
let loaded = false;

function load(): StoredSession | null {
  if (loaded || typeof window === "undefined") return session;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    const s = raw ? (JSON.parse(raw) as StoredSession) : null;
    session = s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
  } catch {
    session = null;
  }
  return session;
}

/** The current wallet session, if it is still valid. */
export function getSession(): StoredSession | null {
  const s = load();
  return s && new Date(s.expiresAt).getTime() > Date.now() ? s : null;
}

export function setSession(next: StoredSession | null) {
  session = next;
  loaded = true;
  try {
    if (next) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked: the session just lasts until reload */
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Use this bearer (an agent key) instead of the wallet session. Held in memory only, never stored. */
  bearer?: string;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "validation",
  401: "unauthorized",
  402: "insufficient_funds",
  403: "key_invalid",
  404: "not_found",
  409: "validation",
  410: "key_expired",
  422: "validation",
};

/** The backend's own error codes that the app words specially. Everything else is worded by its status. */
const BACKEND_CODES: Record<string, ApiErrorCode> = {
  unauthorized: "unauthorized",
  missing_scope: "missing_scope",
  token_not_in_scope: "missing_scope",
  wallet_session_required: "session_required",
  subscription_required: "subscription_required",
  insufficient_balance: "insufficient_funds",
  quote_expired: "quote_expired",
  quote_used: "quote_expired",
  insight_expired: "insight_expired",
  market_mismatch: "thesis_mismatch",
  direction_mismatch: "thesis_mismatch",
  self_link: "thesis_mismatch",
  insight_revoked: "insight_revoked",
};

const MAX_NETWORK_RETRIES = 2;

/** `API_BASE_URL` may be a full URL or a path on this site (the dev proxy), so the URL is built against the page's own origin. */
function buildUrl(path: string, query: RequestOptions["query"]): URL {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const url = new URL(API_BASE_URL.replace(/\/$/, "") + path, origin);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  return url;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bearer = opts.bearer ?? getSession()?.token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

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
    let body: Partial<WireError> & { code?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    // The backend sends { error: { code, message } }. An older flat { code, message } is still understood.
    const backendCode = body.error?.code ?? body.code ?? "";
    const message = body.error?.message ?? body.message ?? `HTTP ${res.status}`;
    // A 401 on a wallet session means it ended, so it is dropped and the user is asked to sign in again.
    if (res.status === 401 && !opts.bearer) setSession(null);
    const code: ApiErrorCode = BACKEND_CODES[backendCode] ?? STATUS_CODES[res.status] ?? (res.status >= 500 ? "server_error" : "unknown");
    throw new ApiError(code, message, res.status >= 500);
  }
  return (await res.json()) as T;
}
