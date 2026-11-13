# ConDex

Borrow trading insights from AI conversations. Pay the creator when your agent uses one.

A trader can spend an hour with an AI working out when to enter a position and when to walk away. ConDex lets the trader publish that reasoning as a versioned insight on NEAR. Another agent can borrow it through a scoped API key. Borrowing is free. The creator earns the agreed fee on the first successful retrieval under that borrow.

> **Build status** — Project design for the NEAR Hackathon. This repository contains this README and the frontend in `src/`. The API and NEAR testnet contract described below are planned; the frontend runs on mock data until they exist.

---

## The problem

1. **The trade call loses the condition.** “Short ETH” and “short ETH if it breaks yesterday’s high and closes back below it” lead to different trades. In a conversation, the trigger, the reasoning, and the reason to walk away can sit several messages apart.
2. **Sharing the whole chat reveals too much.** A creator may want to share a market observation while keeping their positions, wallet details, and unrelated messages private.
3. **An agent often needs to wait before research becomes useful.** A setup can expire without ever triggering. An upfront purchase makes the borrower pay even when it only wanted to watch for a trade. The creator, meanwhile, needs a reliable record of the use that earned a fee.

## The idea

The creator selects the relevant messages and approves an insight with a market, rationale, trigger, invalidation condition, and expiry. A NEAR token identifies that published version and links it to the creator’s payout account. The creator keeps the token. An agent borrows time-limited access to the insight under published terms.

Each borrow comes with an API key scoped to one insight version, a billing rule, an expiry, and a fee cap approved by the borrower. The public preview shows the market, time horizon, and price so the agent can decide whether to borrow. The private instructions stay behind the API.

## How it works

### One borrowed insight, from chat to receipt

1. **Publish.** A creator selects an exchange about a failed ETH breakout. The excerpt explains why a move above the previous UTC day’s high followed by a 15-minute close back below it would matter. The creator sets an expiry and a flat retrieval fee.
2. **Borrow.** A research agent reads the public preview and requests a key for that version. The borrower approves a fee cap. ConDex reserves the agreed fee and issues the key.
3. **Retrieve or let expire.** The agent can fetch the excerpt for its own analysis. If the key expires unused, ConDex releases the reserve and the borrower pays nothing.
4. **Settle.** On the first successful retrieval, ConDex records a receipt for the borrow and insight version. The NEAR contract uses that receipt to settle the creator’s fee once.

### What the API key authorizes

In the proposed API, a research agent uses its key as a bearer credential to retrieve the approved excerpt:

```http
GET /v1/borrows/{borrow_id}/insight
Authorization: Bearer <borrow-api-key>
```

The gateway checks the key’s scope, expiry, and budget before releasing the approved text. If the connection drops, the agent can fetch the same delivery again under the same valid borrow without a second fee. Revoking the key stops new requests.

## Where NEAR fits

| Component | Planned responsibility |
| --- | --- |
| Creator interface and private storage | Import the chat, let the creator edit and redact the excerpt, and store the approved research privately. |
| NEAR contract | Register the creator, version hash, and payout terms. Reserve the borrower’s fee budget and settle each usage receipt once. |
| ConDex API | Issue scoped keys, deliver excerpts, and report successful retrievals to the NEAR contract. The prototype would trust the API to report deliveries accurately. |

## Can users long or short an insight?

A proposed ConDex market would let users take either side of a question such as “Will this insight earn at least 20 credits in settled usage fees by Friday?” The high-demand side wins at 20 credits or more. The low-demand side wins below 20. Borrowing a free API key contributes zero to that total.

The planned first demo focuses on borrowing and settlement. A later test-credit market would need participants willing to fund both sides and rules for which fees qualify, including how it handles self-use.

## Build status

- [ ] Publish a redacted insight and register its version on NEAR testnet.
- [ ] Issue an expiring API key with a borrower-approved fee cap.
- [ ] Demonstrate an information retrieval and a retry with one charge.
- [ ] Demonstrate an expired borrow with zero charges.
- [ ] Show the usage receipt and its corresponding creator payout on NEAR testnet.

---

## Frontend

### Design note: the frontend follows the product diagram, not the older README prose
The sections above describe pay-on-first-retrieval and a creator-side chat upload. The frontend instead follows the later flow diagram: wallet → creator API key → Claude Code connected through an MCP server, so **private context is never uploaded**; the creator exports a context with an expiry (optionally including their own PNL, kept private); another agent borrows it; and **the creator is paid when the borrowing agent reports the trade executed**. That report is self-reported and trusted. The README prose above should be aligned by the team.

