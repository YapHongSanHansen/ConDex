// Where the app sends API calls. "/backend" is a path on this site that Next forwards to the backend (see next.config.ts),
// so the browser needs no CORS. A full URL also works if the backend allows this site's origin.
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
// The backend address an agent (Claude Code's MCP server) uses. It runs on the user's machine, so this is a real URL, never the proxy path.
export const MCP_API_URL = process.env.NEXT_PUBLIC_MCP_API_URL ?? "http://localhost:8787";
// Where the backend's MCP server file is on the creator's machine. The Connect page lets them change it, so this is only the starting text.
export const MCP_SERVER_PATH = process.env.NEXT_PUBLIC_MCP_SERVER_PATH ?? "/path/to/ConDex/src/mcp/server.ts";
export const NEAR_NETWORK = "testnet" as const; // testnet-only by design
export const EXPLORER_TX_URL =
  process.env.NEXT_PUBLIC_EXPLORER_TX_URL ?? "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT_URL = "https://testnet.nearblocks.io/address/";

// Development only: pretend this NEAR account is connected, and sign ConDex's challenge with a key made in the browser.
// Never set in production. It is ignored there even if set.
export const DEV_WALLET = process.env.NODE_ENV === "production" ? "" : (process.env.NEXT_PUBLIC_DEV_WALLET ?? "");
