import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { type Db, openDb, wipeDb } from "../db.ts";
import { ApiError, forbidden, notFound, unauthorized } from "../errors.ts";
import { type ExecutionVenue, SimulatedVenue } from "../execution/venue.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { MockLedger } from "../ledger/mockLedger.ts";
import { type Principal, accountView, authenticate, createAccount, issueKey, listKeys, revokeKey } from "../services/accounts.ts";
import { getPreview, listPreviews, publishInsight, publishVersion, readInsight } from "../services/insights.ts";
import { createQuote, getOrder, listOrders, placeOrder } from "../services/orders.ts";
import { type EventType, getReceipt, ingestEvent, listReceipts, replayEvent, simulate } from "../services/settlement.ts";
import { amount, parseNear } from "../util.ts";
import {
  createAccountBody, depositBody, executionEventBody, issueKeyBody, orderBody, parse, publishBody, quoteBody, simBody,
} from "./schemas.ts";

const TEST_PAGE = fileURLToPath(new URL("../../public/test.html", import.meta.url));

const SIM_ACTIONS: Record<string, EventType> = {
  fill: "fill", cancel: "cancelled", reject: "rejected", expire: "expired", unknown: "status_unknown",
};

export interface AppDeps {
  db?: Db;
  ledger?: Ledger;
  venue?: ExecutionVenue;
}

