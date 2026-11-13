# API contract (frontend expectations)

Base URL: `NEXT_PUBLIC_API_BASE_URL`. JSON in, JSON out. Types live in `src/lib/api/types.ts`.

Only **`GET /v1/borrows/{borrow_id}/insight`** is defined in the project README. **Everything else is a proposal for the backend developer to confirm.**

## Design this contract follows (from the product diagram)
1. Wallet connects, then the creator gets an **API key**.
2. The creator connects Claude Code to ConDex through an **MCP server** that holds the key. The **private context is never uploaded**: it stays on the creator's machine. The platform stores only the public preview, a version hash and keys, so it needs no context database.
3. In Claude Code the creator exports a context with an **expiry**, optionally including their own PNL (private, never shown, never claimed).
4. Another agent browses the gallery (e.g. latest BTC context), borrows, and retrieves. Retrieval is free.
5. **If the borrowing agent reports the trade executed, the fee is charged once and paid to whoever exported the context.**

Open questions for the backend: how the gateway reaches the creator's MCP server at retrieval time (relay while online? what if offline?), and how "trade executed" is trusted. In this prototype it is **self-reported by the borrowing agent**, with no independent verification.

Errors: non-2xx with `{ "code": string, "message": string }`. The client maps status to a code (400/409/422 validation, 401 unauthorized, 402 over_budget, 403 key_invalid, 404 not_found, 410 key_expired, 5xx server_error) and honours `code: "insight_revoked"`. Network failures retry twice, HTTP errors never retry.

Auth: **TODO(backend)**. Requests currently carry `X-Near-Account: <accountId>` only. A signed message (NEP-413 is a candidate, not assumed) or session is needed.

Money fields are NEAR as JSON numbers. Timestamps are ISO 8601 UTC.

---

## GET /v1/insights — proposed
Query: `market`, `horizon` (intraday|days|weeks), `max_price`, `expiry` (soon|later), `sort` (newest|cheapest|expiring), `cursor`.
```json
{ "items": [{ "id": "ins_001", "market": "ETH/USDT", "horizon": "intraday", "price": 0.5,
  "expires_at": "2026-01-01T12:00:00Z", "version": 3, "creator": "alice.testnet",
  "status": "live", "created_at": "2025-12-31T08:00:00Z" }],
  "next_cursor": "6", "total": 14 }
```
Public preview only. Never include private text.

## GET /v1/insights/{id} — proposed
Insight fields above plus:
```json
{ "version_hash": "…", "register_tx_hash": "…|null",
  "versions": [{ "version": 1, "version_hash": "…", "created_at": "…" }] }
```

## POST /v1/insights/{id}/borrows — proposed
Request: `{ "fee_cap": 0.5, "reserve_tx_hash": "…" }`
Response (key returned once, never again):
```json
{ "borrow": { "id": "bor_001", "insight_id": "ins_001", "market": "ETH/USDT", "insight_version": 3,
  "status": "active", "fee_cap": 0.5, "charged": 0, "created_at": "…", "expires_at": "…",
  "retrieved_at": null, "receipt_id": null }, "api_key": "cdx_…" }
```
Errors: `402 over_budget` if `fee_cap` is below the listed fee; `insight_revoked`.

## GET /v1/borrows — proposed
`[ <Borrow> ]` for the authenticated borrower. `status`: active (reserved) | retrieved (fetched, still reserved) | traded (trade reported, fee charged) | expired (reserve released) | revoked. `charged` is non-zero only for `traded`.

## GET /v1/borrows/{borrow_id} — proposed
`<Borrow>`

## POST /v1/borrows/{borrow_id}/revoke — proposed
Response: `<Borrow>` with `status: "revoked"`. Releases the reserve if not yet retrieved.

## GET /v1/borrows/{borrow_id}/insight — **defined in README**
`Authorization: Bearer <borrow-api-key>`. Gateway checks scope, expiry and budget.
```json
{ "borrow_id": "bor_001", "text": "approved excerpt", "repeat": false, "charged_now": 0.5 }
```
Retrieval never charges: `charged_now` is always 0. Repeat deliveries return `repeat: true`. First delivery moves the borrow to `retrieved`. Expired key: `410`. Wrong key: `403`. Revoked: `code: "insight_revoked"`.

## POST /v1/borrows/{borrow_id}/trade-executed — proposed
`Authorization: Bearer <borrow-api-key>`. The borrowing agent reports it executed the trade. Requires status `retrieved` (otherwise `422 validation`). Charges the fee once and issues a receipt.
```json
{ "borrow": <Borrow with status "traded", charged: 0.5, receipt_id: "rcp_…">, "charged": true }
```
Repeating the call returns `charged: false` and charges nothing more.

## GET /v1/creators/me/earnings — proposed
```json
{ "total_earned": 2.5, "pending": 0.6, "released": 0.9, "payout_account": "alice.testnet" }
```

## PUT /v1/creators/me/payout-account — proposed
Request `{ "payout_account": "alice.testnet" }`, response: earnings object.

## GET /v1/creators/me/receipts — proposed
```json
[{ "id": "rcp_001", "date": "…", "insight_id": "ins_001", "market": "ETH/USDT", "version": 3,
   "borrower": "agent.testnet", "fee": 0.5, "status": "settled", "tx_hash": "…" }]
```
`status`: settled (trade reported, paid) | pending (reserved, waiting for a trade report) | released (expired without a trade).

## GET /v1/creators/me/api-key — proposed
```json
{ "has_key": true, "key_prefix": "cdx_creator_MOCK12", "created_at": "…", "mcp_connected": true, "mcp_last_seen": "…" }
```
## POST /v1/creators/me/api-key — proposed
Creates the key. Response `{ "info": <above>, "api_key": "cdx_creator_…" }`. **The key is returned once.**

## GET /v1/creators/me/exports — proposed
Contexts the creator exported from Claude Code via the MCP server. Metadata and hash only, never the text.
```json
[{ "id": "exp_001", "exported_at": "…", "suggested_market": "BTC/USDT", "suggested_horizon": "intraday",
   "message_count": 14, "includes_pnl": true, "version_hash": "…", "suggested_expires_at": "…|null",
   "previous_insight_id": "ins_001" }]
```
`includes_pnl` only says the private context contains the creator's own PNL. Never expose or imply performance.

## POST /v1/creators/me/exports/publish — proposed
Turns an export into a listed insight after the wallet registered it on NEAR.
```json
{ "export_id": "exp_001", "market": "BTC/USDT", "horizon": "intraday", "expires_at": "…",
  "fee": 0.5, "payout_account": "alice.testnet", "register_tx_hash": "…" }
```
Response `{ "insight": <InsightDetail> }`. Replaces the earlier `POST /v1/insights`, which uploaded text and no longer exists.

## GET /v1/creators/me/insights — proposed (not in the original table)
```json
[{ "id": "ins_001", "market": "ETH/USDT", "version": 3, "status": "live", "borrows": 5, "retrievals": 2, "earned": 1.0 }]
```

## GET /v1/stats — proposed (not in the original table)
```json
{ "insights_listed": 8, "borrows_today": 14, "paid_to_creators": 31.4 }
```

---

## NEAR contract calls (wallet) — proposed
In `src/lib/near/contract.ts`, marked `PROPOSED: align with deployed contract`:
- `register_insight({ version_hash, payout_account, fee (yocto), expires_at_ms })`
- `reserve_fee({ borrow_id, insight_id, cap (yocto) })` with the cap attached as deposit
- settlement on a reported trade (charge the fee once, pay `payout_account`, release the rest of the cap) is server-side and not called from the frontend
- view call for receipts: not wired yet
