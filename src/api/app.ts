import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Config } from "../config.ts";
import type { Ctx } from "../context.ts";
import { type Db, openDb, wipeDb } from "../db.ts";
import { ApiError, badRequest, forbidden, notFound, unauthorized } from "../errors.ts";
import { ClaudeExpiryEvaluator } from "../ai/claudeExpiry.ts";
import { LlmExpiryEvaluator } from "../ai/llmExpiry.ts";
import { type ExecutionVenue, SimulatedVenue } from "../execution/venue.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { MockLedger } from "../ledger/mockLedger.ts";
import { type MarketData, SimulatedMarketData } from "../market/marketData.ts";
import { NearChain } from "../near/chain.ts";
import { type ChainClient, NearRpcClient } from "../near/chainClient.ts";
import { type AccessKeyChecker, NoAccessKeyCheck, RpcAccessKeyChecker } from "../near/accessKeys.ts";
import { MCP_TOOLS, buildMcpServer } from "../mcp/server.ts";
import { displayPath, findClaudeCli } from "../mcp/claudeCli.ts";
import { type MessageSigner, NearCliError, NearCliSigner, findNearCli } from "../near/nearCli.ts";
import {
  type Principal, accountView, assertNearAccountId, authenticate, issueKey, listKeys, requireSession, revokeKey, updateDisplayName,
} from "../services/accounts.ts";
import { createChallenge, signOut, verifySignIn } from "../services/auth.ts";
import type { ExpiryEvaluator } from "../services/expiry.ts";
import {
  getPreview, listPreviews, publishInsight, publishVersion, publisherProfile, readInsight, thesisProof,
} from "../services/insights.ts";
import { confirmApproval, createQuote, getOrder, listOrders, placeOrder } from "../services/orders.ts";
import { closeTrade, getClosingOrder } from "../services/trades.ts";
import { type EventType, getReceipt, ingestEvent, listReceipts, replayEvent, simulate } from "../services/settlement.ts";
import { startEvaluationSweep } from "../services/evaluationSweep.ts";
import { subscribe, subscriptionStatus } from "../services/subscriptions.ts";
import { amount, parseNear } from "../util.ts";
import { assertSameMachine, isSameMachine } from "./local.ts";
import {
  closeBody, depositBody, executionEventBody, issueKeyBody, nearCliConnectBody, orderBody, parse, publishBody, quoteBody, simBody,
  simPriceBody, updateMeBody, verifySignInBody,
} from "./schemas.ts";

const TEST_PAGE = fileURLToPath(new URL("../../public/test.html", import.meta.url));
const MCP_SERVER_PATH = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));

const SIM_ACTIONS: Record<string, EventType> = {
  fill: "fill", cancel: "cancelled", reject: "rejected", expire: "expired", unknown: "status_unknown", close: "close",
};

export interface AppDeps {
  db?: Db;
  ledger?: Ledger;
  venue?: ExecutionVenue;
  market?: MarketData;
  accessKeys?: AccessKeyChecker;
  /** Signer for one-click near-cli sign-in. Defaults to near-cli-rs if found (dev mode only); null disables it. */
  nearCli?: MessageSigner | null;
  /** The NEAR client when CONDEX_LEDGER=near. Defaults to RPC with the configured keys; tests pass a stand-in. */
  chainClient?: ChainClient;
  /** Whether to send queued NEAR calls in the background. Tests turn it off and call ctx.chain.sender.drain(). */
  startChainSender?: boolean;
  /** ConDex's AI, which sets the expiry of a thesis published without one. Defaults to the configured model; null turns it off. */
  expiryAi?: ExpiryEvaluator | null;
}

function configuredExpiryAi(config: Config): ExpiryEvaluator | null {
  if (config.expiryAi === "llm" && config.llm) return new LlmExpiryEvaluator(config.llm);
  if (config.expiryAi === "claude") return new ClaudeExpiryEvaluator();
  return null;
}

