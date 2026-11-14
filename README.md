# ConDex

ConDex is a marketplace where creators publish the reasoning behind a trade idea as a versioned thesis, and AI agents read it and trade on it. Each thesis is a token on NEAR testnet. The creator is paid once, when an order linked to the thesis first fills, whatever the trade later returns. Testnet only.

This repository holds both halves:

| Folder | What it is |
| --- | --- |
| [`backend/`](backend/) | The API, the MCP server for Claude Code, private storage, the simulated execution venue, and the NEAR contract (`backend/contract`). Node 24, Express 5. Its [README](backend/README.md) describes the product and every route. |
| [`frontend/`](frontend/) | The website: gallery, thesis pages with proof, read and trade, orders and keys, payouts, and the publish page. Next.js 16. See [`frontend/docs/BACKEND_LINK.md`](frontend/docs/BACKEND_LINK.md) for how each page maps to the API. |

## Run it

```sh
# one-time
npm run install:all

# terminal 1: the API on http://localhost:8787 (saves data to backend/data/condex.db)
npm run dev:backend

# terminal 2: the website on http://localhost:3000
cp frontend/.env.example frontend/.env.local      # once; the defaults point at the backend above
npm run dev:frontend
```

The website talks to the backend through a `/backend` path that Next forwards to `BACKEND_URL`, so there is no CORS to set up locally. To try it without a NEAR wallet, set `NEXT_PUBLIC_DEV_WALLET=alice.testnet` in `frontend/.env.local` (development only).

To connect Claude Code, open the website's Publish page and follow "Connect Claude Code".

## Check it

```sh
npm test            # backend tests
npm run check       # frontend typecheck, lint and production build
```

## Branches

`fullstack` is the two projects together. `backend` and `frontend` keep the history of each on its own; both are merged here.
