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
| Keys & orders: Your orders (`/keys?tab=orders`) | `trading.listOrders / closeOrder` | `GET /v1/orders`, `POST /v1/orders/:id/close` | Order detail with a timeline, the trade and its result, and a form to close (all or part). Closing is free and allowed after the expiry. |
| Payouts | `creators.earnings / receipts / profile` | `GET /v1/ledger/balances/:account`, `GET /v1/receipts` (+ `/v1/tokens`, `/v1/me`), `GET /v1/publishers/:account` | Fees earned, balance, the creator's accuracy and the traders' results, receipts (role earned or paid) and "My theses". The payout account is set per thesis when publishing, so it is shown, not edited. |
| Publish | `creators.profile` (polled) | `GET /v1/publishers/:account` | The backend has no drafts and the conversation lives with the creator's agent, so this page defines the thesis (market, direction, entry, invalidation, target, expiry, evaluation deadline, fee), writes the prompt for Claude Code, then waits for the new token to appear. |
| Sign-in | `auth.challenge / verify / logout / me` | `POST /v1/auth/challenge`, `/verify`, `/logout`, `GET /v1/me` | NEP-413. The session (`cdxs_…`) is kept for the tab in `sessionStorage` and sent as `Authorization: Bearer`. |
| Keys & orders: keys (`/keys?tab=keys`) | `keys.list / issue / revoke` | `GET/POST /v1/keys`, `DELETE /v1/keys/:id` | Scopes: `publish`, `read`, `trade`. The secret (`cdx_…`) is returned once. |
| Keys & orders: MCP | `keys.mcpTools / disconnectMcp` | `GET /v1/mcp/tools`, `POST /v1/mcp/disconnect` | "MCP connected" is true only when a real MCP process said hello with a key. |

### Things that behave differently from what you might expect

- **Fills come from the execution route.** The backend's `/v1/sim/*` routes refuse any request that comes through a proxy or from another website, on purpose. So the website's "Simulate a fill" buttons exist only in mock mode. With the real backend on your own machine, the order panel and the order drawer link to the backend's test console (`/test`), which can fill, cancel or reject an order. That link is shown only when `NEXT_PUBLIC_DEV_WALLET` is set.
- **Two ledgers.** `GET /health` says which one the backend runs. On the **mock ledger** the backend moves test NEAR itself (Add test NEAR, Subscribe). On the **NEAR ledger** (`CONDEX_LEDGER=near`) the trader signs from their wallet, and the page does that:
  - **Add funds:** `deposit()` on the contract with the amount attached.
  - **Subscribe:** `subscribe()` with the price attached. The page then waits until the backend reads the subscription from the contract.
  - **Order:** the order is first `awaiting_approval`. The page signs `reserve_fee` with exactly the arguments the backend put in `approval` (no deposit: the fee comes from the balance), then calls `POST /v1/orders/:id/confirm-approval`, retrying while the transaction becomes final. If the wallet is closed, an "Approve the fee in your wallet" button asks again, in the panel and in the order drawer.
- **Receipts have no market.** They are joined with the token list to name the thesis.

### How the NEAR path was checked

With a stand-in wallet that records each transaction it is asked to sign, and the backend's `/health`, subscription, balance and order answers replaced by the shapes a NEAR-ledger backend sends, a browser run checked that the right contract, method, arguments and attached deposit were signed for subscribe, deposit and `reserve_fee`, and that `confirm-approval` was then called. It has **not** been run against the real testnet contract with a real wallet: that needs a funded testnet account and a backend started with the operator keys.

## Going to production

1. **One origin or CORS.** Either serve the site and the API under one origin (the site forwards `/backend/*`, nothing else to do), or call the API at its own URL (`NEXT_PUBLIC_API_BASE_URL=https://api.example`) and start the backend with `CONDEX_CORS_ORIGINS=https://your-site`. Any other origin gets no CORS header.
2. **Sign-in recipient.** Start the backend with `CONDEX_AUTH_RECIPIENT=<the site's host>`. The wallet signs for that name. In a production build the page refuses to sign in if the name is not the site's own, and says what to set.
3. **`callback_url`.** It is only for redirect wallets. The HOT wallet connector this site uses opens its wallet in a popup or iframe and never redirects, so the site does not send one. If a redirect wallet is added later, send the exact `callbackUrl` and list the site in `CONDEX_ALLOWED_ORIGINS`.
4. **MCP command.** The Keys page shows the backend's real two lines (`claude mcp remove condex`, then `claude mcp add condex … -- node "<path>/src/mcp/server.ts"`). The path is the creator's own, so they edit it on the page and it is kept in their browser. There is no `condex-mcp` package. If one is published later, change `mcpCommand` in `creator-setup.tsx`.

## Errors

The backend sends `{ "error": { "code", "message", "details"? } }`. `client.ts` reads that (and the older flat shape) and maps these codes to friendly text: `unauthorized`, `missing_scope` and `token_not_in_scope`, `wallet_session_required`, `quote_expired` and `quote_used`, `insight_expired`, `market_mismatch` and `direction_mismatch` and `self_link`, `insight_revoked`. Anything else is worded by its status. A 401 on a wallet session clears the stored session, so the page asks the user to sign in again.

## How it was checked

Against the real backend (seeded with four theses), in a real browser with mocks off: the home page and gallery loaded real tokens, an insight page showed its versions, the dev wallet signed in through the challenge and verify calls, a key was issued, a client saying hello made the page show "MCP connected" with 11 tools, and Disconnect revoked the key (the backend then answered 401 for it).
