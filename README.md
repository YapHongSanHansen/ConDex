# ConDex

**ConDex is a proof-backed intelligence marketplace for traders and their AI agents.** A trader selects the messages from a conversation with their agent and states the conditions of the idea, including when it expires. Their agent uploads them through MCP or the ConDex API. ConDex mints one NFT on NEAR for that exact version. The NFT records the thesis and, as people trade on it, its verified results.

Other agents can use the token ID to read the thesis for free. A borrower pays a usage fee only when a trade they linked to that NFT receives a confirmed fill, and the fee goes to the creator. Each filled trade is recorded on the NFT as a proof of trade, and the creator’s score is calculated from those proofs alone.

> **Build status** — NEAR Hackathon project. The off-chain services (API, MCP server, private storage, simulated execution venue) run locally against a **mock ledger** that stands in for the NEAR contract. Publishing with conditions and an expiry, free reading, matching a trade to its thesis, a public proof of thesis and trade, and paying the creator per filled trade work today. Verified results, the creator score, the NEAR testnet contract and the product frontend are not built yet. [What the prototype does today](#what-the-prototype-does-today) compares each rule below with the code.

## The problem

A call like “short ETH” can leave out the most useful parts of a trader’s conversation with their AI agent: when to enter, which evidence would invalidate the idea, and when to walk away. It rarely says when it stops being valid, so people act on it after it has gone stale. Nobody can check whether the person who shared it, or anyone else, traded it, or how that went. Sharing the entire chat can expose unrelated positions and wallet details.

ConDex lets the creator share selected reasoning with explicit conditions and an expiry. It lets a borrower evaluate the thesis before deciding whether to trade, records what happened when the thesis was traded, and pays the creator a fee for each filled trade.

## From conversation to creator payout

1. **Publish from the creator’s agent.** The creator connects their agent to ConDex through the Model Context Protocol (MCP), or gives it a ConDex API key with publishing permission. The creator chooses which conversation or messages the agent may share and states the thesis conditions, including the expiry. The agent reminds the creator when the expiry is missing, then uploads the approved material and registers the thesis.
2. **Mint the thesis NFT on NEAR.** ConDex mints one NFT for the published version. It records the creator, the publish time, the fingerprint of the conditions and conversation, the expiry, and the flat usage fee per filled trade. The approved conversation and conditions stay in private storage and are available through ConDex.
3. **Borrow and read for free.** Another user’s agent calls the thesis by token ID using its own scoped credential. It can read the reasoning, check whether the conditions still apply, and decide to walk away. Reading, repeated calls, and expiry incur zero ConDex fees.
4. **Authorise a linked trade.** If the borrower acts on the thesis, their wallet or authorised trading agent approves an order from their own account. ConDex binds the thesis version and fee quote to the order before submission, and accepts the link only if the order matches the thesis: the same market and direction, before the expiry. The borrower sees the fee and authorises its reservation. A key that reads research cannot sign trades.
5. **Pay on confirmed execution.** ConDex checks the execution record for that exact order. Its first confirmed fill, including a partial fill, triggers one creator payout on NEAR and one proof of trade, recorded on the thesis NFT. Later fills and retries for the same order use the same receipt. A rejected order or an order confirmed cancelled or expired with no fills releases the reserve. While the outcome is unknown, settlement stays pending.
6. **Score the result.** When the trade is closed, its closing fill is added to the proof of trade. The NFT’s verified results and the creator’s score are recalculated.

For example, Alice publishes an ETH thesis: short ETH-USD on a 15-minute close back below yesterday’s high, invalid on a 1-hour close above the sweep high, expiring at 14:30 UTC on 14 November (the US market open), with a usage fee of 0.1 test NEAR per filled trade. Bob’s agent reads it three times for free. If Bob cancels his linked order before any fill, he pays Alice zero. If part of that order fills before cancellation, Alice earns 0.1 test NEAR, even if Bob later closes the trade at a loss. That loss is then recorded on the NFT and counts in the borrowers’ track record of Alice’s score. After 14:30 UTC on 14 November, nobody can link a new trade to this thesis.

## Thesis conditions and expiry

A thesis is the published conversation plus its conditions. The conditions are separate fields, so they can be recorded, preserved and compared with real trades.

| Condition | What it records |
| --- | --- |
| Market | What is traded, for example ETH-USD. |
| Direction | Long or short. |
| Entry | When to enter, in the creator’s words. |
| Invalidation | What would prove the idea wrong, in the creator’s words. |
| Exit or target | Optional. When to take profit or close. |
| Expiry date | The last day a trade can be linked to the thesis. Every thesis has one. |
| Expiry time | The time on that day, in UTC, when the thesis depends on one. |

### Expiry controls

- **The date is required.** Every thesis version has an expiry date.
- **The time depends on the thesis.** The creator adds a time when the idea depends on one, such as “by the US open”. Without a time, the thesis expires at the end of its expiry date, 23:59 UTC.
- **The creator is reminded.** Before publishing, the creator’s agent asks for the expiry date and, where the thesis depends on one, the time.
- **Without a date, ConDex’s AI sets one.** It evaluates the thesis and takes the date from the deadline, event or timeframe the thesis describes. The proof of thesis states that ConDex set the expiry, and why.
- **The expiry is fixed once published.** It is part of the proof of thesis. Changing it means publishing a new version, which gets its own NFT.
- **After the expiry,** ConDex issues no fee quote and links no new trade to the thesis. [What the expiry ends](#what-the-expiry-ends) lists what stops and what stays.

## Proof of thesis and proof of trade

Each published thesis version is one NFT on NEAR, following the NEP-171 standard. The NFT is the proof of thesis, and every proof of trade is recorded on it. Together they show that a thesis existed in an exact form before anyone traded it, and what happened when it was traded.

### Proof of thesis: the thesis NFT

Minted once, when a thesis version is published. One NFT identifies one version of one thesis. It records:

- the token ID and version;
- the creator’s account;
- the publish time;
- the expiry date and time, and whether the creator or ConDex set it;
- a fingerprint (hash) of the exact conditions and approved conversation;
- the usage fee per filled trade, and who receives it;
- a reference to every proof of trade linked to it.

The publish time and the expiry use the fields that NEAR’s NFT metadata standard (NEP-177) already defines for them, `issued_at` and `expires_at`, so wallets and explorers can show them.

Everything on NEAR is public, so only the fingerprint goes on chain. ConDex stores the conditions and the conversation and serves them to connected wallets. Anyone who holds them can recompute the fingerprint and compare it with NEAR, so neither the creator nor ConDex can alter a thesis after publishing.

The original conditions are preserved permanently. An edit is a new version with a new NFT, and every earlier NFT stays on NEAR.

The NFT stays with its creator. In this version it cannot be transferred.

### Proof of trade

Recorded on the thesis NFT when a real trade linked to it receives its first confirmed fill. It holds:

- the thesis NFT it belongs to (token ID and fingerprint);
- the trader’s account, and whether the trader is the creator or a borrower;
- the order: market, direction, size and the time it was authorised;
- the fill: time, price, quantity and the source of the evidence (a simulated fill, or which live venue confirmed it);
- the usage fee paid, for a borrower’s trade;
- the closing fill, added when the trade is closed, so the result can be calculated.

### Verified results

From its closed trades, each thesis NFT shows the verified result of that thesis alone: the number of trades, net return, net profit % and maximum drawdown %. They are calculated the same way as the [creator score](#creator-score). Nobody can enter a result by hand: every figure comes from a proof of trade.

### Matching a thesis to a real trade

A trade counts as a trade of the thesis only when all of these hold:

1. It was linked to that exact thesis version before the order was submitted.
2. It is in the thesis’s market.
3. It opens in the thesis’s direction.
4. It was authorised before the thesis expired.
5. A connected execution route confirms that it was filled.

ConDex refuses to link an order that fails checks 2 to 4. The entry and invalidation conditions are in the creator’s own words, so ConDex does not judge them automatically. The proof of trade shows the real fill price and time beside them for anyone to compare.

A trade submitted independently outside a connected execution route has no reliable link to the thesis. ConDex can prove, charge for and score only a trade whose link and execution it can verify.

## Pay per filled trade

There is one charge, the usage fee: a flat fee per filled trade, paid by the borrower. The creator receives it.

- **Reading is free.** Every read, repeated reads, and reads after the expiry cost nothing.
- **The creator sets the fee** when publishing. It is fixed in the proof of thesis.
- **The borrower pays once per filled order.** The fee is reserved when the borrower authorises a linked order and paid out on that order’s first confirmed fill, including a partial fill. Later fills and repeated confirmations charge nothing more.
- **No fill, no fee.** An order that is rejected, cancelled or expired with no fills gets its reserve back.
- **The fee does not depend on the result.** It is charged whether the trade later wins or loses.
- **The contract decides who is paid.** Each thesis NFT has a revenue split in the NEAR contract: a list of accounts and percentages, set at publishing and fixed. In this version it has one entry, the creator’s payout account at 100%. Only fees that were actually collected are paid out.
- **A creator’s own trades are free.** A creator who links their own trade to their own thesis pays no fee and earns none.

### What the expiry ends

A thesis can expire while its proof remains. The two are defined separately:

| | After the expiry |
| --- | --- |
| The NFT, its proof of thesis and its trade record | Stay on NEAR permanently. |
| Reading | Stays free. |
| New fee quotes and linked trades | Refused. |
| Usage fees | Paid only for orders that were authorised before the expiry and fill later. No other fee can arise, so the creator’s fee income from this thesis ends. |
| Results | A trade opened before the expiry still records its result when it closes, and still counts in the verified results and the scores. |

### Not in this version

The thesis NFT is not a fractional or transferable revenue-sharing token. Splitting or selling the right to a thesis’s fees among other holders, for example with NEP-141 tokens, is a possible later version. Nothing above depends on it.

## Creator score

Every creator has a public score. It is calculated only from proofs of trade, so it reflects real, verified trades and nothing the creator reports about themselves. It is recalculated each time a matched trade is closed.

The score keeps two track records and never merges them:

| Track record | Trades counted | What it shows |
| --- | --- | --- |
| Creator’s own | The creator’s own trades linked to their own theses | Whether the creator trades their own ideas, and with what result |
| Borrowers’ | Borrowers’ trades linked to the creator’s theses | How the theses worked for the people who traded them |

Each track record reports three figures over its closed trades, with the number of trades they are based on:

| Figure | How it is calculated |
| --- | --- |
| Net return | Total profit minus total loss, after trading costs and ConDex fees, in US dollars. |
| Net profit % | Each trade’s net result as a percentage of its entry value, added up. This is the result of putting the same amount into every trade, so one large trade cannot dominate. |
| Maximum drawdown % | The largest fall from a high point of that running total, taking the trades in the order they closed. |

For example, four closed trades returning +5%, −3%, −4% and +10% give a net profit of +8%. The running total peaked at +5% and fell to −2%, so the maximum drawdown is 7%.

A trade that is still open is listed but not counted until it closes.

## Where NEAR fits

| Component | Planned responsibility |
| --- | --- |
| MCP server and API | Accept authorised uploads from creators’ agents, remind them to set the expiry, issue scoped access, and serve theses by token ID. |
| NEAR contract | Mint one NFT (NEP-171) per thesis version, record each proof of trade on it, hold its revenue split, reserve authorised fees, and pay each collected fee according to the split. |
| Execution integration | Submit or track the authorised order, and verify its fill and its close. The prototype trusts this service to report the execution accurately. |
| Private storage | Store the approved messages and thesis conditions off-chain. Only their fingerprint goes on NEAR. |
| ConDex AI | Set the expiry date when the creator gives none, and record why. |
| Score service | Calculate each NFT’s verified results and each creator’s score from the proofs of trade. |

## What the prototype does today

The API and code call a thesis an *insight*, and its fingerprint a `content_hash`.

| Rule | In the prototype today |
| --- | --- |
| Expiry date required, with a reminder | Built. Every version has an expiry: the creator’s `expiry_date` and optional `expiry_time` (or a full ISO `expires_at`), or one that ConDex sets. A past or malformed expiry is refused. The MCP publish tool tells the creator’s agent to ask for the date and time, and the publish response says when ConDex had to set it. |
| ConDex’s AI sets a missing expiry | Built, and off until the server has a key for a model. With `CONDEX_LLM_API_KEY`, an OpenAI-compatible reasoning model (Qwen on Grafilab by default) reads the thesis; with `ANTHROPIC_API_KEY`, Claude does. The AI takes the expiry from the deadline or event the thesis describes, at most 30 days out. The proof of thesis says `set_by: "condex_ai"` with the reason, and both are part of the content hash. With no model, or no usable answer, ConDex applies a default of 7 days and records `set_by: "condex_default"`, so nothing is published without an expiry. Both models are tested against stand-ins. The Claude path has not been run against the live API yet. |
| Expiry stops new trades | Built. After the expiry, fee quotes and linked orders are refused, and reading still works. |
| Thesis conditions as fields | Built. Market, direction, entry and invalidation are required fields, and the target is optional. The market and direction are public. The entry, invalidation and target are served with the conversation. |
| Thesis NFT | Partly. Each version gets a token record on the mock ledger with a fingerprint, creator, payout account, fee, publish time, expiry and who set the expiry. It is not yet an NEP-171 NFT on NEAR. |
| Original conditions preserved | Built. A published version cannot be edited. Its fingerprint covers the conditions and the expiry, a reader can recompute it, and every read re-checks the stored content against the minted hash (`integrity.matches`). A change is a new version with a new token. |
| Proof of thesis | Built, against the mock ledger. `GET /v1/tokens/:id/proof` is public and shows the creator, publish time, expiry and who set it, fingerprint, fee, mint transaction and whether the thesis is still `preserved`. It never includes the conversation or the creator’s entry, invalidation and target. |
| Proof of trade on the NFT | Built, against the mock ledger. The same endpoint lists each proof of trade: trader, role, the order, the first fill (time, price, quantity, evidence source), the fee paid and the settlement transaction. The trader closes the trade with `POST /v1/orders/:orderId/close` (MCP: `condex_close_trade`), a closing order on the opposite side with no fee, allowed after the expiry. Its confirmed fills are the closing fills, and the proof shows `trade.status` (`open`, `partially_closed` or `closed`), the closing fills, `closing_fill` and a `result`: entry and exit price, profit or loss, return % and win, loss or flat. A closing fill needs a price. The result is in the market's quote currency and excludes the NEAR usage fee. Only the fee payment is written to the mock ledger, so the closing fill is not yet on NEAR. |
| Verified results | Partly. Each proof of trade carries the result of that one trade. The totals over a thesis (number of trades, net return, net profit %, maximum drawdown %) are not built. |
| Matching | Built for checks 1 to 4. An order in another market, against the thesis’s direction or after the expiry is refused before any fee is reserved, and each linked order records what was checked. Check 5 uses the simulated venue or the execution endpoint. |
| Pay per filled trade, to the creator | Built, against the mock ledger. The whole fee goes to the payout account named at publishing. |
| Creator’s own trades | Not built. A creator cannot link an order to their own thesis. |
| Creator score | Not built. The creator’s public page shows counts only: theses, reads, paid orders and fees paid. |

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

`npm start` and `npm run dev` read a git-ignored `.env` file if there is one, for settings such as `CONDEX_LLM_API_KEY`.

**Data lives in memory.** Nothing is written to disk, and everything (sign-ins, API keys, published insights, orders, mock balances) starts empty whenever the server restarts, including each automatic restart of `npm run dev`. After a restart, reconnect your wallet (one click) and create a new MCP key; the test console notices the ended session and says so, and **Run every button** sets the test data up again. To keep data between restarts instead, set `CONDEX_DB_PATH=data/condex.db` (a local SQLite file, built into Node).

The test console has a button for every API action and every demo checklist item. **Run every button** resets the data, clicks each one in order and reports pass or fail.

### Connect wallet (top right of the test console)

- **My NEAR wallet on this computer** — one click. If your testnet account is in near-cli (`near account import-account`), ConDex asks near-cli to sign the sign-in message with the key in this computer's keychain. The first time, type your account name; after that, **Connect wallet** connects in one click. Only ConDex's own sign-in message is ever signed, and only for requests made on this computer from the console itself, in dev mode.
- **My NEAR wallet, copy and paste** — run the near-cli command the console shows and paste what it prints. Use this when ConDex runs on a different computer from your wallet.
- **Test wallet** — a made-up account with a throwaway key, for trying things out (dev mode only).

Once connected, the button's menu creates an MCP key (with a ready-to-paste `claude mcp add` command), switches wallet, or disconnects. In dev mode the server checks the signature but not that the key belongs to the account; start it with `CONDEX_WALLET_KEY_CHECK=near-rpc` to also confirm that on NEAR (test wallets then stop working).

### Dev mode stays on this computer

Dev mode is for your own machine, so it is locked to it:

- The server listens on `127.0.0.1` only (`CONDEX_HOST` changes that), so other machines on your network cannot reach it.
- The dev routes (`/test`, `/v1/dev/*`, `/v1/sim/*`, one-click connect) also refuse requests from other websites, from host names other than `localhost`/`127.0.0.1`, and anything a proxy or tunnel passed on.
- Without the on-chain check, an account only accepts the key it first signed in with, so nobody else can sign in as it. The test console keeps each test wallet's key in the browser for this.
- **Do not expose the dev server through a tunnel** (ngrok, port forwarding). Tunnels that strip forwarding headers cannot be detected, and one-click connect signs with your keychain.

### Access: connect a wallet first

| | No wallet | Wallet connected |
| --- | --- | --- |
| Publisher pages (`GET /v1/publishers/:account`), insight list and previews, proof of thesis and trade (`GET /v1/tokens/:id/proof`) | ✅ | ✅ |
| Ledger explorer (`/v1/ledger/*`): the same data that will be public on NEAR | ✅ | ✅ |
| Read conversations, publish, trade, deposit | 401 | ✅ with the session or an API key it issued |
| Receipts | 401 | ✅ the borrower's and creator's own |
| Create, list and revoke API keys for agents and MCP | 401 | ✅ with the session only |

Connecting a wallet uses NEP-413 message signing; it sends no transaction:

1. `POST /v1/auth/challenge` returns `{ message, nonce, recipient }`. The recipient is the website's domain (`CONDEX_AUTH_RECIPIENT`), and the message starts with "Sign in to ConDex at <domain>", so a user can see when a look-alike site asks them to sign in.
2. The wallet signs it (`signMessage` in NEAR Wallet Selector, or `near message sign-nep413` in near-cli).
3. `POST /v1/auth/verify` with `{ account_id, public_key, signature, nonce }`. The signature may be base64 (browser wallets) or `ed25519:<base58>` (near-cli). Redirect wallets such as MyNearWallet also sign the callback URL, so for them add `callback_url`: the exact callbackUrl the website gave the wallet, which must be on one of `CONDEX_ALLOWED_ORIGINS`. ConDex checks the signature and, with `CONDEX_WALLET_KEY_CHECK=near-rpc`, that the key is a full-access key of the account on NEAR. First sign-in creates the account. The response holds a session token (`cdxs_…`).

Challenges last `CONDEX_CHALLENGE_TTL_SECONDS` (5 minutes by default). Anyone can request one, so each client address may request `CONDEX_SIGNINS_PER_MINUTE` (60) a minute and hold at most 20 unfinished ones, and at most 10,000 can be unfinished in total. Expired challenges and sessions are deleted. A temporary NEAR RPC problem returns a retryable 502, not "this is not your key".

API keys (`cdx_…`) issued from a session keep working after sign-out until they are revoked, so a running agent is not cut off when the website tab closes. Sessions and keys remember whether the sign-in was checked on NEAR; a server running with `near-rpc` refuses ones made while the check was off.

### Publishing a thesis and linking a trade

`POST /v1/insights` publishes a thesis, and `POST /v1/insights/:insightId/versions` publishes a new version of one. Both take:

| Field | Meaning |
| --- | --- |
| `title`, `summary` | The public title, and optional public preview text. |
| `market` | Required. What is traded, for example `ETH-USD`. Public. |
| `direction` | Required. `long` or `short`. Public. |
| `entry`, `invalidation` | Required, in the creator's words. Served with the conversation, not in the public preview. |
| `target` | Optional. When to take profit or close. |
| `expiry_date` | `YYYY-MM-DD`, in UTC. Leave it out and ConDex sets the expiry. |
| `expiry_time` | Optional `HH:MM`, in UTC. Without it the thesis expires at 23:59:59 UTC on the expiry date. |
| `expires_at` | Instead of the two fields above: a full ISO date-time such as `2026-12-31T13:30:00Z`. |
| `fee_near`, `payout_account` | The fee per filled order, and the account that receives it (the creator's by default). |
| `messages` | The approved messages. |

In the response, `expires_at` is the expiry and `expiry.set_by` says who set it: `creator`, `condex_ai` or `condex_default`. When ConDex set it, `expiry.reason` says why and `notice` is a sentence to pass on to the creator. Conditions and expiry are fixed once published; changing them means publishing a version.

Reading a thesis (`GET /v1/tokens/:tokenId`) also returns `integrity`: whether the stored conditions, expiry and messages still hash to the minted fingerprint. `GET /v1/tokens/:tokenId/proof` is public and needs no wallet: it returns the proof of thesis, and a proof of trade for each linked order that got a confirmed fill.

`POST /v1/orders` links an order to a thesis only when it matches. A mismatch is refused with HTTP 409 before any fee is reserved, and the quote can be used again:

| Error code | When |
| --- | --- |
| `market_mismatch` | The order names a market other than the thesis's. Leave `market` out to use the thesis's. |
| `direction_mismatch` | The order does not open in the thesis's direction: `buy` for a long thesis, `sell` for a short one. |
| `insight_expired` | The thesis has expired. `POST /v1/quotes` is refused the same way. |

A linked order's `thesis_match` records what was checked: the thesis version and its fingerprint, the market, the direction and opening side, and the authorisation time against the expiry.

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
| `src/services/insights.ts` | Publishing versions with their conditions, content hashing, minting, public previews and free reads. |
| `src/services/expiry.ts`, `src/ai/` | The expiry of a version: the creator’s own, or ConDex’s AI (`llmExpiry.ts` for an OpenAI-compatible model, `claudeExpiry.ts` for Claude), or ConDex’s default. |
| `src/services/orders.ts` | Fee quotes, matching an order to its thesis, fee reservation and order submission. |
| `src/services/settlement.ts` | Execution events → one payout on the first fill, release on no-fill endings, idempotent replays. |
| `src/ledger/` | `Ledger` interface and `MockLedger`. A NEAR testnet adapter replaces the mock. |
| `src/execution/venue.ts` | `ExecutionVenue` interface and the simulated venue. |
| `src/mcp/server.ts` | MCP server (stdio) for creators' and borrowers' agents. |
| `public/test.html` | Test console, served at `/test` when `CONDEX_DEV_MODE=true` (the default). |

### Configuration

Invalid values (a misspelt network, `CONDEX_DEV_MODE=yes`, a timeout of `5m`) stop the server at startup with a message, instead of quietly falling back. Empty values mean "use the default".

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONDEX_DEV_MODE` | `true` | `true` or `false`. Dev mode enables the test console, the dev and simulation routes, and the defaults marked *dev* below. |
| `PORT` | `8787` | Port to listen on. |
| `CONDEX_HOST` | dev: `127.0.0.1`, otherwise `0.0.0.0` | Network interface to listen on. |
| `CONDEX_DB_PATH` | dev: `:memory:` | `:memory:` keeps everything in memory (lost on restart); a file path such as `data/condex.db` keeps it. **Required** outside dev mode, so data is never lost by accident. |
| `CONDEX_EXECUTION_SECRET` | dev: `dev-execution-secret` | Shared secret the execution integration sends. **Required** outside dev mode, and the public dev value is refused there. |
| `CONDEX_AUTH_RECIPIENT` | dev: `localhost:<port>` | The website's domain, used as the NEP-413 recipient and in the sign-in message. **Required** outside dev mode. |
| `CONDEX_ALLOWED_ORIGINS` | dev: `http://localhost:<port>`, `http://127.0.0.1:<port>` | Comma-separated origins a redirect wallet may return to. |
| `CONDEX_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet`. |
| `CONDEX_NEAR_RPC_URL` | FastNEAR (`https://test.rpc.fastnear.com` / `https://rpc.mainnet.fastnear.com`) | NEAR RPC used to check wallet keys, the same endpoints near-cli uses. |
| `CONDEX_WALLET_KEY_CHECK` | dev: `none`, otherwise `near-rpc` | `near-rpc` confirms on NEAR that the signing key belongs to the account. `none` (dev mode only) skips that and pins each account to its first key. |
| `CONDEX_CHALLENGE_TTL_SECONDS` | `300` | How long a sign-in challenge (or a near-cli command) stays valid. |
| `CONDEX_SESSION_TTL_SECONDS` | `86400` | How long a wallet session lasts. |
| `CONDEX_SIGNINS_PER_MINUTE` | `60` | New sign-in challenges per client address per minute. |
| `CONDEX_TRUST_PROXY` | `0` | Number of reverse proxies in front of the server, so the client address (for sign-in limits) comes from `X-Forwarded-For`. |
| `CONDEX_QUOTE_TTL_SECONDS` | `300` | How long a fee quote stays valid. |
| `CONDEX_LLM_API_KEY` | none | Key for the OpenAI-compatible reasoning model that sets a missing expiry. Put it in a git-ignored `.env` file (`npm start` and `npm run dev` read it), never in the code. |
| `CONDEX_LLM_BASE_URL` | `https://llm.grafilab.ai/v1` | Any OpenAI-compatible endpoint. |
| `CONDEX_LLM_MODEL` | `qwen/qwen3.7-flash` | Model used for the expiry. |
| `CONDEX_LLM_REASONING_EFFORT` | `low` | `low`, `medium` or `high`. |
| `CONDEX_LLM_TIMEOUT_SECONDS` | `60` | How long to wait for the model before applying ConDex’s default expiry. |
| `ANTHROPIC_API_KEY` | none | An alternative to the model above: lets Claude set a missing expiry. Used when `CONDEX_LLM_API_KEY` is not set. |
| `CONDEX_EXPIRY_AI` | `llm` with a `CONDEX_LLM_API_KEY`, else `claude` with an Anthropic key, else `off` | `llm`, `claude` or `off`: which AI sets a missing expiry. With `off`, or when the AI gives no usable answer, the thesis gets ConDex’s default of 7 days. Each AI evaluation is one model call, and an account gets at most 20 an hour. |
| `CONDEX_NEAR_CLI` | found automatically | Path to near-cli-rs for one-click connect (an npm or pnpm `near` shim also works). The server prints at startup whether it found it. |

## Planned testnet demo

- [ ] Publish a selected conversation with its conditions and expiry from an agent, and mint its thesis NFT on NEAR testnet.
- [x] Publish a thesis without an expiry date and show ConDex’s AI setting one, marked as set by ConDex. (Works against the mock ledger.)
- [ ] Retrieve the thesis twice with a borrower credential and show zero charges.
- [ ] Show that an order in the wrong market or direction, or placed after the expiry, cannot be linked.
- [ ] Demonstrate a cancelled, unfilled order and release the reserved fee.
- [ ] Demonstrate a linked fill, replay its confirmation, and show a single creator payout and a single proof of trade on NEAR testnet.
- [ ] Close a trade and show the NFT’s verified results and the creator’s score change.
- [ ] Let a thesis expire and show that its NFT and trade record remain while new trades are refused.
- [ ] Label the source of execution evidence in the demo so viewers can distinguish a simulated fill from a live venue confirmation.
