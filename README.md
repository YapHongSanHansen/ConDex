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

Requires Node.js 24 or later (it runs TypeScript directly). There is no database to install or set up.

```sh
npm install
npm start            # API on http://localhost:8787, test console on http://localhost:8787/test
npm run dev          # same, restarting whenever a source file changes
npm test             # API flow tests and MCP tests
npm run test:page    # opens the test console in headless Chrome/Edge and checks every button
npm run typecheck
```

**Data lives in memory.** Nothing is written to disk, and everything (sign-ins, API keys, published insights, orders, mock balances) starts empty whenever the server restarts, including each automatic restart of `npm run dev`. After a restart, reconnect your wallet (one click) and create a new MCP key; the test console notices the ended session and says so, and **Run every button** sets the test data up again. To keep data between restarts instead, set `CONDEX_DB_PATH=data/condex.db` (a local SQLite file, built into Node).

The test console has a button for every API action and every demo checklist item. **Run every button** resets the data, clicks each one in order and reports pass or fail.

### Connect wallet (top right of the test console)

- **My NEAR wallet on this computer** — one click. If your testnet account is in near-cli (`near account import-account`), ConDex asks near-cli to sign the sign-in message with the key in this computer's keychain. The first time, type your account name; after that, **Connect wallet** connects in one click. Only ConDex's own sign-in message is ever signed, and only for requests made on this computer from the console itself, in dev mode.
- **My NEAR wallet, copy and paste** — run the near-cli command the console shows and paste what it prints. Use this when ConDex runs on a different computer from your wallet.
- **Test wallet** — a made-up account with a throwaway key, for trying things out (dev mode only).

Once connected, the button's menu creates an MCP key (with a ready-to-paste `claude mcp add` command), switches wallet, or disconnects. In dev mode the server checks the signature but not that the key belongs to the account; start it with `CONDEX_WALLET_KEY_CHECK=near-rpc` to also confirm that on NEAR (test wallets then stop working).

### Access: connect a wallet first

| | No wallet | Wallet connected |
| --- | --- | --- |
| Publisher pages (`GET /v1/publishers/:account`), insight list and previews | ✅ | ✅ |
| Read conversations, publish, trade, deposit | 401 | ✅ with the session or an API key it issued |
| Create, list and revoke API keys for agents and MCP | 401 | ✅ with the session only |

Connecting a wallet uses NEP-413 message signing; it sends no transaction:

1. `POST /v1/auth/challenge` returns `{ message, nonce, recipient }`.
2. The wallet signs it (`signMessage` in NEAR Wallet Selector, or `near message sign-nep413` in near-cli).
3. `POST /v1/auth/verify` with `{ account_id, public_key, signature, nonce }`. The signature may be base64 (browser wallets) or `ed25519:<base58>` (near-cli). Redirect wallets such as MyNearWallet also sign the callback URL, so for them add `callback_url`: the exact callbackUrl the website gave the wallet. ConDex checks the signature and, with `CONDEX_WALLET_KEY_CHECK=near-rpc`, that the key is a full-access key of the account on NEAR. First sign-in creates the account. The response holds a session token (`cdxs_…`).

Challenges last `CONDEX_CHALLENGE_TTL_SECONDS` (5 minutes by default). Anyone can request one, so expired challenges are deleted and at most 10,000 can be open at once.

API keys (`cdx_…`) issued from a session keep working after sign-out until they are revoked, so a running agent is not cut off when the website tab closes. Sessions and keys remember whether the sign-in was checked on NEAR; a server running with `near-rpc` refuses ones made while the check was off.

### Connecting an agent over MCP

Connect your wallet, create a scoped key (**Create an MCP key** in the Connect wallet menu, or `POST /v1/keys` with the session), then register the server with your agent. For Claude Code, run these two lines (PowerShell, cmd or bash):

```sh
claude mcp remove condex
claude mcp add condex --env CONDEX_API_KEY=cdx_... --env CONDEX_API_URL=http://localhost:8787 "--" node "/path/to/ConDex/src/mcp/server.ts"
```

The first line removes an older `condex` entry, so the same two lines also replace a key; it's fine if it reports that none was found. `"--"` is quoted because Claude's PowerShell launcher drops a bare `--`. Then restart Claude Code, or reconnect from `/mcp`. The **Create an MCP key** dialog shows these lines with your key and path filled in.

The MCP tools have exactly the scopes of that key: `publish`, `read` and/or `trade`. Because data lives in memory, the key stops working when the server restarts or its data is reset; create a new one and run the two lines again.

### Layout

| Path | What it does |
| --- | --- |
| `src/api/app.ts` | HTTP routes. Request bodies are validated in `src/api/schemas.ts`. |
| `src/services/auth.ts`, `src/near/` | Wallet sign-in: NEP-413 challenge and verification, on-chain access-key check, sessions. |
| `src/services/accounts.ts` | Authentication and API keys scoped to `publish`, `read` and `trade`. Keys and sessions are stored hashed. |
| `src/services/insights.ts` | Publishing versions, content hashing, minting, public previews and free reads. |
| `src/services/orders.ts` | Fee quotes, fee reservation and order submission. |
| `src/services/settlement.ts` | Execution events → one payout on the first fill, release on no-fill endings, idempotent replays. |
| `src/ledger/` | `Ledger` interface and `MockLedger`. A NEAR testnet adapter replaces the mock. |
| `src/execution/venue.ts` | `ExecutionVenue` interface and the simulated venue. |
| `src/mcp/server.ts` | MCP server (stdio) for creators' and borrowers' agents. |
| `public/test.html` | Test console, served at `/test` when `CONDEX_DEV_MODE=true` (the default). |

Configuration: `PORT`, `CONDEX_DB_PATH` (unset = in memory; a file path such as `data/condex.db` keeps data between restarts), `CONDEX_EXECUTION_SECRET` (the execution integration's shared secret; **required** when `CONDEX_DEV_MODE=false`, and the public dev value is refused there), `CONDEX_DEV_MODE`, `CONDEX_CHALLENGE_TTL_SECONDS` (default 300), `CONDEX_QUOTE_TTL_SECONDS`, `CONDEX_NEAR_NETWORK` (`testnet`), `CONDEX_NEAR_RPC_URL`, `CONDEX_WALLET_KEY_CHECK` (`near-rpc`, or `none` in dev mode so the test console's dev wallet can sign in as any account; defaults to `none` in dev mode), `CONDEX_AUTH_RECIPIENT`, `CONDEX_SESSION_TTL_SECONDS`, `CONDEX_NEAR_CLI` (path to the near-cli-rs binary for one-click connect; found automatically when installed with npm).

## Planned testnet demo

- [ ] Publish a selected conversation from an agent and mint its insight token on NEAR testnet.
- [ ] Retrieve the insight twice with a borrower credential and show zero charges.
- [ ] Demonstrate a cancelled, unfilled order and release the reserved fee.
- [ ] Demonstrate a linked fill, replay its confirmation, and show a single creator payout on NEAR testnet.
- [ ] Label the source of execution evidence in the demo so viewers can distinguish a simulated fill from a live venue confirmation.
