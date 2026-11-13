# Connecting the real backend

Checklist, in order:

1. **Set env vars** in `.env.local`:
   - `NEXT_PUBLIC_USE_MOCKS=false`
   - `NEXT_PUBLIC_API_BASE_URL=<backend url>`
   - `NEXT_PUBLIC_CONTRACT_ID=<deployed testnet contract>`
   - `NEXT_PUBLIC_EXPLORER_TX_URL` (VERIFY the URL pattern; default is `https://testnet.nearblocks.io/txns/`)
2. **Run the check script:** `npm run check:mocks`. It prints every `@mock-remove` or `MOCK_` hit outside `src/mocks/`.
3. **Delete `src/mocks/`.**
4. **Remove every `// @mock-remove-start` … `// @mock-remove-end` block** the script listed (currently `src/lib/api/index.ts` and `src/lib/near/contract.ts`). Leftover code keeps working: `api` falls back to the real client.
5. **Confirm the MOCK badges are gone.** They render only while `NEXT_PUBLIC_USE_MOCKS=true`, so with mocks off none should appear. The demo banner disappears too.
6. **Align the contract.** Edit `src/lib/near/contract.ts` (`register_insight`, `reserve_fee`) to the deployed method names and argument shapes. Currently marked `PROPOSED`.
7. **Pick the auth scheme.** Resolve `TODO(backend): auth scheme` in `src/lib/api/client.ts`. Today only an `X-Near-Account` header is sent, which is not authentication.
8. **Test each page against the real API:**
   - `/` stats and live board load
   - `/gallery` filters, cursor pagination, empty and error states
   - `/gallery/[id]` borrow: wallet reserve, key shown once
   - `/keys` list, drawer, Test retrieval with a real key, Revoke
   - `/payouts` earnings, receipts, My insights, payout account edit
   - `/keys` creator setup: wallet → create API key (shown once) → MCP connected status
   - `/publish` 4 steps: connect, pick an export, define (expiry, fee), register on NEAR
   - `/keys` borrow drawer: Test retrieval then Report trade executed charges once
9. Compare responses with `docs/API_CONTRACT.md` and update `src/lib/api/types.ts` where the backend differs. Types are the contract.

## Also confirm with the backend
- The `condex-mcp` package name and `claude mcp add` command in `src/components/keys/creator-setup.tsx` are placeholders.
- How retrieval reaches the creator's MCP server, and what happens when it is offline.
- That "trade executed" is self-reported by the borrowing agent. Decide whether anything should verify it.
