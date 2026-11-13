export const USE_MOCKS = process.env.NEXT_PUBLIC_USE_MOCKS === "true";
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
export const NEAR_NETWORK = "testnet" as const; // testnet-only by design
export const CONTRACT_ID = process.env.NEXT_PUBLIC_CONTRACT_ID ?? "";
export const EXPLORER_TX_URL =
  process.env.NEXT_PUBLIC_EXPLORER_TX_URL ?? "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT_URL = "https://testnet.nearblocks.io/address/";