export function createApp(config: Config, deps: AppDeps = {}) {
  const db = deps.db ?? openDb(config.dbPath);
  const ctx: Ctx = {
    config,
    db,
    ledger: deps.ledger ?? new MockLedger(db),
    venue: deps.venue ?? new SimulatedVenue(),
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const auth = (req: Request): Principal => {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return authenticate(ctx, match?.[1]);
  };

  const requireExecutionSecret = (req: Request) => {
    const given = Buffer.from(req.get("x-execution-secret") ?? "");
    const expected = Buffer.from(config.executionSecret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw unauthorized("Missing or invalid X-Execution-Secret");
    }
  };

  const devOnly = (_req: Request, _res: Response, next: NextFunction) => {
    if (!config.devMode) return next(notFound("Route"));
    next();
  };

  // ---- meta ----
  app.get("/health", (_req, res) => {
    res.json({ ok: true, ledger: ctx.ledger.kind, venue: ctx.venue.name, dev_mode: config.devMode });
  });

  // ---- accounts and keys ----
  app.post("/v1/accounts", (req, res) => {
    const body = parse(createAccountBody, req.body);
    res.status(201).json(createAccount(ctx, { nearAccountId: body.near_account_id, displayName: body.display_name }));
  });

  app.get("/v1/me", (req, res) => {
    const p = auth(req);
    res.json({ account: accountView(p.account), key: { id: p.keyId, scopes: p.scopes, token_ids: p.tokenIds } });
  });

  app.post("/v1/keys", (req, res) => {
    const p = auth(req);
    const body = parse(issueKeyBody, req.body);
    res.status(201).json(issueKey(ctx, p, {
      scopes: body.scopes, label: body.label, tokenIds: body.token_ids ?? null, expiresInSeconds: body.expires_in_seconds ?? null,
    }));
  });

  app.get("/v1/keys", (req, res) => {
    res.json({ keys: listKeys(ctx, auth(req)) });
  });

  app.delete("/v1/keys/:keyId", (req, res) => {
    res.json(revokeKey(ctx, auth(req), req.params.keyId!));
  });

  // ---- insights ----
  const toPublishInput = (body: ReturnType<typeof parse<typeof publishBody>>) => ({
    title: body.title,
    market: body.market ?? null,
    summary: body.summary ?? null,
    expiresAt: body.expires_at ?? null,
    feeNear: body.fee_near,
    payoutAccount: body.payout_account ?? null,
    messages: body.messages,
  });

  app.post("/v1/insights", (req, res) => {
    const p = auth(req);
    res.status(201).json(publishInsight(ctx, p, toPublishInput(parse(publishBody, req.body))));
  });

  app.post("/v1/insights/:insightId/versions", (req, res) => {
    const p = auth(req);
    res.status(201).json(publishVersion(ctx, p, req.params.insightId!, toPublishInput(parse(publishBody, req.body))));
  });

  // Public catalogue: previews only.
  app.get("/v1/tokens", (req, res) => {
    const creatorId = typeof req.query.creator_id === "string" ? req.query.creator_id : undefined;
    const market = typeof req.query.market === "string" ? req.query.market : undefined;
    res.json({ tokens: listPreviews(ctx, { creatorId, market }) });
  });

  app.get("/v1/tokens/:tokenId/preview", (req, res) => {
    res.json(getPreview(ctx, req.params.tokenId!));
  });

  // Full conversation: needs a read-scoped key. Always free.
  app.get("/v1/tokens/:tokenId", (req, res) => {
    res.json(readInsight(ctx, auth(req), req.params.tokenId!));
  });

  // ---- trading ----
  app.post("/v1/quotes", (req, res) => {
    const p = auth(req);
    res.status(201).json(createQuote(ctx, p, parse(quoteBody, req.body).token_id));
  });

  app.post("/v1/orders", (req, res) => {
    const p = auth(req);
    const body = parse(orderBody, req.body);
    res.status(201).json(placeOrder(ctx, p, {
      quoteId: body.quote_id, side: body.side, quantity: body.quantity, market: body.market ?? null,
      limitPrice: body.limit_price ?? null, authoriseFee: body.authorise_fee,
    }));
  });

  app.get("/v1/orders", (req, res) => {
    res.json({ orders: listOrders(ctx, auth(req)) });
  });

  app.get("/v1/orders/:orderId", (req, res) => {
    res.json(getOrder(ctx, auth(req), req.params.orderId!));
  });

  app.get("/v1/receipts", (req, res) => {
    res.json({ receipts: listReceipts(ctx, auth(req)) });
  });

  app.get("/v1/receipts/:receiptId", (req, res) => {
    res.json(getReceipt(ctx, req.params.receiptId!));
  });

  // ---- execution integration (trusted service) ----
  app.post("/v1/execution/events", (req, res) => {
    requireExecutionSecret(req);
    const body = parse(executionEventBody, req.body);
    const out = ingestEvent(ctx, {
      eventId: body.event_id, orderId: body.order_id, type: body.type, quantity: body.quantity ?? null,
      price: body.price ?? null, source: body.source,
    });
    res.status(out.replayed ? 200 : 201).json(out);
  });

  app.post("/v1/execution/events/:eventId/replay", (req, res) => {
    requireExecutionSecret(req);
    res.json(replayEvent(ctx, req.params.eventId!));
  });

  // ---- ledger (public reads; deposit only on the mock ledger) ----
  app.get("/v1/ledger/balances/:account", (req, res) => {
    const b = ctx.ledger.balanceOf(req.params.account!);
    res.json({
      ledger: ctx.ledger.kind, account: b.account,
      available: amount(b.availableYocto), reserved: amount(b.reservedYocto), earned: amount(b.earnedYocto),
    });
  });

  app.get("/v1/ledger/txs", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    res.json({ ledger: ctx.ledger.kind, txs: ctx.ledger.listTxs(limit) });
  });

  app.post("/v1/ledger/deposit", (req, res) => {
    const p = auth(req);
    if (ctx.ledger.kind !== "mock") throw forbidden("deposit_on_chain", "Deposit test NEAR through the NEAR contract instead");
    const yocto = parseNear(parse(depositBody, req.body).amount_near, "amount_near");
    const { tx } = ctx.ledger.deposit(p.account.near_account_id, yocto);
    const b = ctx.ledger.balanceOf(p.account.near_account_id);
    res.status(201).json({
      ledger: ctx.ledger.kind, tx, account: b.account,
      available: amount(b.availableYocto), reserved: amount(b.reservedYocto), earned: amount(b.earnedYocto),
    });
  });

  // ---- dev / simulation (disabled unless CONDEX_DEV_MODE=true) ----
  app.post("/v1/sim/orders/:orderId/:action", devOnly, (req, res) => {
    const type = SIM_ACTIONS[req.params.action as string];
    if (!type) throw notFound(`Simulation action "${req.params.action}"`);
    const body = parse(simBody, req.body);
    res.status(201).json(simulate(ctx, req.params.orderId as string, type, body));
  });

  app.post("/v1/sim/events/:eventId/replay", devOnly, (req, res) => {
    res.json(replayEvent(ctx, req.params.eventId as string));
  });

  app.post("/v1/dev/reset", devOnly, (_req, res) => {
    wipeDb(ctx.db);
    res.json({ ok: true });
  });

  app.get("/test", devOnly, (_req, res) => {
    res.sendFile(TEST_PAGE);
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "ConDex API",
      ledger: ctx.ledger.kind,
      test_page: config.devMode ? "/test" : null,
    });
  });

  // ---- errors ----
  app.use((_req: Request, _res: Response, next: NextFunction) => next(notFound("Route")));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "invalid_json", message: "Request body is not valid JSON" } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
  });

  return { app, ctx };
}
