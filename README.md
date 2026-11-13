# ConDex

**ConDex tokenises trading insights from conversations between traders and their AI agents.** A trader selects the messages to publish, and their agent uploads them through MCP or the ConDex API. ConDex mints a token on NEAR that identifies that version of the conversation, its creator, and the fee for using it in a trade.

Other agents can use the token ID to read the insight for free. The creator earns the agreed fee only when another trader’s order linked to that token receives a confirmed fill.

> **Build status** — NEAR Hackathon project. The off-chain services (API, MCP server, private storage, simulated execution venue) run locally against a **mock ledger** that stands in for the NEAR contract. The NEAR testnet contract and the product frontend are not built yet.

## The problem

A call like “short ETH” can leave out the most useful parts of a trader’s conversation with their AI agent: when to enter, which evidence would invalidate the idea, and when to walk away. Sharing the entire chat can expose unrelated positions and wallet details. ConDex lets the creator share selected reasoning and lets a borrower evaluate it before deciding whether to trade.

## From conversation to creator payout

1. **Publish from the creator’s agent.** The creator connects their agent to ConDex through the Model Context Protocol (MCP), or gives it a ConDex API key with publishing permission. The creator chooses which conversation or messages the agent may share. The agent then uploads the approved material and registers the insight automatically.
2. **Tokenise the insight on NEAR.** ConDex mints a token that identifies the published version and links its content hash, creator, payout account, and flat fee per filled order. The creator keeps the token. The approved conversation stays in private storage and is available through ConDex.
3. **Borrow and read for free.** Another user’s agent calls the insight by token ID using its own scoped credential. It can read the reasoning, check whether the conditions still apply, and decide to walk away. Reading, repeated calls, and expiry incur zero ConDex fees.
4. **Authorise a linked trade.** If the borrower acts on the insight, their wallet or authorised trading agent approves an order from their own account. ConDex binds the insight version and fee quote to the order before submission. The borrower sees the fee and authorises its reservation. A key that reads research cannot sign trades.
5. **Pay on confirmed execution.** ConDex checks the execution record for that exact order. Its first confirmed fill, including a partial fill, triggers one creator payout on NEAR. Later fills and retries for the same order use the same receipt. A rejected order or an order confirmed cancelled or expired with no fills releases the reserve. While the outcome is unknown, settlement stays pending.

For example, Alice publishes an ETH breakout discussion with a fee of 0.1 test NEAR per filled order. Bob’s agent reads it three times for free. If Bob cancels his linked order before any fill, he pays Alice zero. If part of that order fills before cancellation, Alice earns 0.1 test NEAR, even if Bob later closes the trade at a loss.

## How ConDex attributes a trade

The receipt links the borrower, insight version, authorised order, and confirmed fill. A trade submitted independently outside a connected execution route has no reliable link to the conversation. ConDex can collect a fee only for a trade whose link and execution it can verify.

## Where NEAR fits

| Component | Planned responsibility |
| --- | --- |
| MCP server and API | Accept authorised uploads from creators’ agents, issue scoped access, and serve conversations by token ID. |
| NEAR contract | Register versioned insight tokens and fee terms, reserve authorised fees, and settle each linked order once. |
| Execution integration | Submit or track the borrower’s authorised order and verify its fill. The prototype trusts this service to report the execution accurately. |
| Private storage | Store approved messages off-chain. Publish only the insight metadata and settlement receipt on NEAR. |

## Running the off-chain services

Requires Node.js 24 or later (it uses the built-in `node:sqlite` and runs TypeScript directly).

```sh
npm install
npm start            # API on http://localhost:8787, test console on http://localhost:8787/test
npm test             # API flow tests and MCP tests
npm run test:page    # opens the test console in headless Chrome/Edge and checks every button
npm run typecheck
```

The test console has a button for every API action and every demo checklist item. **Run every button** resets the data, clicks each one in order and reports pass or fail.

### Connecting an agent over MCP

Create an account and a scoped key (with the test console or `POST /v1/accounts` then `POST /v1/keys`), then register the server with your agent, for example in Claude Code:

```sh
claude mcp add condex --env CONDEX_API_KEY=cdx_... --env CONDEX_API_URL=http://localhost:8787 -- node --disable-warning=ExperimentalWarning /path/to/ConDex/src/mcp/server.ts
```

The MCP tools have exactly the scopes of that key: `publish`, `read` and/or `trade`.

### Layout

| Path | What it does |
| --- | --- |
| `src/api/app.ts` | HTTP routes. Request bodies are validated in `src/api/schemas.ts`. |
| `src/services/accounts.ts` | Accounts and scoped API keys (`admin`, `publish`, `read`, `trade`). Keys are stored hashed. |
| `src/services/insights.ts` | Publishing versions, content hashing, minting, public previews and free reads. |
| `src/services/orders.ts` | Fee quotes, fee reservation and order submission. |
| `src/services/settlement.ts` | Execution events → one payout on the first fill, release on no-fill endings, idempotent replays. |
| `src/ledger/` | `Ledger` interface and `MockLedger`. A NEAR testnet adapter replaces the mock. |
| `src/execution/venue.ts` | `ExecutionVenue` interface and the simulated venue. |
| `src/mcp/server.ts` | MCP server (stdio) for creators' and borrowers' agents. |
| `public/test.html` | Test console, served at `/test` when `CONDEX_DEV_MODE=true` (the default). |

Configuration: `PORT`, `CONDEX_DB_PATH` (default `data/condex.db`), `CONDEX_EXECUTION_SECRET`, `CONDEX_DEV_MODE`, `CONDEX_QUOTE_TTL_SECONDS`.

## Planned testnet demo

- [ ] Publish a selected conversation from an agent and mint its insight token on NEAR testnet.
- [ ] Retrieve the insight twice with a borrower credential and show zero charges.
- [ ] Demonstrate a cancelled, unfilled order and release the reserved fee.
- [ ] Demonstrate a linked fill, replay its confirmation, and show a single creator payout on NEAR testnet.
- [ ] Label the source of execution evidence in the demo so viewers can distinguish a simulated fill from a live venue confirmation.
