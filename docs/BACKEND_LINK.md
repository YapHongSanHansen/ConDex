# Linking the frontend to the backend

This is the map between what the pages call and what the backend (`backend`) serves. It was made by running the real backend and capturing its responses, so the shapes are exact. They are typed in `src/lib/api/wire.ts`, and `src/lib/api/adapters.ts` converts them into the shapes the pages use.

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

Backend branch `backend` (latest, with `GET /v1/stats`). Every page below was run in a real browser against it with mocks off.

| Page | Frontend call | Backend route | Notes |
|---|---|---|---|
| Home | `insights.getStats` | `GET /v1/stats` | `insights_live`, `trades_linked_24h`, `fees_paid_to_creators`. |
| Gallery | `insights.listInsights` | `GET /v1/tokens` | Lists every version. The adapter keeps the newest of each thesis, then filters, sorts and pages in the browser. |
| Insight page | `insights.getInsight` | `GET /v1/tokens/:id/preview` + `GET /v1/tokens` | Versions are the other tokens with the same `insight_id`, each linking to its own page. Shows the author's accuracy. |
| Insight page: Proof | `trading.proof` | `GET /v1/tokens/:id/proof` (public) | Published, access expiry, evaluation deadline, preserved flag, the evaluation (pending or judged), verified results and every proof of trade with its result. |
| Insight page: Read | `trading.subscription / subscribe / deposit / balances / read` | `GET/POST /v1/subscription`, `POST /v1/ledger/deposit`, `GET /v1/ledger/balances/:account`, `GET /v1/tokens/:id` | A wallet session holds the `read` scope. A read without a subscription is a 402 `subscription_required`, shown as "Reading the full thesis needs a subscription". The creator reads their own thesis free. |
| Insight page: Trade | `trading.quote / placeOrder` | `POST /v1/quotes`, `POST /v1/orders` | The side is derived from the direction (a long buys, a short sells). The fee is reserved at the order and charged once on the first fill. The panel polls the order every 3 s. |
| Connect page: Your orders | `trading.listOrders / closeOrder` | `GET /v1/orders`, `POST /v1/orders/:id/close` | Order detail with a timeline, the trade and its result, and a form to close (all or part). Closing is free and allowed after the expiry. |
| Payouts | `creators.earnings / receipts / profile` | `GET /v1/ledger/balances/:account`, `GET /v1/receipts` (+ `/v1/tokens`, `/v1/me`), `GET /v1/publishers/:account` | Fees earned, balance, the creator's accuracy and the traders' results, receipts (role earned or paid) and "My theses". The payout account is set per thesis when publishing, so it is shown, not edited. |
| Publish | `creators.profile` (polled) | `GET /v1/publishers/:account` | The backend has no drafts and the conversation lives with the creator's agent, so this page defines the thesis (market, direction, entry, invalidation, target, expiry, evaluation deadline, fee), writes the prompt for Claude Code, then waits for the new token to appear. |
| Sign-in | `auth.challenge / verify / logout / me` | `POST /v1/auth/challenge`, `/verify`, `/logout`, `GET /v1/me` | NEP-413. The session (`cdxs_…`) is kept for the tab in `sessionStorage` and sent as `Authorization: Bearer`. |
| Connect page: keys | `keys.list / issue / revoke` | `GET/POST /v1/keys`, `DELETE /v1/keys/:id` | Scopes: `publish`, `read`, `trade`. The secret (`cdx_…`) is returned once. |
| Connect page: MCP | `keys.mcpTools / disconnectMcp` | `GET /v1/mcp/tools`, `POST /v1/mcp/disconnect` | "MCP connected" is true only when a real MCP process said hello with a key. |

### Things that behave differently from what you might expect

- **No simulated fills from the website.** The backend's `/v1/sim/*` routes refuse any request that comes through a proxy, on purpose. A real fill comes from the execution route (`POST /v1/execution/events`). In a demo, drive fills from the backend test console at `http://localhost:8787/test` or with `curl` directly. The website shows its "Simulate a fill" button only in mock mode.
- **The balance is a mock-ledger balance.** "Add test NEAR" calls `POST /v1/ledger/deposit`, which exists only on the mock ledger. On the NEAR ledger the account deposits to the contract itself and the order waits as `awaiting_approval` until the wallet signs `reserve_fee`; the panel shows that state but does not sign it yet.
- **Receipts have no market.** They are joined with the token list to name the thesis.

## Still open

1. **NEAR ledger ordering.** With `CONDEX_LEDGER=near` an order is `awaiting_approval`. The page needs a wallet call to `reserve_fee`, then `POST /v1/orders/:id/confirm-approval`. Not built.
2. **CORS.** The backend sends no CORS headers. The dev proxy hides that. For production, put the site and the API behind one origin, or add an allow-list on the backend.
3. **Auth recipient.** The backend signs challenges for `CONDEX_AUTH_RECIPIENT` (the site's domain). It must match the deployed site. Redirect wallets also need `callback_url` and the backend's `allowedOrigins`. The sign-in code does not send `callback_url` yet.
4. **MCP package.** The Connect page shows `npx -y condex-mcp` as a proposal. The backend README runs `node <path>/src/mcp/server.ts`. The environment variables are the real ones: `CONDEX_API_URL`, `CONDEX_API_KEY`.

## Errors

The backend sends `{ "error": { "code", "message", "details"? } }`. `client.ts` reads that (and the older flat shape) and maps these codes to friendly text: `unauthorized`, `missing_scope` and `token_not_in_scope`, `wallet_session_required`, `quote_expired` and `quote_used`, `insight_expired`, `market_mismatch` and `direction_mismatch` and `self_link`, `insight_revoked`. Anything else is worded by its status. A 401 on a wallet session clears the stored session, so the page asks the user to sign in again.

## How it was checked

Against the real backend (seeded with four theses), in a real browser with mocks off: the home page and gallery loaded real tokens, an insight page showed its versions, the dev wallet signed in through the challenge and verify calls, a key was issued, a client saying hello made the page show "MCP connected" with 11 tools, and Disconnect revoked the key (the backend then answered 401 for it).