### What it is
Next.js (App Router, React 19) + TypeScript + Tailwind v4 app with six pages: Home `/`, Gallery `/gallery`, Insight detail `/gallery/[id]`, Connect your API `/keys`, Payouts `/payouts`, Publish `/publish`. Testnet only. No backend required: it runs on mock data.

### Run
1. `npm install`
2. `cp .env.example .env.local` (mocks are on by default)
3. `npm run dev` and open http://localhost:3000. Expect a "Demo mode" banner and MOCK badges on all data.
4. `npm run build` to check a production build; `npm run typecheck` for types.
5. Browsing needs no wallet. Borrowing, publishing and wallet menus need a NEAR **testnet** wallet via the "Connect testnet wallet" button.

### Environment variables
| Name | Purpose |
| --- | --- |
| `NEXT_PUBLIC_USE_MOCKS` | `true` uses `src/mocks/`, `false` calls the real API |
| `NEXT_PUBLIC_API_BASE_URL` | Backend base URL (default `http://localhost:8000`) |
| `NEXT_PUBLIC_MOCK_FAIL_RATE` | 0 to 1, chance a mock call fails (tests error states) |
| `NEXT_PUBLIC_NEAR_NETWORK` | `testnet` (the app is testnet-only regardless) |
| `NEXT_PUBLIC_CONTRACT_ID` | Deployed contract. Empty: mock mode fakes the transaction; real mode shows "contract not set up" |
| `NEXT_PUBLIC_EXPLORER_TX_URL` | Explorer tx prefix. VERIFY before relying on it |

### Folder map
- `src/app/` routes
- `src/components/{layout,home,gallery,keys,payouts,publish,ui}/` UI by page, `ui/` holds hand-written shadcn-style primitives on Radix
- `src/lib/api/` typed client: `types.ts` is the contract; `client.ts`, `insights.ts`, `borrows.ts`, `creators.ts`; `index.ts` picks real or mock
- `src/lib/near/` `connector.tsx` (wallet context and `useWallet()`), `contract.ts` (proposed contract calls)
- `src/mocks/` all mock data and logic, each file starts with `// @mock-remove`
- `docs/API_CONTRACT.md`, `docs/BACKEND_CONNECTION.md`
- `scripts/check-mocks.mjs` run with `npm run check:mocks`

### Switch from mocks to the backend
Follow `docs/BACKEND_CONNECTION.md`. Short version: set env vars, `npm run check:mocks`, delete `src/mocks/`, remove `@mock-remove-start/end` blocks, confirm MOCK badges are gone, test each page.

### Known limitations
- Only `GET /v1/borrows/{borrow_id}/insight` is defined by this README; every other endpoint, the contract methods and the `condex-mcp` package/command are proposals. No MCP server exists in this repo.
- Retrieval from a creator's local MCP is not designed yet (relay? offline?). See `docs/API_CONTRACT.md`.
- Publish steps 2 to 4 were not exercised in a browser because they need a connected testnet wallet.
- Auth is not implemented: `TODO(backend): auth scheme` in `src/lib/api/client.ts`. The wallet account id is sent as a plain header.
- Mock data is for one fixed demo identity; it does not follow the connected wallet.
- Leaving `/publish` warns on tab close or reload only, not on in-app link clicks.
- Theme toggle (sun/moon in the nav) is remembered in localStorage; dark is the default.
- "Includes PNL" is only a private flag on an export. Nothing in the UI displays or claims performance.
- Borrowing needs a connected wallet even in demo mode.
- Settlement trusts the API to report deliveries; nothing is verified trustlessly.
- The long/short insight market is not built.
- Not tested: a real wallet transaction on testnet, since no contract exists.

### Disclosures
- Libraries: next, react, @tanstack/react-query, @hot-labs/near-connect, near-api-js, Radix UI (dialog, tabs, tooltip, dropdown-menu, accordion, slider, slot), sonner, lucide-react, class-variance-authority, clsx, tailwind-merge. `@near-wallet-selector/*` is not used.
- 21st.dev components: none used. The primitives are written by hand.
- Wallet account id: `accounts[0].accountId` on the `wallet:signIn` event, as documented in the installed `@hot-labs/near-connect` README.
- ASCII art is original. The visual direction is only a style reference.
- This frontend was built with AI assistance (Claude Code).
- Insights are reasoning, not financial advice. No performance is implied.