export function createApp(config: Config, deps: AppDeps = {}) {
  const db = deps.db ?? openDb(config.dbPath);
  const nearCliBinary = deps.nearCli === undefined && config.devMode ? findNearCli() : null;
  const chain = config.ledger === "near" && config.near
    ? new NearChain(db, deps.chainClient ?? new NearRpcClient(config.near.contractId, config.nearRpcUrl), config.near)
    : null;
  const ctx: Ctx = {
    config,
    db,
    chain,
    ledger: deps.ledger ?? chain?.ledger ?? new MockLedger(db),
    venue: deps.venue ?? new SimulatedVenue(),
    market: deps.market ?? new SimulatedMarketData(db),
    accessKeys: deps.accessKeys
      ?? (config.walletKeyCheck === "none" ? new NoAccessKeyCheck() : new RpcAccessKeyChecker(config.nearRpcUrl)),
    mcp: new Map(),
    expiryAi: deps.expiryAi !== undefined ? deps.expiryAi : configuredExpiryAi(config),
    expiryAiUse: new Map(),
    nearCli: !config.devMode ? null : deps.nearCli !== undefined ? deps.nearCli : nearCliBinary ? new NearCliSigner(nearCliBinary) : null,
  };

  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy, take the client address from X-Forwarded-For so sign-in limits apply per user.
  if (config.trustProxyHops > 0) app.set("trust proxy", config.trustProxyHops);
  app.use(express.json({ limit: "1mb" }));

  /** The caller's address, used to limit sign-in attempts per client. */
  const clientAddress = (req: Request) => (req.ip ?? req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");

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

  /**
   * Dev routes exist only in dev mode, and only for this computer: they wipe data, drive the simulated
   * venue and sign in with this computer's wallet, so other machines, other websites and tunnels are refused.
   */
  const devOnly = (req: Request, _res: Response, next: NextFunction) => {
    if (!config.devMode) return next(notFound("Route"));
    try {
      assertSameMachine(req);
    } catch (err) {
      return next(err);
    }
    next();
  };

  // ---- meta ----
  app.get("/health", (req, res) => {
    res.json({
      ok: true, ledger: ctx.ledger.kind, venue: ctx.venue.name, dev_mode: config.devMode,
      near_network: config.nearNetwork, wallet_key_check: ctx.accessKeys.mode,
      storage: config.dbPath === ":memory:" ? "memory" : "file",
      // Whether ConDex's AI sets the expiry of a thesis published without one (otherwise its default applies).
      expiry_ai: ctx.expiryAi !== null,
      // Only for the test console on this computer: lets it print a ready-to-paste `claude mcp add`
      // command. The home folder is shown as $HOME, and the path is never sent to another machine.
      ...(config.devMode && isSameMachine(req) ? { mcp_server: displayPath(MCP_SERVER_PATH) } : {}),
    });
  });

  // ---- connect wallet (NEP-413 sign-in) ----
  // Without a wallet session a visitor can only use the public routes: publisher pages and token previews.
  app.post("/v1/auth/challenge", (req, res) => {
    res.status(201).json(createChallenge(ctx, clientAddress(req)));
  });

  app.post("/v1/auth/verify", async (req, res) => {
    const body = parse(verifySignInBody, req.body);
    res.status(201).json(await verifySignIn(ctx, {
      accountId: body.account_id, publicKey: body.public_key, signature: body.signature, nonce: body.nonce,
      callbackUrl: body.callback_url ?? null, displayName: body.display_name ?? null,
    }));
  });

  app.post("/v1/auth/logout", (req, res) => {
    const p = auth(req);
    requireSession(p);
    res.json(signOut(ctx, p.keyId));
  });

  // ---- one-click connect with this computer's near-cli wallet (dev mode only) ----
  // The server signs ConDex's own challenge with near-cli. Callers pick the account, never the message,
  // so this cannot be used to sign anything else. devOnly limits it to this computer.
  app.get("/v1/dev/wallet/near-cli", devOnly, (_req, res) => {
    res.json({ available: ctx.nearCli !== null, network: config.nearNetwork });
  });

  app.post("/v1/dev/wallet/near-cli", devOnly, async (req, res) => {
    if (!ctx.nearCli) {
      throw new ApiError(501, "near_cli_unavailable",
        "near-cli was not found on the computer running ConDex. Install it with: npm install -g near-cli-rs");
    }
    const accountId = parse(nearCliConnectBody, req.body).account_id.trim().toLowerCase();
    assertNearAccountId(accountId, "account_id");
    const challenge = createChallenge(ctx, clientAddress(req));
    let signed;
    try {
      signed = await ctx.nearCli.sign({
        accountId, message: challenge.message, nonce: Buffer.from(challenge.nonce, "base64"),
        recipient: challenge.recipient, network: challenge.network,
      });
    } catch (err) {
      const reason = err instanceof NearCliError ? err.message : String(err);
      const hint = /no access keys found in keychain/i.test(reason)
        ? ` near-cli has no key for ${accountId} on ${challenge.network} in this computer's keychain. Import it with: near account import-account`
        : "";
      throw new ApiError(502, "near_cli_failed", `near-cli could not sign in as ${accountId}: ${reason}.${hint}`);
    }
    if (signed.accountId !== accountId) {
      throw new ApiError(502, "near_cli_failed", `near-cli signed as ${signed.accountId} instead of ${accountId}`);
    }
    res.status(201).json(await verifySignIn(ctx, {
      accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: challenge.nonce,
    }));
  });

  app.get("/v1/me", (req, res) => {
    const p = auth(req);
    res.json({ account: accountView(p.account), credential: { type: p.via, id: p.keyId, scopes: p.scopes, token_ids: p.tokenIds } });
  });

  app.patch("/v1/me", (req, res) => {
    res.json(updateDisplayName(ctx, auth(req), parse(updateMeBody, req.body).display_name));
  });

  // ---- API keys for agents and MCP (wallet session only) ----

  app.post("/v1/keys", (req, res) => {
    const p = auth(req);
    const body = parse(issueKeyBody, req.body);
    res.status(201).json(issueKey(ctx, p, {
      scopes: body.scopes, label: body.label, tokenIds: body.token_ids ?? null, expiresInSeconds: body.expires_in_seconds ?? null,
    }));
  });

  app.get("/v1/keys", (req, res) => {
    res.json({ keys: listKeys(ctx, auth(req)).map((k) => ({ ...k, mcp: ctx.mcp.get(k.id) ?? null })) });
  });

  // ---- MCP: what an agent gets, and proof that Claude Code connected ----
  buildMcpServer({ apiUrl: "http://localhost", apiKey: undefined }); // fills MCP_TOOLS
  app.get("/v1/mcp/tools", (_req, res) => {
    res.json({ tools: MCP_TOOLS });
  });

  // Sent by the MCP server when Claude Code starts it. Only an API key can say hello, so the console's
  // "connected" light means a real agent process is using that key, not just that the key exists.
  app.post("/v1/mcp/hello", (req, res) => {
    const p = auth(req);
    if (p.via !== "api_key") throw badRequest("api_key_required", "Say hello with the MCP key, not a wallet session");
    const body = (req.body ?? {}) as { client?: unknown; tools?: unknown };
    const now = new Date().toISOString();
    const prev = ctx.mcp.get(p.keyId);
    ctx.mcp.set(p.keyId, {
      connectedAt: prev?.connectedAt ?? now,
      lastSeenAt: now,
      client: typeof body.client === "string" ? body.client.slice(0, 40) : "mcp",
      tools: Array.isArray(body.tools) ? body.tools.filter((t): t is string => typeof t === "string").slice(0, 50) : [],
    });
    res.json({ ok: true, account: p.account.near_account_id, scopes: p.scopes });
  });

  // Disconnect Claude Code: revoke this account's MCP keys. The agent keeps its config but every call now fails.
  app.post("/v1/mcp/disconnect", (req, res) => {
    const p = auth(req);
    requireSession(p);
    const keys = listKeys(ctx, p).filter((k) => !k.revoked_at && (k.label === "MCP agent" || ctx.mcp.has(k.id)));
    for (const k of keys) {
      revokeKey(ctx, p, k.id);
      ctx.mcp.delete(k.id);
    }
    res.json({ revoked: keys.length });
  });

  // Dev mode, this computer only: where is the Claude Code CLI? Helps when a terminal says "command not found: claude".
  app.get("/v1/dev/claude-cli", devOnly, (req, res) => {
    assertSameMachine(req);
    res.json(findClaudeCli());
  });

  app.delete("/v1/keys/:keyId", (req, res) => {
    const view = revokeKey(ctx, auth(req), req.params.keyId!);
    ctx.mcp.delete(req.params.keyId!); // a revoked key is no longer a connected agent
    res.json(view);
  });

  // ---- insights ----
  const toPublishInput = (body: ReturnType<typeof parse<typeof publishBody>>) => ({
    title: body.title,
    market: body.market,
    direction: body.direction,
    entry: body.entry,
    invalidation: body.invalidation,
    target: body.target || null,
    entryPrice: body.entry_price || null,
    invalidationPrice: body.invalidation_price || null,
    targetPrice: body.target_price || null,
    summary: body.summary ?? null,
    // An empty string (an empty form field) means "not given".
    expiryDate: body.expiry_date || null,
    expiryTime: body.expiry_time || null,
    expiresAt: body.expires_at || null,
    evaluationDeadline: body.evaluation_deadline || null,
    feeNear: body.fee_near,
    payoutAccount: body.payout_account ?? null,
    messages: body.messages,
  });

  app.post("/v1/insights", async (req, res) => {
    const p = auth(req);
    res.status(201).json(await publishInsight(ctx, p, toPublishInput(parse(publishBody, req.body))));
  });

  app.post("/v1/insights/:insightId/versions", async (req, res) => {
    const p = auth(req);
    res.status(201).json(await publishVersion(ctx, p, req.params.insightId!, toPublishInput(parse(publishBody, req.body))));
  });

  // ---- subscription: unlocks every full thesis (trading needs none); the fee goes to ConDex ----
  app.post("/v1/subscription", (req, res) => {
    res.status(201).json(subscribe(ctx, auth(req)));
  });

  /** On NEAR, the subscription is read from the contract before a service checks it. */
  const refreshSubscription = async (p: Principal) => {
    if (ctx.chain) await ctx.chain.refreshSubscription(p.account.near_account_id);
  };

  app.get("/v1/subscription", async (req, res) => {
    const p = auth(req);
    await refreshSubscription(p);
    res.json(subscriptionStatus(ctx, p));
  });

  // ---- public (no wallet needed): publisher details and abstracts only ----
  app.get("/v1/publishers/:nearAccountId", (req, res) => {
    res.json(publisherProfile(ctx, req.params.nearAccountId!));
  });

  app.get("/v1/tokens", (req, res) => {
    const creatorId = typeof req.query.creator_id === "string" ? req.query.creator_id : undefined;
    const market = typeof req.query.market === "string" ? req.query.market : undefined;
    res.json({ tokens: listPreviews(ctx, { creatorId, market }) });
  });

  app.get("/v1/tokens/:tokenId/preview", (req, res) => {
    res.json(getPreview(ctx, req.params.tokenId!));
  });

  // Proof of thesis and every proof of trade linked to it. Public, and never includes the conversation.
  app.get("/v1/tokens/:tokenId/proof", (req, res) => {
    res.json(thesisProof(ctx, req.params.tokenId!));
  });

  // Full conversation and conditions: needs a read-scoped key and an active subscription (or being the creator).
  app.get("/v1/tokens/:tokenId", async (req, res) => {
    const p = auth(req);
    await refreshSubscription(p);
    res.json(readInsight(ctx, p, req.params.tokenId!));
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

  // Closes the borrower's open position with a closing order on the opposite side. No fee, and it is
  // allowed after the thesis expired.
  app.post("/v1/orders/:orderId/close", (req, res) => {
    const p = auth(req);
    const body = parse(closeBody, req.body);
    res.status(201).json(closeTrade(ctx, p, req.params.orderId!, { quantity: body.quantity ?? null, limitPrice: body.limit_price ?? null }));
  });

  app.get("/v1/closing-orders/:closingId", (req, res) => {
    res.json(getClosingOrder(ctx, auth(req), req.params.closingId!));
  });

  app.get("/v1/orders", (req, res) => {
    res.json({ orders: listOrders(ctx, auth(req)) });
  });

  // On NEAR: after the trader signed reserve_fee, ConDex checks it on the contract and submits the order.
  app.post("/v1/orders/:orderId/confirm-approval", async (req, res) => {
    res.json(await confirmApproval(ctx, auth(req), req.params.orderId!));
  });

  app.get("/v1/orders/:orderId", (req, res) => {
    res.json(getOrder(ctx, auth(req), req.params.orderId!));
  });

  app.get("/v1/receipts", (req, res) => {
    res.json({ receipts: listReceipts(ctx, auth(req)) });
  });

  app.get("/v1/receipts/:receiptId", (req, res) => {
    res.json(getReceipt(ctx, auth(req), req.params.receiptId!));
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

  // ---- ledger (public reads, like a NEAR explorer: this mirrors what will be public on chain;
  // deposit only on the mock ledger) ----
  app.get("/v1/ledger/balances/:account", async (req, res) => {
    // On NEAR the balances live in the contract (balance_of); the mock keeps its own.
    const b = ctx.chain
      ? { account: req.params.account!, ...(await ctx.chain.balanceOf(req.params.account!)) }
      : ctx.ledger.balanceOf(req.params.account!);
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

  // Prices for the simulated market data feed, which theses are evaluated against after their deadline.
  app.post("/v1/sim/market/:market/prices", devOnly, (req, res) => {
    if (!(ctx.market instanceof SimulatedMarketData)) {
      throw forbidden("not_simulated", "Prices can only be recorded on the simulated market data feed");
    }
    const body = parse(simPriceBody, req.body);
    res.status(201).json({
      source: ctx.market.name,
      ...ctx.market.record(req.params.market as string, body.price, body.at ? new Date(body.at).toISOString() : new Date().toISOString()),
    });
  });

  app.post("/v1/sim/events/:eventId/replay", devOnly, (req, res) => {
    res.json(replayEvent(ctx, req.params.eventId as string));
  });

  app.post("/v1/dev/reset", devOnly, (_req, res) => {
    wipeDb(ctx.db);
    ctx.expiryAiUse.clear();
    res.json({ ok: true });
  });

  app.get("/test", devOnly, (_req, res) => {
    res.set("Cache-Control", "no-store"); // always the current console, never a copy left in the browser
    res.sendFile(TEST_PAGE);
  });

  app.get("/", (_req, res) => {
    res.json({
      name: "ConDex API",
      ledger: ctx.ledger.kind,
      test_page: config.devMode ? "/test" : null,
    });
  });

  // The calls ConDex signs on NEAR, with their status (queued, sent with a tx hash, or failed with the reason).
  app.get("/v1/chain/outbox", devOnly, (_req, res) => {
    if (!ctx.chain) throw notFound("Chain outbox (ConDex is on the mock ledger)");
    res.json({ contract: ctx.chain.client.contractId, calls: ctx.db.prepare("SELECT * FROM chain_outbox ORDER BY seq DESC LIMIT 200").all() });
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

  if (chain && deps.startChainSender !== false) {
    chain.sender.start();
    // Expired theses are evaluated, and their evaluation sent to their token, without anyone opening them.
    startEvaluationSweep(ctx);
    // Read the subscription terms once, so the free abstract can show them before anyone subscribes.
    chain.refreshSubscription(chain.client.contractId, true).catch((err) => console.error(`NEAR: could not read the subscription terms: ${String(err)}`));
  }

  return { app, ctx };
}
