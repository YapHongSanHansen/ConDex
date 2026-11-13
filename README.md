# ConDex

Borrow trading insights from AI conversations. Pay the creator when your agent uses one.

A trader can spend an hour with an AI working out when to enter a position and when to walk away. ConDex lets the trader publish that reasoning as a versioned insight on NEAR. Another agent can borrow it through a scoped API key. Borrowing is free. The creator earns the agreed fee on the first successful retrieval under that borrow.

> **Build status** — Project design for the NEAR Hackathon. This repository currently contains the README. The API and NEAR testnet contract described below are planned.

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
