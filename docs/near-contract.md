# The ConDex NEAR contract

The contract is written, in `contract/`, and follows this document. It has unit tests and is deployed on NEAR testnet at `dryward2518.testnet` (see [Testnet deployment](#testnet-deployment)). The API runs against it whenever the operator and reporter keys are set (see [Connecting the API to the contract](#connecting-the-api-to-the-contract)). Without them it falls back to `MockLedger` (`src/ledger/mockLedger.ts`), which stands in for the contract; the tests always use that backup. See [Building and testing](#building-and-testing).

The contract follows the flow described in the README: a trade is closed by a close reported from the execution side, and ConDex evaluates each thesis against market data after its expiry. It also includes two rules the README now describes too: the contract checks the trader's own approval before reserving a fee, and it records subscriptions.

In this document Bob is the **trader** and Alice is the **thesis creator**. The README and the code call the trader a "borrower".

## How many contracts

**One**, written in Rust. It does four jobs:

- **Thesis NFT.** Mint one NEP-171 token per thesis version, with NEP-177 metadata (`issued_at`, `expires_at`), the fingerprint, the fee and the payout account. Transfers are disabled.
- **Fee escrow.** Hold the trader's deposit, reserve the fee when the trader approves an order, then either credit it to the thesis creator on the first fill or return it to the trader. Settle and release must be safe to call twice for the same order.
- **Proof of trade.** Record each proof on the token when the fee settles, and add each closing fill when the execution side reports the trade closed.
- **Subscriptions.** Record until when each trader is subscribed, so the API knows whether to serve the complete thesis or only the abstract.

No fungible token (NEP-141) is needed. Fees and subscriptions are paid in native NEAR. A second contract would only be needed for fractional revenue-sharing tokens, which the README lists under "Not in this version".

## Who may call what

| Caller | What it is | What it may do |
| --- | --- | --- |
| Operator | The ConDex account the API signs publishing with | Mint thesis tokens |
| Reporter | The ConDex account that reports execution | Settle or release a fee, and record a close |
| Trader | Bob, from his own account | Deposit, approve an order and its fee, subscribe, withdraw |
| Thesis creator | Alice, from her own account | Withdraw earned fees |
| Owner | The ConDex account that deployed the contract | Set the subscription price and period, withdraw subscription income |

The operator and the reporter are separate accounts, so one leaked key does not give both powers. Neither of them can reserve a trader's funds.

The contract believes whatever the reporter says about fills and closes. It cannot check a venue itself. This is the same trust the README already states: the prototype trusts the execution service to report accurately.

## Functions

Amounts are in yoctoNEAR, written as text. Times and periods are Unix milliseconds (see [Timestamps](#timestamps)). Prices and quantities are decimal text such as `"3350.5"`, as the API writes them.

The contract exports these 21 functions, plus `contract_source_metadata`, which the NEAR SDK adds to every contract.

### Setup

| Function | Who calls it | What it does |
| --- | --- | --- |
| `new(owner_id, operator_id, reporter_id, subscription_price, subscription_period)` | The deployer, once | Initialises the contract, names the operator and reporter accounts, and sets the first subscription terms. Refused when the operator and the reporter are the same account. |

### Thesis NFT (NEP-171 and NEP-177)

| Function | Who calls it | What it does |
| --- | --- | --- |
| `mint_thesis(token_id, owner, payout_account, fee, content_hash, issued_at, expires_at, expiry_set_by, evaluation_deadline)` | Operator | Mints one token per thesis version and stores its revenue split (the payout account at 100%). `evaluation_deadline` is optional (Unix milliseconds, not before `expires_at`): the moment up to which the thesis is judged. Without it the thesis is judged at its expiry. Fails if the token already exists. |
| `nft_token(token_id)` | Anyone (view) | Returns the token and its metadata, so wallets and explorers can show it. |
| `nft_metadata()` | Anyone (view) | Returns the collection name and symbol. |
| `nft_transfer`, `nft_transfer_call` | Anyone | Required by the standard, but both always fail, because the NFT stays with its creator. |

`expiry_set_by` is `creator`, `condex_ai` or `condex_default`.

`nft_token` returns the standard fields, with `issued_at` and `expires_at` in the token's metadata. The ConDex fields are in the metadata's `extra` field, as a JSON string: `content_hash`, `fee`, `payout_account`, `revenue_split`, `expiry_set_by` and `proof_count`.

Minting writes the NEP-171 `nft_mint` event that wallets and explorers look for.

The optional price levels of a thesis are part of its conditions, so they are covered by `content_hash`. The token needs no extra field for them.

### Fee escrow

| Function | Who calls it | What it does |
| --- | --- | --- |
| `deposit()` | Trader, with NEAR attached | Adds to the trader's available balance. |
| `withdraw(amount)` | Trader, thesis creator or owner | Takes the amount off the caller's withdrawable balance, then sends them the NEAR. |
| `on_withdraw(account_id, amount)` | The contract itself | Runs after the transfer. If the transfer failed, it puts the amount back on the account's balance. |
| `reserve_fee(order_id, token_id, fee, order_hash)` | Trader | The trader's one approval of the trade and its fee. Moves the fee from the trader's available balance into a reserve for that order. |
| `settle_fee(order_id, receipt_id, proof)` | Reporter | Credits the reserved fee to the thesis creator by the split and records the proof of trade on the token. Returns `true`, or `false` when it was settled already, in which case nothing changes. |
| `release_fee(order_id)` | Reporter | Returns the reserve to the trader's available balance. Returns `true`, or `false` when it was released already, in which case nothing changes. |

A settled reserve cannot be released, and a released reserve cannot be settled.

The reporter sends this as `proof`:

| Field | Meaning |
| --- | --- |
| `market`, `side`, `quantity` | The order as the trader approved it. `side` is `buy` or `sell`. |
| `fill` | The first confirmed fill: `event_id`, `at`, `price` (may be absent), `quantity` and `source`. |

The contract adds the rest from its own records: the trader (the account that approved the order), their role (`creator` or `borrower`), the time of the approval, the thesis fingerprint and the fee paid.

### Closing a trade

| Function | Who calls it | What it does |
| --- | --- | --- |
| `record_close(order_id, event_id, quantity, price, closed_at, source)` | Reporter | Adds one closing fill to the proof of trade for that order. It can be called several times for a trade that is closed in parts. It is refused when the order has no proof of trade. Returns `true`, or `false` when this `event_id` was recorded for this order already, in which case nothing changes. |

`source` is the evidence label the API already uses: `simulated`, or `venue:<name>` for a live venue. A close pays nothing and charges nothing.

An `event_id` belongs to one order: using it for a second order is refused. A trade can have at most 100 closing fills.

In the API a trade can be closed by a close event or by a closing order. Both end up in one list of closing fills (`closingFillsOf` in `src/services/trades.ts`). Each entry in that list becomes one `record_close` call.

### Subscriptions

| Function | Who calls it | What it does |
| --- | --- | --- |
| `subscribe()` | Trader, with the subscription price attached | Extends the caller's subscription by one period, counted from now or from the end of the current subscription, whichever is later. Credits the payment to ConDex's balance. Refused when the attached amount is not the price. |
| `set_subscription_terms(price, period)` | Owner | Sets the price and the length of one period for subscriptions bought from then on. |
| `subscription_of(account_id)` | Anyone (view) | Returns until when the account is subscribed, whether that is still in the future, and the current price and period. |

### Views

| Function | What it returns |
| --- | --- |
| `balance_of(account_id)` | `available` (what the account can withdraw, or reserve for a fee), `reserved`, and `earned_total` (everything it was ever credited as income). |
| `get_reserve(order_id)` | The reserve, the order fingerprint the trader approved, and whether it is reserved, settled or released. |
| `get_proofs(token_id, from_index, limit)` | The proofs of trade recorded on a token, each with its closing fills. |
| `get_evaluation(token_id)` | The thesis's evaluation, or `null` before it is recorded. `nft_token` also carries it, as `evaluation` in the metadata's `extra`. |

### The thesis evaluation

| Function | Who calls it | What it does |
| --- | --- | --- |
| `record_evaluation(token_id, outcome, conditions_met, reference_price, final_price, entered_at, target_hit_at, invalidated_at, prices_used, source)` | Reporter | Records, once, whether the thesis's stated conditions were met. Refused before the token's evaluation deadline (its `expires_at` unless it was minted with a later one) **by the block clock**, so it can never be recorded early. `outcome` is one of the API's eight outcomes, and `conditions_met` must agree with it. `source` is `simulated` or `feed:<name>`. The contract adds `deadline` (the token's `expires_at`) and `evaluated_at` (the block time). Returns `false`, changing nothing, when the token already has one: an evaluation is never replaced. |

Evaluations are kept under their own storage prefix, not in a field of the contract's state, so adding them changed none of the stored data. The upgrade was a plain redeploy with no migration, tested first on a local node (`contract/sandbox`, `upgrading_keeps_the_state_and_adds_evaluations`).

## The trader approves the trade and its fee once

There is no separate approval for the fee and no second screen. Approving the order is one call, `reserve_fee`, from the trader's own account, and it covers the specific order, the thesis version and the fee.

The contract reserves the fee only when all of these hold:

1. The caller is the payer. Nobody else, including ConDex's operator, can reserve a trader's funds.
2. The token exists. `token_id` names one version of one thesis.
3. The thesis has not expired (see [Expiry](#expiry)).
4. `fee` equals the fee fixed on the token. The trader approves the amount they were shown, and the contract refuses if it differs.
5. The trader's available balance covers the fee.
6. The order has no reserve yet.

`order_hash` is a fingerprint of the order's market, side and quantity. The contract stores it with the reserve. At settlement it rebuilds the fingerprint from the order in `proof` and refuses a proof that does not match, so the order cannot be changed after the trader approved it.

The fingerprint is the SHA-256, as lowercase hex, of this text:

```
condex-order-v1|<order_id>|<token_id>|<market>|<buy or sell>|<quantity>
```

For example, `condex-order-v1|ord_1|ins_abc-v1|ETH-USD|sell|2` gives `007a3e36f2664d5345d9bcc73ca0ee2847df4d9d73ee7641dfb63125b3263eca`. Whoever builds the approval for the trader has to write the market and the quantity exactly as the reporter will send them later.

What follows:

- The API submits the trade only after it sees the reserve on the contract (`get_reserve`).
- The first confirmed fill credits Alice once. She can withdraw it to her wallet.
- An order that ends with no fills returns the reserve to Bob.

The trader's agent can hold a NEAR key that is limited to `reserve_fee` on this contract. A key limited to one function cannot attach NEAR, which is why the fee comes from a balance the trader deposited beforehand.

## Expiry

- **`reserve_fee` is refused at or after the token's `expires_at`,** by the time of the block. This is where a late approval is stopped on chain. The API also refuses it earlier, with `insight_expired`.
- **`settle_fee`, `release_fee` and `record_close` never check the expiry.** An order approved at 14:29 can earn its first-fill payment at 14:31 although the thesis expired at 14:30, and its trade can be closed later still.

## Subscriptions and the abstract

The thesis is stored off-chain, so the contract's part is small: it records who is subscribed and until when. The API reads `subscription_of` before it serves a thesis through the app or MCP.

- A trader with an active subscription gets the complete thesis.
- Everyone else gets the abstract and the author's accuracy, without the conditions or the conversation.

Serving the abstract and the author's accuracy is the API's job.

Assumed until decided:

- The subscription is to ConDex as a whole, not to one thesis creator.
- ConDex sets one price and one period for everyone.
- The payment goes to ConDex, not to the thesis creator.

The README now describes the subscription. The API runs it on the mock ledger for now (`src/services/subscriptions.ts`), with the same rules: a renewal extends from the later of now and the current end. Without a subscription the API serves the abstract and the author's accuracy, not a piece of the thesis. Trading needs no subscription, as in the contract.

## Timestamps

The NEP-177 specification defines `issued_at` and `expires_at` as numbers in Unix milliseconds. The standard Rust library (`near-contract-standards`) declares the same fields as strings, with comments that say ISO 8601. The two disagree.

The plan is to follow the specification and store milliseconds. Fill and close times use milliseconds too. The API holds these times as ISO strings, so the adapter converts them.

Not yet checked: which form wallets and explorers actually read.

## Storage

Every token, reserve, proof, closing fill and subscription takes storage, and NEAR charges storage to the contract's own balance. The contract must hold its own NEAR for that, separate from users' balances. Otherwise storage would lock part of those balances and the last withdrawals would fail.

## What the contract leaves to the API

- **The conversation and the conditions.** Only their fingerprint goes on NEAR.
- **Matching the order to the thesis.** The token does not store the market or the direction, so the API checks them before the trader is asked to approve.
- **The abstract.** The contract only says who is subscribed.
- **Results, verified results and the creator score.** The score service calculates them. The contract stores the fills, not the percentages.
- **Judging the thesis.** The API compares the thesis with market data and sends the outcome with `record_evaluation`. The contract records it, refuses it before the evaluation deadline (the expiry unless the creator set a later one), and never lets it change.

## Events

Besides the NEP-171 mint event, the contract writes its own event (standard `condex`) for each change: `deposit`, `withdraw`, `withdraw_failed`, `fee_reserved`, `fee_settled`, `fee_released`, `trade_closed`, `subscribed`, `subscription_terms_set` and `thesis_evaluated`. An explorer shows them on the transaction.

## Building and testing

The code is in `contract/`, one file per feature: `nft.rs`, `escrow.rs`, `close.rs`, `subscription.rs` and `views.rs`, with the shared types in `types.rs` and the tests in `tests.rs`. It uses the NEAR SDK for Rust (`near-sdk` 5.30).

From the `contract` folder:

```sh
cargo test                                                # the unit tests
cargo check --target wasm32-unknown-unknown               # check that the contract compiles
cargo near build non-reproducible-wasm --locked --no-abi  # build the file to deploy
```

- `cargo check` needs the WebAssembly target once: `rustup target add wasm32-unknown-unknown`.
- `cargo near` is NEAR's build tool, [cargo-near](https://github.com/near/cargo-near). The SDK expects it for the file that goes on chain. The build writes `contract/target/near/condex_contract.wasm`, about 227 KB.
- `--no-abi` skips an optional file that describes the contract's functions to other tools. Generating it fails on Windows, at the linking step. The contract deploys and works without it. On Linux or macOS the flag can be left out.
- On Windows, `contract/.cargo/config.toml` lets the tests build without the NASM assembler.

The unit tests run each function against the SDK's mocked blockchain. `contract/sandbox` runs the built contract on a local NEAR node with real accounts and real NEAR (`cargo test` there, after `cargo near build`), including upgrading from the first deployed build. On testnet, full trades have run through the API (`scripts/testnet-flow.ts`), and evaluations have been recorded by the API's sweep.

## Testnet deployment

| | |
| --- | --- |
| Contract account | `dryward2518.testnet` |
| Deployed | 14 November 2026, transaction [`2HMwFmJWjh4q9513WUC3RzrXEpaS4yNvgfuD7jeDZAbX`](https://explorer.testnet.near.org/transactions/2HMwFmJWjh4q9513WUC3RzrXEpaS4yNvgfuD7jeDZAbX) (code SHA-256 `4ce810df…`, 227 KB, from commit `361e35c`) |
| Upgraded | 14 November 2026, transaction [`6JzPq6xELkES6CCSb9A49D8rw4QcFGPdvvN4xBwWDcS7`](https://explorer.testnet.near.org/transactions/6JzPq6xELkES6CCSb9A49D8rw4QcFGPdvvN4xBwWDcS7): adds `record_evaluation` and `get_evaluation`. No init call, so every token, balance, reserve, proof and subscription was kept |
| Code | SHA-256 `eda2a3709069b71992455070c53823a9630218a5e4dfed8713fbadc5b971a4b0`, 247 KB, built with `cargo near build non-reproducible-wasm --locked` on macOS |
| Owner and operator | `dryward2518.testnet` |
| Reporter | `reporter.dryward2518.testnet` |
| Subscription | 1 NEAR per 30 days |

- **The checksum is from a non-reproducible build.** It matches the file built on the machine that deployed it. The same source built on another machine can give a different checksum.
- **The reporter account** `reporter.dryward2518.testnet` was created after deployment, by `dryward2518.testnet` (transaction `9eERhsEYwASgCPzA6zKJGmWFDuPxz3MCEHUNFwtL7qm5`).
- **The contract is on a main account.** Its stored data cannot be reset there. A later version that stores data differently has to be deployed to a new account, or come with a migration.

To check the deployment, call a read function. It costs nothing and needs no key:

```sh
near contract call-function as-read-only dryward2518.testnet nft_metadata json-args '{}' network-config testnet now
```

## How this differs from the mock ledger

- **Who reserves.** The mock lets the API reserve a fee and name the payer. On the contract only the trader's own account can.
- **New functions.** `withdraw` and `on_withdraw`, the proof inside `settle_fee`, `record_close`, `get_proofs` and the three subscription functions have no equivalent in the mock today.
- **Roles.** The mock accepts every call. The contract only accepts a mint from the operator, and a settle, release or close from the reporter.
- **Fee and payee.** `reserve_fee` checks the fee against the token and takes the payee from it, where the mock takes both as arguments.
- **Earned fees.** The mock only counts what a thesis creator earned. The contract also lets them withdraw it.
- **Transaction list.** The mock's `listTxs` needs no contract function, because NEAR's own transaction history covers it.

## Open decisions

1. **Later fills and the final status of the opening order.** Only the first fill is recorded, with the proof of trade. The result of a trade uses the average price of all its opening fills, and a trade only counts as closed once the opening order can fill no further. So a result cannot be recalculated from NEAR alone when an order filled in parts, and `record_close` cannot check a close against the quantity still open. Fixing this needs two more functions: one to record each later fill, and one to mark the opening order finished.
2. **The thesis creator's own trades.** The README says a creator's own trade is free and counts in their own track record. `settle_fee` only records a proof when there is a fee to pay, so a fee-free trade has no way onto the token yet. The API also refuses it today (`self_link` in `src/services/orders.ts`).
3. **The thesis evaluation.** Done: `record_evaluation`, called by the reporter (see [The thesis evaluation](#the-thesis-evaluation)). A creator's accuracy can now be counted from NEAR. The reporter is still trusted to report what the market data said, as it is for fills; a public price source would let anyone re-check it.
4. **The subscription terms.** The three assumptions under [Subscriptions and the abstract](#subscriptions-and-the-abstract).
5. **Replacing the operator or the reporter.** Both accounts are fixed when the contract is set up. If one of their keys leaks, the only fix today is to deploy the contract again.
6. **A reserve the reporter never reports on.** Only the reporter can settle or release. If it never does, the trader's fee stays reserved. A time limit after which the trader can take it back would remove that dependence.
7. **Who pays for storage.** The contract pays for every record, and nothing charges the account that caused it. Someone could make many tiny deposits to use up the contract's own NEAR. A minimum deposit would stop that.

## Connecting the API to the contract

"Ledger" in this codebase means the on-chain record: who owns which thesis token, who has deposited, and which fees are reserved or paid. It has nothing to do with the Ledger hardware wallet.

`src/ledger/ledger.ts` lists the calls the API makes to that record. With the NEAR keys set (or `CONDEX_LEDGER=near`), `NearLedger` (`src/ledger/nearLedger.ts`) takes the place of `MockLedger`, which stays as the backup.

- **A local mirror and an outbox, instead of an asynchronous interface.** The API calls the ledger inside database transactions. `NearLedger` keeps the same rules locally and, in the same transaction, queues the matching contract call in `chain_outbox`. `ChainSender` (`src/near/chainSender.ts`) sends the queue in order: `mint_thesis` as the operator; `settle_fee` (with its proof built from the order and its first fill), `release_fee` and `record_close` as the reporter. Until a call is sent its tx is `pending:<id>`, which the real hash then replaces. A network error is retried; a call the contract refuses is marked `failed` with the reason (`GET /v1/chain/outbox`, dev mode).
- **The trader approves on chain.** `POST /v1/orders` returns the order as `awaiting_approval`, with the `reserve_fee` call to sign (`order_id`, `token_id`, `fee`, `order_hash`). After the trader signs it, `POST /v1/orders/:id/confirm-approval` reads `get_reserve`, checks the payer, token, fee, fingerprint and status (409 `approval_missing` or `approval_mismatch` otherwise), and only then submits the order.
- **Subscriptions and balances are read from the contract.** Full reads and `GET /v1/subscription` ask `subscription_of` (cached for 30 seconds); `POST /v1/subscription` answers 409 `sign_on_chain` with the `subscribe` call to make. `GET /v1/ledger/balances/:account` reads `balance_of`.
- **Keys.** The operator and reporter keys go in the git-ignored `.env` (`CONDEX_NEAR_OPERATOR_KEY`, `CONDEX_NEAR_REPORTER_KEY`); `scripts/near-keys-to-env.sh` copies them from the macOS Keychain, where near-cli keeps them, without printing them.
- **Tested** with a stand-in contract (`test/nearLedger.test.ts`), and end to end on testnet with `scripts/testnet-flow.ts`: publish, mint, a trader-signed `reserve_fee`, confirm, fill, `settle_fee`, close and `record_close`, then the proof read back from `get_proofs`.
