# ConDex

**ConDex is a proof-backed intelligence marketplace for traders and their AI agents.** A trader selects the messages from a conversation with their agent and states the conditions of the idea, including when it expires. Their agent uploads them through MCP or the ConDex API. ConDex mints one NFT on NEAR for that exact version. The NFT records the thesis and, as people trade on it, its verified results.

Anyone can read a thesis’s abstract and its author’s accuracy for free; an active ConDex subscription unlocks the complete thesis. A borrower pays a usage fee only when a trade they linked to that NFT receives a confirmed fill, and the fee goes to the creator. Each filled trade is recorded on the NFT as a proof of trade, and the creator’s score is calculated from those proofs and from ConDex’s own evaluation of each thesis against market data. Nothing in it is reported by the creator.

> **Build status** — NEAR Hackathon project. The off-chain services (API, MCP server, private storage, simulated execution venue) run locally against a **mock ledger** that stands in for the NEAR contract. Publishing with conditions and an expiry, free abstracts with the author’s score, the subscription that unlocks the full thesis, matching a trade to its thesis, a public proof of thesis and trade, paying the creator per filled trade, closing a trade, evaluating a thesis against real market prices from CoinGecko (or a simulated feed), verified results and the creator score work today, and a dev-mode replay runs a past market window at its real prices. The API also runs on the NEAR testnet contract when its keys are configured. The creator’s own track record and the product frontend are not built yet. [What the prototype does today](#what-the-prototype-does-today) compares each rule below with the code.

## The problem

A call like “short ETH” can leave out the most useful parts of a trader’s conversation with their AI agent: when to enter, which evidence would invalidate the idea, and when to walk away. It rarely says when it stops being valid, so people act on it after it has gone stale. Nobody can check whether the person who shared it, or anyone else, traded it, or how that went. Sharing the entire chat can expose unrelated positions and wallet details.

ConDex lets the creator share selected reasoning with explicit conditions and an expiry. It lets a borrower evaluate the thesis before deciding whether to trade, records what happened when the thesis was traded, and pays the creator a fee for each filled trade.

## From conversation to creator payout

1. **Publish from the creator’s agent.** The creator connects their agent to ConDex through the Model Context Protocol (MCP), or gives it a ConDex API key with publishing permission. The creator chooses which conversation or messages the agent may share and states the thesis conditions, including the expiry. The agent reminds the creator when the expiry is missing, then uploads the approved material and registers the thesis.
2. **Mint the thesis NFT on NEAR.** ConDex mints one NFT for the published version. It records the creator, the publish time, the fingerprint of the conditions and conversation, the expiry, and the flat usage fee per filled trade. The approved conversation and conditions stay in private storage and are available through ConDex.
3. **Read the abstract, subscribe to read the whole thesis.** Another user’s agent looks up the thesis by token ID. Without an active ConDex subscription it sees only the abstract (title, summary, market, direction, expiry and fee) and the author’s accuracy and track record; the entry, invalidation, target, price levels and conversation stay locked. With an active subscription and its own scoped credential it reads the complete thesis, checks whether the conditions still apply, and decides whether to walk away. The subscription is paid to ConDex and only controls what the borrower can see. It is separate from the usage fee, which applies only if a linked order fills, and it is not needed to trade.
4. **Authorise a linked trade.** If the borrower acts on the thesis, their wallet or authorised trading agent approves an order from their own account. ConDex binds the thesis version and fee quote to the order before submission, and accepts the link only if the order matches the thesis: the same market and direction, before the expiry. The borrower approves once: one call from their own account to the NEAR contract (`reserve_fee`) covers that specific order, the thesis version and the fee. The contract verifies the approval itself. It reserves the fee only when the caller is the payer (nobody else, including ConDex, can reserve a borrower’s funds), the thesis version exists and has not expired, the fee equals the one fixed on the NFT, and the borrower’s deposited balance covers it. It stores a fingerprint of the approved order, so the order cannot be changed afterwards. The fee is collected only when that order receives its first confirmed fill. A key that reads research cannot sign trades.
5. **Pay on confirmed execution.** ConDex checks the execution record for that exact order. Its first confirmed fill, including a partial fill, triggers one creator payout on NEAR and one proof of trade, recorded on the thesis NFT. Later fills and retries for the same order use the same receipt. A rejected order or an order confirmed cancelled or expired with no fills releases the reserve. While the outcome is unknown, settlement stays pending.
6. **Record the close.** When the execution route reports that the trade was closed, the closing fill is added to the proof of trade and the result of the trade is calculated. The NFT’s verified results and the creator’s score are recalculated.
7. **Evaluate the thesis.** After the expiry, ConDex compares the thesis with market data and records, once, whether its conditions were met. That outcome counts in the creator’s accuracy.

For example, Alice publishes an ETH thesis: short ETH-USD on a 15-minute close back below yesterday’s high, invalid on a 1-hour close above the sweep high, expiring at 14:30 UTC on 14 November (the US market open), with a usage fee of 0.1 test NEAR per filled trade. Bob’s agent reads the abstract and Alice’s accuracy for free; Bob subscribes to ConDex, and his agent reads the complete thesis three times at no extra charge. If Bob cancels his linked order before any fill, he pays Alice zero. If part of that order fills before cancellation, Alice earns 0.1 test NEAR, even if Bob later closes the trade at a loss. That loss is then recorded on the NFT and counts in the borrowers’ track record of Alice’s score. After 14:30 UTC on 14 November, nobody can link a new trade to this thesis.

## Thesis conditions and expiry

A thesis is the published conversation plus its conditions. The conditions are separate fields, so they can be recorded, preserved and compared with real trades.

| Condition | What it records |
| --- | --- |
| Market | What is traded, for example ETH-USD. |
| Direction | Long or short. |
| Entry | When to enter, in the creator’s words. |
| Invalidation | What would prove the idea wrong, in the creator’s words. |
| Exit or target | Optional. When to take profit or close. |
| Price levels | Optional. The entry, invalidation and target as prices, so ConDex can [evaluate the thesis](#thesis-evaluation) against market data after the expiry. |
| Expiry date | The last day a trade can be linked to the thesis. Every thesis has one. |
| Expiry time | The time on that day, in UTC, when the thesis depends on one. |
| Evaluation deadline | Optional. When the market prices stop counting for the [evaluation](#thesis-evaluation): a date or an instant on or after the expiry, at most 30 days later. Without one it is the expiry. |

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

From its closed trades, each thesis NFT shows the verified result of that thesis alone: the number of closed trades, net return %, net profit in US dollars and maximum drawdown %. They are calculated the same way as the [creator score](#creator-score). Nobody can enter a result by hand: every figure comes from a proof of trade.

### Matching a thesis to a real trade

A trade counts as a trade of the thesis only when all of these hold:

1. It was linked to that exact thesis version before the order was submitted.
2. It is in the thesis’s market.
3. It opens in the thesis’s direction.
4. It was authorised before the thesis expired.
5. A connected execution route confirms that it was filled.

ConDex refuses to link an order that fails checks 2 to 4. The entry and invalidation conditions are in the creator’s own words, so ConDex does not use them to accept or refuse a trade. The proof of trade shows the real fill price and time beside them for anyone to compare. Whether the thesis itself turned out right is judged separately, after the expiry: see [Thesis evaluation](#thesis-evaluation).

A trade submitted independently outside a connected execution route has no reliable link to the thesis. ConDex can prove, charge for and score only a trade whose link and execution it can verify.

### Closing a trade

A trade is closed when the connected execution route reports a close for the order that opened it, with the quantity closed and the price. The trader does nothing in ConDex. Each close is a closing fill on the proof of trade.

- A trade can be closed in parts. It counts as closed when everything that was filled has been closed and no more of the opening order can fill.
- A close pays nothing and charges nothing. The usage fee was settled on the first fill.
- A trade can be closed after the thesis has expired.
- Once the trade is closed, its result is calculated from the average price of its opening fills and the average price of its closing fills.

## Pay per filled trade

There are two charges. The subscription, paid to ConDex, controls how much of a thesis the borrower can read. The usage fee, a flat fee per filled trade paid by the borrower, goes to the creator.

- **The abstract is free; the whole thesis needs a subscription.** Without an active subscription, anyone sees the abstract and the author’s accuracy and track record. With one, every read, repeated reads and reads after the expiry return the complete thesis at no extra charge. A subscription is paid to ConDex for a fixed period (30 days for 1 test NEAR by default) and unlocks every thesis; renewing early adds the new period after the current one. A creator reads their own theses without one. Trading needs no subscription.
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
| Reading | Unchanged: the abstract stays free, and subscribers can still read the complete thesis. |
| New fee quotes and linked trades | Refused. |
| Usage fees | Paid only for orders that were authorised before the expiry and fill later. No other fee can arise, so the creator’s fee income from this thesis ends. |
| Results | A trade opened before the expiry still records its result when it closes, and still counts in the verified results and the scores. |
| Evaluation | ConDex judges the thesis against market data, once. |

### Not in this version

The thesis NFT is not a fractional or transferable revenue-sharing token. Splitting or selling the right to a thesis’s fees among other holders, for example with NEP-141 tokens, is a possible later version. Nothing above depends on it.

## Thesis evaluation

After a thesis expires, ConDex judges it against market data and records whether its conditions were met. The creator does not report this and cannot change it.

- **When.** Once, after the evaluation deadline. Until then the evaluation is pending, because the price can still reach any level. The deadline is separate from the expiry: the expiry is the last moment a trade can be linked, and the evaluation deadline, which is the expiry unless the creator set a later one, gives a trade opened just before the expiry time to play out. It is fixed once published and covered by the fingerprint.
- **Against what.** The market’s prices from the moment of publishing up to the evaluation deadline, from a connected market data feed. The evaluation names the feed it used. ConDex’s live feed is CoinGecko: one-minute candles of the pool that prices the market (for ETH-USD, the Uniswap v3 WETH/USDC pool on Ethereum).
- **How candles are read.** A level counts as reached when a candle’s high or low touched it. A candle that touched both the target and the invalidation counts as invalidated, because which came first inside it is unknown. The candle the thesis was published in counts by its close only.
- **Only on complete data.** ConDex judges a thesis once it holds every candle of its window, a few minutes after the deadline. A feed that is down or rate-limited delays the evaluation. It never becomes the outcome.
- **With what.** The thesis’s price levels. A thesis counts as entered when the price reaches its entry price, or at publishing when it has no entry price or the price is already past it. The invalidation price counts from publishing. The target price counts only once the thesis is entered.
- **Fixed once recorded.** A later price cannot change the outcome.
- **On the NFT.** The outcome is recorded on the thesis NFT, so the token carries its own evaluation. The contract refuses it before the token’s evaluation deadline (the expiry unless the creator set a later one) and never lets it change. Tokens minted before the deadline existed are judged at their expiry.

| Outcome | When | Conditions met |
| --- | --- | --- |
| Target hit | The target price was reached before the invalidation price. | Yes |
| In direction | No target price was set, and at the expiry the price had moved in the thesis’s direction since it was entered. | Yes |
| Invalidated | The invalidation price was reached first. | No |
| Target missed | The thesis was entered, but the target price was not reached by the expiry. | No |
| Against direction | No target price was set, and at the expiry the price had not moved in the thesis’s direction. | No |
| Not triggered | The entry price was never reached. | Not judged |
| Already reached | The price was already past the target or the invalidation when the thesis was published. | Not judged |
| No data | The feed had no price for the market. | Not judged |

A thesis with no price levels is judged on its direction alone, by comparing the price at the expiry with the price at publishing.

The evaluation is public. It shows the outcome, the market price at publishing and at the expiry, and when each level was reached. On a live feed it also names the pool the prices came from and carries the feed’s attribution, so anyone can look up the same candles. It does not show the creator’s price levels, which stay with the conditions.

## Creator score

Every creator has a public score. It has two parts, and the creator reports neither of them:

- **Accuracy** comes from [thesis evaluation](#thesis-evaluation): of the creator’s theses that were judged, the share whose conditions were met. Theses still waiting for their expiry, and theses that could not be judged, are counted separately.
- **Track records** come from proofs of trade: what real, verified trades of the creator’s theses returned.

There is no reputation figure and no result entered by hand.

The score keeps two track records and never merges them:

| Track record | Trades counted | What it shows |
| --- | --- | --- |
| Creator’s own | The creator’s own trades linked to their own theses | Whether the creator trades their own ideas, and with what result |
| Borrowers’ | Borrowers’ trades linked to the creator’s theses | How the theses worked for the people who traded them |

Each track record reports three figures over its closed trades, with the number of trades they are based on:

| Figure | How it is calculated |
| --- | --- |
| Net return % | Each trade’s result as a percentage of its entry value, added up. This is the result of putting the same amount into every trade, so one large trade cannot dominate. |
| Net profit ($) | Total profit minus total loss, in US dollars. |
| Maximum drawdown % | The largest fall of the running net return % from its highest point, taking the trades in the order they closed. |

For example, four closed trades returning +5%, −3%, −4% and +10% give a net return of +8%. The running total peaked at +5% and fell to −2%, so the maximum drawdown is 7%.

A trade that is still open, or only partly closed, is listed but not counted until it is fully closed.

The figures are before trading costs. The usage fee is paid in NEAR, so it is shown on each proof of trade and not taken off the dollar figures.

## Where NEAR fits

| Component | Planned responsibility |
| --- | --- |
| MCP server and API | Accept authorised uploads from creators’ agents, remind them to set the expiry, issue scoped access, and serve theses by token ID. |
| NEAR contract | Mint one NFT (NEP-171) per thesis version, record each proof of trade on it, hold its revenue split, reserve authorised fees, and pay each collected fee according to the split. |
| Execution integration | Submit or track the authorised order, and report its fills and its close. The prototype trusts this service to report the execution accurately. |
| Private storage | Store the approved messages and thesis conditions off-chain. Only their fingerprint goes on NEAR. |
| ConDex AI | Set the expiry date when the creator gives none, and record why. |
| Market data feed | Supply the prices each thesis is evaluated against after its expiry: one-minute candles from CoinGecko. |
| Score service | Evaluate each thesis against market data after its expiry, and calculate each NFT’s verified results and each creator’s score. |

## What the prototype does today

The API and code call a thesis an *insight*, and its fingerprint a `content_hash`.

| Rule | In the prototype today |
| --- | --- |
| Expiry date required, with a reminder | Built. Every version has an expiry: the creator’s `expiry_date` and optional `expiry_time` (or a full ISO `expires_at`), or one that ConDex sets. A past or malformed expiry is refused. The MCP publish tool tells the creator’s agent to ask for the date and time, and the publish response says when ConDex had to set it. |
| ConDex’s AI sets a missing expiry | Built, and off until the server has a key for a model. With `CONDEX_LLM_API_KEY`, an OpenAI-compatible reasoning model (Qwen on Grafilab by default) reads the thesis; with `ANTHROPIC_API_KEY`, Claude does. The AI takes the expiry from the deadline or event the thesis describes, at most 30 days out. The proof of thesis says `set_by: "condex_ai"` with the reason, and both are part of the content hash. With no model, or no usable answer, ConDex applies a default of 7 days and records `set_by: "condex_default"`, so nothing is published without an expiry. Both models are tested against stand-ins. The Claude path has not been run against the live API yet. |
| Access expiry and evaluation deadline as separate items | Built. The proof of thesis shows `published_at`, `expires_at` and `evaluation_deadline`. The creator may send `evaluation_deadline` (a date or an ISO date-time, from the expiry up to 30 days after); without it, it equals the expiry. The evaluation and the sweep wait for it. |
| Expiry stops new trades | Built. After the expiry, fee quotes and linked orders are refused, and reading still works. |
| Thesis conditions as fields | Built. Market, direction, entry and invalidation are required fields, and the target is optional. The market and direction are public. The entry, invalidation and target are served with the conversation. Optional price levels (`entry_price`, `invalidation_price`, `target_price`) are checked against the direction, covered by the fingerprint and served with the conversation. |
| Thesis NFT | Partly. Each version gets a token record on the mock ledger with a fingerprint, creator, payout account, fee, publish time, expiry and who set the expiry. It is not yet an NEP-171 NFT on NEAR. |
| Original conditions preserved | Built. A published version cannot be edited. Its fingerprint covers the conditions and the expiry, a reader can recompute it, and every read re-checks the stored content against the minted hash (`integrity.matches`). A change is a new version with a new token. |
| Proof of thesis | Built, against the mock ledger. `GET /v1/tokens/:id/proof` is public and shows the creator, publish time, expiry and who set it, fingerprint, fee, mint transaction and whether the thesis is still `preserved`. It never includes the conversation or the creator’s entry, invalidation and target. |
| Proof of trade on the NFT | Built, against the mock ledger. The same endpoint lists each proof of trade: trader, role, the order, the first fill (time, price, quantity, evidence source), the fee paid and the settlement transaction. A trade is closed by a `close` execution event on its order, with a quantity and a price (see [Closing a trade and reading the results](#closing-a-trade-and-reading-the-results)). The proof then shows `closing_fill`: the average closing price, the quantity closed, and `complete` once the whole trade is closed. A fully closed trade has a `result`: entry and exit price, entry value, net profit in dollars and net return %. A trader can also close with a closing order, `POST /v1/orders/:orderId/close` (MCP: `condex_close_trade`), on the opposite side with no fee. Its confirmed fills count as closing fills in the same way, and `trade` shows the status (`open`, `partially_closed` or `closed`), each closing fill and a running result. Each result is in the market's quote currency and excludes the NEAR usage fee. Only the fee payment is written to the mock ledger, so the closing fill is not yet on NEAR. |
| Thesis evaluation | Built. With `CONDEX_COINGECKO_API_KEY` set, theses are judged on real one-minute candles from CoinGecko (`source: "feed:coingecko"`, with the pool and the attribution in the evaluation). A sweep fetches the candles in the background every minute and keeps them locally, so no request waits on CoinGecko, and a thesis stays `pending` (with `waiting_for: "market_data"` once past its deadline) until its whole window is held: it is judged a few minutes after the deadline. Only ETH-USD has a pool configured; another market is recorded as `no_data`. Without the key the feed is the simulated one: prices are recorded with `POST /v1/sim/market/:market/prices` in dev mode, and the first request for the proof or the publisher page after the deadline evaluates the thesis. Before the deadline the proof endpoint shows `evaluation.status: "pending"`. The outcome is stored once and never changed. `expires_at` is the last moment to link a trade; the evaluation waits for `evaluation_deadline`, which is the same moment unless the creator set a later one. With the NEAR contract, the evaluation is also recorded on the thesis NFT (`record_evaluation`, refused before the expiry by the chain's clock, never replaced), and a sweep evaluates expired theses every minute without anyone opening them; the proof shows the transaction as `evaluation.recorded.tx`. |
| Verified results | Built. `verified_results` on the proof endpoint gives the number of fully closed trades, net return %, net profit in dollars and maximum drawdown % for that thesis, before trading costs. They are calculated on each request and are not written to the mock ledger. |
| Matching | Built for checks 1 to 4. An order in another market, against the thesis’s direction or after the expiry is refused before any fee is reserved, and each linked order records what was checked. Check 5 uses the simulated venue or the execution endpoint. |
| Pay per filled trade, to the creator | Built, against the mock ledger. The whole fee goes to the payout account named at publishing. |
| Abstract and subscription | Built, against the mock ledger. `GET /v1/tokens` and `GET /v1/tokens/:id/preview` are public and carry `author_score` (accuracy and the borrowers’ track record) and the subscription terms (`unlock`). `GET /v1/tokens/:id` needs a read key and an active subscription, or answers 402 `subscription_required`; the creator reads their own without one. `POST /v1/subscription` charges one period to `CONDEX_TREASURY_ACCOUNT`. With `CONDEX_LEDGER=near` the API reads subscriptions from the NEAR contract (`subscription_of`) instead, and the trader subscribes there. |
| The borrower’s one approval, verified on NEAR | Built, with `CONDEX_LEDGER=near`. The order waits as `awaiting_approval` until the borrower signs `reserve_fee` from their own account; `POST /v1/orders/:id/confirm-approval` checks it on the contract before submitting. On the default mock ledger, ConDex’s server reserves the fee after checking the borrower’s trade key. |
| Replaying a past window | Built, in dev mode on the mock ledger. `POST /v1/dev/clock` freezes ConDex’s clock at a past moment, and each later step fills the orders resting on the simulated venue at the close of the next real candle and judges the theses whose deadline has passed. A thesis published this way shows `clock: "replay"` on its abstract, its proof and its evaluation. Sign-in, API keys and subscriptions stay on real time. NEAR’s own clock cannot be moved, so the replay is refused there. See [Real prices and replaying a past window](#real-prices-and-replaying-a-past-window). |
| Creator’s own trades | Not built. A creator cannot link an order to their own thesis. |
| Creator score | Partly. The publisher page (`GET /v1/publishers/:account`) shows `score.accuracy`: theses judged, conditions met, accuracy %, pending and not judged. It also shows `score.borrowers`, the track record of borrowers’ trades: closed trades, net return %, net profit in dollars and maximum drawdown %. The creator’s own track record is not built, because a creator cannot link an order to their own thesis. |

## Running the off-chain services

Requires Node.js 24 or later (it runs TypeScript directly). There is no database to install or set up.

```sh
npm install
npm start            # API on http://localhost:8787, test console on http://localhost:8787/test
npm run dev          # same, restarting whenever a source file changes
npm test             # API flow tests and MCP tests
npm run test:page    # opens the test console in headless Chrome/Edge and checks every button
npm run typecheck

# The server runs on the NEAR contract when its keys are in .env, and on the mock ledger as a backup when
# they are not. To use the contract (keys from the macOS Keychain, see docs/near-contract.md):
scripts/near-keys-to-env.sh
npm start                      # CONDEX_LEDGER=mock npm start forces the backup
node scripts/testnet-flow.ts   # one full trade through the API on testnet
```

`npm start` and `npm run dev` read a git-ignored `.env` file if there is one, for settings such as `CONDEX_LLM_API_KEY`.

**Data lives in memory.** To keep it between restarts while developing, run `npm run dev:keep` instead of `npm run dev`: it saves everything (published theses, keys, sign-ins) to `data/condex.db`, which git ignores. Delete that file to start fresh.

By default, with `npm run dev`: Nothing is written to disk, and everything (sign-ins, API keys, published insights, orders, mock balances) starts empty whenever the server restarts, including each automatic restart of `npm run dev`. After a restart, reconnect your wallet (one click) and create a new MCP key; the test console notices the ended session and says so, and **Run every button** sets the test data up again. To keep data between restarts instead, set `CONDEX_DB_PATH=data/condex.db` (a local SQLite file, built into Node).

The test console has a button for most API actions and demo checklist items. It has none yet for recording market prices, reporting a close event or the replay clock; `npm test` covers those. **Run every button** resets the data, clicks each one in order and reports pass or fail.

### Real prices and replaying a past window

Put a CoinGecko Demo API key in the git-ignored `.env` file as `CONDEX_COINGECKO_API_KEY`. From then on theses are judged on real one-minute candles, and the startup line says `market data: feed:coingecko`. Market data provided by [CoinGecko](https://www.coingecko.com/).

```sh
npm run snapshot -- ETH-USD 2026-08-19T14:30:00Z 2026-08-19T16:30:00Z   # save a window of candles to demo/candles
npm run replay -- set "2026-08-19 23:22"   # put ConDex at a past moment (this computer's time zone)
npm run replay -- to 23:32                 # step forward: fills resting orders, judges due theses, prints the price
npm run replay -- status
npm run replay -- reset                    # back to real time; accounts, keys and data are kept
npm run testnet:pairs -- <creator> <trader> 15 30 45   # real long and short pairs on NEAR testnet
```

**Saved windows.** CoinGecko’s Demo plan only serves the last six months of minute candles. A window saved with `npm run snapshot` is loaded at startup, so it can be judged and replayed without the network and after it has left that history. `demo/candles/eth-usd-2026-08-19.json` holds 19 August 2026, 14:30 to 16:30 UTC.

**The demo replay.** On 19 August 2026 between 23:22 and 23:43 (UTC+8) ETH broke out, pulled back and bounced. Start the API with `CONDEX_LEDGER=mock`, connect both wallets, then:

| Step | Replay clock (UTC+8) | What happens | ETH |
| --- | --- | --- | --- |
| `set "2026-08-19 23:22"` | 23:22 | Alice’s agent reads candles with `condex_get_candles`. Nothing after this moment is shown. | 2,010.45 |
| `to 23:32` | 23:32 | Alice publishes: long, target 2,080, invalidation 2,050, `expires_at` 23:38, `evaluation_deadline` 23:43. | 2,072.65 |
| `to 23:34` | 23:34 | Bob reads and buys. The order is open and his fee is reserved. | 2,061.38 |
| `to 23:35` | 23:35 | The order fills at the close of the next candle. Only now is Alice paid. | 2,065.39 |
| `to 23:42` | 23:42 | Bob asks to close. The target was touched at 23:40 (high 2,082.38). | 2,081.53 |
| `to 23:43` | 23:43 | The close fills, and the thesis is judged: target hit, conditions met. | 2,082.34 |

Times in the requests are UTC: 23:38 UTC+8 is `2026-08-19T15:38:00Z`. `test/replay.test.ts` runs this sequence on the saved candles.

- **What is real and what is not.** The prices are real. The clock is replayed, the venue is simulated (it fills at the real candle price) and the ledger is the mock. Everything published during a replay is marked `clock: "replay"`.
- **Use `npm start` for a replay,** not `npm run dev`: a restart loses the clock and the data.
- **An agent’s own clock is still today’s.** `condex_get_candles` returns `now`, the moment ConDex is at. An agent should take its expiry and deadline from that.
- **`/v1/dev/reset` wipes accounts and keys.** `npm run replay -- reset` only puts the clock back.

**Real examples on NEAR.** A replay cannot run on NEAR, and nobody can predict a live window. `npm run testnet:pairs` publishes a long and a short thesis on the same window, links one trade to each from the trader’s own account, fills and closes them at the live CoinGecko price, and waits for both evaluations to be recorded on their tokens. Unless ETH ends exactly where it started, one of each pair comes out right. It needs the API on NEAR with the CoinGecko key, the trader’s key in near-cli, and `CONDEX_DB_PATH` set so the orders are kept. `--mock` runs the same thing on the mock ledger as a dry run.

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
| Read conversations, publish, trade, deposit | 401 | ✅ with the session or an API key it issued; reading a full thesis also needs an active subscription (402 `subscription_required`), unless you are its creator |
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
| `entry_price`, `invalidation_price`, `target_price` | Optional. The same conditions as prices, so ConDex can evaluate the thesis after the expiry. For a long thesis the invalidation must be below the entry and the target above it, and the other way round for a short one; otherwise publishing is refused with `levels_inconsistent`. |
| `expiry_date` | `YYYY-MM-DD`, in UTC. Leave it out and ConDex sets the expiry. |
| `expiry_time` | Optional `HH:MM`, in UTC. Without it the thesis expires at 23:59:59 UTC on the expiry date. |
| `expires_at` | Instead of the two fields above: a full ISO date-time such as `2026-12-31T13:30:00Z`. |
| `fee_near`, `payout_account` | The fee per filled order, and the account that receives it (the creator's by default). |
| `messages` | The approved messages. |

In the response, `expires_at` is the expiry and `expiry.set_by` says who set it: `creator`, `condex_ai` or `condex_default`. When ConDex set it, `expiry.reason` says why and `notice` is a sentence to pass on to the creator. Conditions and expiry are fixed once published; changing them means publishing a version.

### Reading and the subscription

| Route | Who | Returns |
| --- | --- | --- |
| `GET /v1/tokens`, `GET /v1/tokens/:tokenId/preview` | Anyone | The abstract: title, summary, market, direction, expiry, `fee_per_filled_order`, `author_score` (`accuracy` and the `borrowers` track record) and `unlock` (the subscription's `fee`, `period_days` and `paid_to`). No conditions or messages. |
| `GET /v1/publishers/:nearAccountId` | Anyone | The creator's `score`, stats and abstracts. |
| `GET /v1/stats` | Anyone | Public home-page figures: `insights_live`, `trades_linked_24h` and `fees_paid_to_creators`. |
| `GET /v1/tokens/:tokenId` | A read key or session, with an active subscription (or the thesis's creator) | The full thesis: `conditions`, `messages`, `integrity` and `subscription.subscribed_until`. Without a subscription: HTTP 402 `subscription_required`, with the terms in `error.details`. |
| `GET /v1/subscription` | A session or any key | `account_id`, `active`, `subscribed_until` and the `terms`, like the contract's `subscription_of`. |
| `POST /v1/subscription` | A session or a trade key (any other key gets 403 `missing_scope`) | Pays one period from the ledger balance (402 `insufficient_balance` when it is too low). A renewal starts when the current period ends. |

Quotes and orders need no subscription. The MCP tools `condex_get_publisher`, `condex_subscription_status` and `condex_subscribe` cover the same routes.

Reading a thesis (`GET /v1/tokens/:tokenId`) also returns `integrity`: whether the stored conditions, expiry and messages still hash to the minted fingerprint. `GET /v1/tokens/:tokenId/proof` is public and needs no wallet: it returns the proof of thesis, and a proof of trade for each linked order that got a confirmed fill.

`POST /v1/orders` links an order to a thesis only when it matches. A mismatch is refused with HTTP 409 before any fee is reserved, and the quote can be used again:

| Error code | When |
| --- | --- |
| `market_mismatch` | The order names a market other than the thesis's. Leave `market` out to use the thesis's. |
| `direction_mismatch` | The order does not open in the thesis's direction: `buy` for a long thesis, `sell` for a short one. |
| `insight_expired` | The thesis has expired. `POST /v1/quotes` is refused the same way. |

A linked order's `thesis_match` records what was checked: the thesis version and its fingerprint, the market, the direction and opening side, and the authorisation time against the expiry.

### Closing a trade and reading the results

A trade is closed by a `close` execution event on the order that opened it. The execution integration sends it to `POST /v1/execution/events` with the `x-execution-secret` header:

| Field | Meaning |
| --- | --- |
| `event_id` | The integration’s own id for the event. Sending the same id again is a replay and changes nothing. |
| `order_id` | The order that opened the trade. |
| `type` | `close`. |
| `quantity`, `price` | Required. How much was closed, and at what price. |
| `source` | `simulated`, or `venue:<name>` for a live venue. |

In dev mode, `POST /v1/sim/orders/:orderId/close` with a `price` does the same on the simulated venue. Without a `quantity` it closes everything still open.

| Error code | When |
| --- | --- |
| `nothing_to_close` | The order has no fills, or the trade is already fully closed. |
| `overclose` | The quantity is more than what is still open. |
| `close_needs_fill` | The event has no quantity or no price. |
| `closing_in_progress` | A closing order for this trade is still waiting for fills. |

`GET /v1/tokens/:tokenId/proof` returns the outcome. Besides the proof of thesis it holds `evaluation` (pending, or the outcome once the thesis has expired), each proof of trade with its `closing_fill` and `result`, and `verified_results` for the thesis. `GET /v1/publishers/:account` returns the creator’s `score`: `accuracy` and the `borrowers` track record. Both are public.

In dev mode, `POST /v1/sim/market/:market/prices` with a `price` and an optional `at` records a price on the simulated market data feed. On the CoinGecko feed that route is refused, and a simulated fill or close sent without a `price` takes the feed’s current price.

`GET /v1/market/:market/candles` returns the one-minute candles the evaluation reads, for any connected wallet or API key (MCP: `condex_get_candles`). `from` and `to` are optional ISO times: without them it is the last 30 minutes, at most 1,000 candles, and never past `now`, which during a replay is the replayed moment.

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
| `src/services/insights.ts` | Publishing versions with their conditions, content hashing, minting, free abstracts with the author's score, and subscriber reads. |
| `src/services/subscriptions.ts` | The subscription: paying a period to ConDex's treasury, and the check that full reads need. |
| `src/services/expiry.ts`, `src/ai/` | The expiry of a version: the creator’s own, or ConDex’s AI (`llmExpiry.ts` for an OpenAI-compatible model, `claudeExpiry.ts` for Claude), or ConDex’s default. |
| `src/services/orders.ts` | Fee quotes, matching an order to its thesis, fee reservation and order submission. |
| `src/services/settlement.ts` | Execution events → one payout on the first fill, release on no-fill endings, close events, idempotent replays. |
| `src/services/evaluation.ts`, `src/market/` | Evaluating a thesis against market data after its expiry, the result of each closed trade, verified results and the creator score. `MarketData` interface, the simulated feed, and `coinGecko.ts`: the CoinGecko candle feed with its local cache and saved windows. |
| `src/services/evaluationSweep.ts` | Every minute: fetches the candles due theses still need, then evaluates them. |
| `src/services/replay.ts`, `scripts/replay.ts` | The dev replay clock and what happens when it moves, and the presenter’s `npm run replay`. |
| `demo/candles/`, `scripts/market-snapshot.ts` | Saved candle windows, loaded at startup, and `npm run snapshot`, which saves one. |
| `scripts/testnet-pairs.ts` | `npm run testnet:pairs`: long and short pairs with a linked trade each, at live prices. |
| `src/services/trades.ts` | Closing orders, and the one list of closing fills that every result is calculated from. |
| `src/ledger/` | `Ledger` interface, `MockLedger` (the default) and `NearLedger` (`CONDEX_LEDGER=near`). |
| `src/near/chain.ts`, `chainClient.ts`, `chainSender.ts` | The NEAR contract: reads (subscriptions, balances, approvals), and the outbox sender for the calls ConDex signs. |
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
| `CONDEX_CORS_ORIGINS` | none | Comma-separated website origins (for example `https://condex.app`) allowed to call the API from a browser. Leave it empty when the site proxies the API under its own origin. |
| `CONDEX_ALLOWED_ORIGINS` | dev: `http://localhost:<port>`, `http://127.0.0.1:<port>` | Comma-separated origins a redirect wallet may return to. |
| `CONDEX_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet`. |
| `CONDEX_NEAR_RPC_URL` | FastNEAR (`https://test.rpc.fastnear.com` / `https://rpc.mainnet.fastnear.com`) | NEAR RPC used to check wallet keys, the same endpoints near-cli uses. |
| `CONDEX_WALLET_KEY_CHECK` | dev: `none`, otherwise `near-rpc` | `near-rpc` confirms on NEAR that the signing key belongs to the account. `none` (dev mode only) skips that and pins each account to its first key. |
| `CONDEX_CHALLENGE_TTL_SECONDS` | `300` | How long a sign-in challenge (or a near-cli command) stays valid. |
| `CONDEX_SESSION_TTL_SECONDS` | `86400` | How long a wallet session lasts. |
| `CONDEX_SIGNINS_PER_MINUTE` | `60` | New sign-in challenges per client address per minute. |
| `CONDEX_TRUST_PROXY` | `0` | Number of reverse proxies in front of the server, so the client address (for sign-in limits) comes from `X-Forwarded-For`. |
| `CONDEX_QUOTE_TTL_SECONDS` | `300` | How long a fee quote stays valid. |
| `CONDEX_SUBSCRIPTION_FEE_NEAR` | `1` | The price of one subscription period, in NEAR. |
| `CONDEX_SUBSCRIPTION_DAYS` | `30` | How long one subscription period lasts. |
| `CONDEX_TREASURY_ACCOUNT` | `condex-treasury.testnet` | The NEAR account that receives subscription fees on the mock ledger. |
| `CONDEX_LEDGER` | `near` when the NEAR keys below are set, else `mock` | `near` runs on the ConDex contract (see [docs/near-contract.md](docs/near-contract.md#connecting-the-api-to-the-contract)). `mock` is the backup: it is used when the keys are missing (the server says so at startup), when set explicitly, and by the tests. `near` set explicitly without keys stops the server. |
| `CONDEX_NEAR_CONTRACT` | `dryward2518.testnet` | The contract account, with `CONDEX_LEDGER=near`. |
| `CONDEX_NEAR_OPERATOR_ID`, `CONDEX_NEAR_OPERATOR_KEY` | the contract account; none | The account that mints thesis tokens, and its `ed25519:…` secret key. Required with `CONDEX_LEDGER=near`; `scripts/near-keys-to-env.sh` writes both into `.env`. |
| `CONDEX_NEAR_REPORTER_ID`, `CONDEX_NEAR_REPORTER_KEY` | `reporter.<contract>`; none | The account that settles and releases fees and records closes, and its secret key. Required with `CONDEX_LEDGER=near`. |
| `CONDEX_LLM_API_KEY` | none | Key for the OpenAI-compatible reasoning model that sets a missing expiry. Put it in a git-ignored `.env` file (`npm start` and `npm run dev` read it), never in the code. |
| `CONDEX_LLM_BASE_URL` | `https://llm.grafilab.ai/v1` | Any OpenAI-compatible endpoint. |
| `CONDEX_LLM_MODEL` | `qwen/qwen3.7-flash` | Model used for the expiry. |
| `CONDEX_LLM_REASONING_EFFORT` | `low` | `low`, `medium` or `high`. |
| `CONDEX_LLM_TIMEOUT_SECONDS` | `60` | How long to wait for the model before applying ConDex’s default expiry. |
| `ANTHROPIC_API_KEY` | none | An alternative to the model above: lets Claude set a missing expiry. Used when `CONDEX_LLM_API_KEY` is not set. |
| `CONDEX_EXPIRY_AI` | `llm` with a `CONDEX_LLM_API_KEY`, else `claude` with an Anthropic key, else `off` | `llm`, `claude` or `off`: which AI sets a missing expiry. With `off`, or when the AI gives no usable answer, the thesis gets ConDex’s default of 7 days. Each AI evaluation is one model call, and an account gets at most 20 an hour. |
| `CONDEX_COINGECKO_API_KEY` | none | CoinGecko Demo API key, so theses are judged on real prices. Put it in the git-ignored `.env` file, never in the code. It is sent only as a request header. |
| `CONDEX_MARKET_FEED` | `coingecko` with a `CONDEX_COINGECKO_API_KEY`, else `simulated` | `coingecko` or `simulated`: where the evaluation reads prices. `coingecko` without a key works from the saved windows in `demo/candles` only, which is enough for a replay. |
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
- [ ] After the expiry, show ConDex’s evaluation of the thesis against market data and the creator’s accuracy.
- [ ] Label the source of execution evidence in the demo so viewers can distinguish a simulated fill from a live venue confirmation.
