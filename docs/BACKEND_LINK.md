# Linking the frontend to the backend

This is the map between what the pages call and what the backend (`backend-mcppublish`) serves. It was made by running the real backend and capturing its responses, so the shapes are exact. They are typed in `src/lib/api/wire.ts`, and `src/lib/api/adapters.ts` converts them into the shapes the pages use.

## Try it

```bash
# backend (its own repo folder, Node 24)
npm run dev                                   # http://localhost:8787, dev mode, in-memory data

# frontend: .env.local
NEXT_PUBLIC_USE_MOCKS=false
NEXT_PUBLIC_API_BASE_URL=/backend             # Next forwards /backend/* to BACKEND_URL, so no CORS is needed
BACKEND_URL=http://localhost:8787
NEXT_PUBLIC_MCP_API_URL=http://localhost:8787 # what Claude Code's MCP server calls (a real URL, never the proxy)
NEXT_PUBLIC_DEV_WALLET=alice.testnet          # optional, dev only: a stand-in wallet, no NEAR wallet needed
npm run dev
```

`NEXT_PUBLIC_DEV_WALLET` makes the page behave as if that account is connected, and signs ConDex's challenge with a key made in the browser. The backend accepts that only in dev mode with its wallet key check off (the default in dev). It is ignored in production builds.

## What is linked and verified against the real backend

| Page | Frontend call | Backend route | Notes |
|---|---|---|---|
| Home | `insights.getStats` | `GET /v1/tokens` | Only "insights" can be worked out. "Borrows today" and "Paid out" come back `null` and show as n/a. |
| Gallery | `insights.listInsights` | `GET /v1/tokens` | Lists every version. The adapter keeps the newest of each thesis, then filters, sorts and pages in the browser. The backend filters only by creator and exact market. |
| Insight page | `insights.getInsight` | `GET /v1/tokens/:id/preview` + `GET /v1/tokens` | Versions are the other tokens with the same `insight_id`. |
| Sign-in | `auth.challenge / verify / logout / me` | `POST /v1/auth/challenge`, `/verify`, `/logout`, `GET /v1/me` | NEP-413. The wallet's `signMessage` result goes straight into `verify`. The session (`cdxs_…`) is kept for the tab in `sessionStorage` and sent as `Authorization: Bearer`. |
| Connect page | `keys.list / issue / revoke` | `GET/POST /v1/keys`, `DELETE /v1/keys/:id` | Scopes: `publish`, `read`, `trade`. The secret (`cdx_…`) is returned once. |
| Connect page | `keys.mcpTools / disconnectMcp` | `GET /v1/mcp/tools`, `POST /v1/mcp/disconnect` | "MCP connected" is true only when a real MCP process said hello with a key (`mcp` on the key). The page polls every 3 s while waiting. |

## Not linked yet (still on the old mock-era routes)

These still call routes that do not exist on the backend, so with mocks off they show "We couldn't find that". They need a product decision first (see below).

| Page | Frontend call | What the backend has instead |
|---|---|---|
| Insight page: Borrow panel; Connect page: Your borrows | `borrows.*` | No "borrow". An agent reads a thesis (free, `GET /v1/tokens/:id` with a `read` key), asks for a quote (`POST /v1/quotes`), then places an order linked to it (`POST /v1/orders`). The fee is reserved at the order and charged once on its first fill. Closing a trade: `POST /v1/orders/:id/close`. Orders: `GET /v1/orders`. |
| Payouts | `creators.getEarnings / listReceipts` | `GET /v1/receipts` (+ `GET /v1/ledger/balances/:account` for `earned`). A receipt has `token_id`, not a market, so join it with the token preview. |
| Payouts | `creators.listMyInsights` | `GET /v1/publishers/:nearAccountId` has `tokens` and `stats` (`insights`, `reads`, `paid_orders`, `fees_paid`). |
| Payouts | `creators.updatePayoutAccount` | None. The payout account is set per thesis when publishing (`payout_account`). |
| Publish | `creators.listExports / publishExport` | None. See decision 2. |

## Decisions needed before the rest can be linked

1. **Borrow versus quote-and-order.** The pages were built around "borrow, reserve a fee cap, retrieve, report a trade". The backend works differently (above). The Borrow panel on the insight page and the "Your borrows" table should become "Read" and "Trade", driven by `read` and `trade` keys. Types for quotes, orders, trades and receipts are ready in `wire.ts`.
2. **Who publishes.** The Publish page expects "pending exports" and a wallet-signed NEAR registration. The backend has neither: an agent publishes straight away with a `publish` key (`POST /v1/insights`), and the token is minted on the mock ledger. Either the Publish page becomes a guide and status page for the agent flow (the Define step already collects the fields the backend requires: market, direction, entry, invalidation, optional target and expiry), or the backend adds drafts.
3. **Backend has no `/v1/stats`.** Add it (insights, borrows or orders today, fees paid to creators) or accept n/a on the home page.
4. **CORS.** The backend sends no CORS headers. The dev proxy hides that. For production, put the site and the API behind one origin, or add an allow-list on the backend.
5. **Auth recipient.** The backend signs challenges for `CONDEX_AUTH_RECIPIENT` (the site's domain). It must match the deployed site. Redirect wallets also need `callback_url` and the backend's `allowedOrigins`. The sign-in code does not send `callback_url` yet.
6. **MCP package.** The Connect page shows `npx -y condex-mcp` as a proposal. The backend README runs `node <path>/src/mcp/server.ts`. The environment variables are the real ones: `CONDEX_API_URL`, `CONDEX_API_KEY`.

## Also ready, not yet shown on a page

- **Proofs.** `GET /v1/tokens/:id/proof` (public) returns the proof of thesis and every proof of trade, each with the trade result (entry, exit, profit, return %, outcome). Types: `ThesisProof`, `ProofOfTrade`, `Trade`, `TradeResult`. A "Proof" panel on the insight page is the natural place.
- **Expiry.** Every thesis has one. `expiry.set_by` says whether the creator, ConDex's AI or ConDex's default set it, and `expiry.reason` says why.
- **Ledger.** `GET /v1/ledger/balances/:account` and `POST /v1/ledger/deposit` (test NEAR, mock ledger).

## Errors

The backend sends `{ "error": { "code", "message", "details"? } }`. `client.ts` reads that (and the older flat shape) and maps these codes to friendly text: `unauthorized`, `missing_scope` and `token_not_in_scope`, `wallet_session_required`, `quote_expired` and `quote_used`, `insight_expired`, `market_mismatch` and `direction_mismatch` and `self_link`, `insight_revoked`. Anything else is worded by its status. A 401 on a wallet session clears the stored session, so the page asks the user to sign in again.

## How it was checked

Against the real backend (seeded with four theses), in a real browser with mocks off: the home page and gallery loaded real tokens, an insight page showed its versions, the dev wallet signed in through the challenge and verify calls, a key was issued, a client saying hello made the page show "MCP connected" with 11 tools, and Disconnect revoked the key (the backend then answered 401 for it).
