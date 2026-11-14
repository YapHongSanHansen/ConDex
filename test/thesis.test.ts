import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { ClaudeExpiryEvaluator, EXPIRY_MODEL, type ExpiryAiClient } from "../src/ai/claudeExpiry.ts";
import {
  AI_EVALUATIONS_PER_HOUR, DEFAULT_EXPIRY_DAYS, type ExpiryEvaluation, type ExpiryEvaluator, type ThesisForExpiry,
} from "../src/services/expiry.ts";
import { canonicalJson, sha256Hex } from "../src/util.ts";
import { ETH_MESSAGES, ETH_THESIS, futureDate, placeOrder, setupAliceAndBob, startServer } from "./helpers.ts";

type Server = Awaited<ReturnType<typeof startServer>>;
type Keys = Awaited<ReturnType<typeof setupAliceAndBob>>;
type LedgerTx = { method: string; args: Record<string, string> };

/** ETH_THESIS with no expiry, so ConDex has to set one. */
const { expiry_date: _expiryDate, ...UNDATED } = ETH_THESIS;

const mintOf = async (srv: Server, tokenId: string) =>
  ((await srv.api("GET", "/v1/ledger/txs?limit=500")).body.txs as LedgerTx[])
    .find((t) => t.method === "mint_insight_token" && t.args.token_id === tokenId)!;

const srv = await startServer();
const { api } = srv;
let s: Keys;
after(() => srv.close());
beforeEach(async () => {
  await api("POST", "/v1/dev/reset");
  s = await setupAliceAndBob(api);
});

const publish = (body: Record<string, unknown>) => api("POST", "/v1/insights", { key: s.alicePublish, body });
const balance = async (account: string) => (await api("GET", `/v1/ledger/balances/${account}`)).body;

describe("thesis conditions", () => {
  test("are recorded, served to connected readers and kept out of the public preview", async () => {
    const conditions = {
      market: "ETH-USD", direction: "short", entry: ETH_THESIS.entry, invalidation: ETH_THESIS.invalidation, target: ETH_THESIS.target,
      entry_price: null, invalidation_price: null, target_price: null,
    };
    assert.deepEqual(s.published.body.conditions, conditions);

    // Anyone can see the market and direction. The creator's entry, invalidation and target are not public.
    for (const pub of [
      (await api("GET", `/v1/tokens/${s.tokenId}/preview`)).body,
      (await api("GET", "/v1/tokens")).body.tokens[0],
      (await api("GET", "/v1/publishers/alice.testnet")).body.tokens[0],
    ]) {
      assert.equal(pub.market, "ETH-USD");
      assert.equal(pub.direction, "short");
      assert.equal(pub.conditions, undefined);
      const text = JSON.stringify(pub);
      for (const secret of [ETH_THESIS.entry, ETH_THESIS.invalidation, ETH_THESIS.target]) assert.equal(text.includes(secret), false);
    }

    const read = (await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).body;
    assert.deepEqual(read.conditions, conditions);
  });

  test("market, direction, entry and invalidation are required; the target is optional", async () => {
    for (const field of ["market", "direction", "entry", "invalidation"]) {
      const r = await publish({ ...ETH_THESIS, [field]: undefined });
      assert.equal(r.status, 400, field);
      assert.equal(r.body.error.code, "invalid_request");
      assert.match(r.body.error.message, new RegExp(`${field}: `), "the error names the missing condition");
    }
    assert.equal((await publish({ ...ETH_THESIS, direction: "sideways" })).status, 400);
    assert.equal((await publish({ ...ETH_THESIS, entry: "   " })).status, 400);
    assert.equal((await api("GET", "/v1/tokens")).body.tokens.length, 1, "nothing was published by the refused requests");

    const noTarget = await publish({ ...ETH_THESIS, target: undefined });
    assert.equal(noTarget.status, 201);
    assert.equal(noTarget.body.conditions.target, null);
  });

  test("a reader can recompute the fingerprint, which covers the conditions and the expiry", async () => {
    const read = (await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).body;
    const rebuilt = sha256Hex(canonicalJson({
      token_id: read.token_id, insight_id: read.insight_id, version: read.version, title: read.title, summary: read.summary,
      conditions: read.conditions,
      expiry: {
        expires_at: read.expiry.expires_at, evaluation_deadline: read.expiry.evaluation_deadline, time_given: read.expiry.time_given,
        set_by: read.expiry.set_by, reason: read.expiry.reason,
      },
      messages: read.messages,
    }));
    assert.equal(rebuilt, read.content_hash);
    assert.equal((await mintOf(srv, s.tokenId)).args.content_hash, rebuilt, "and it is the fingerprint on the ledger");
    // The server makes the same check on every read.
    assert.deepEqual(read.integrity, { content_hash: rebuilt, recomputed_hash: rebuilt, matches: true });
  });

  test("a published version keeps its conditions and expiry when a new version changes them", async () => {
    const before = (await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).body;
    const v2 = await api("POST", `/v1/insights/${before.insight_id}/versions`, {
      key: s.alicePublish,
      body: { ...ETH_THESIS, direction: "long", invalidation: "A daily close below the range low.", expiry_date: futureDate(30) },
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.conditions.direction, "long");
    assert.notEqual(v2.body.expires_at, before.expires_at);

    const after = (await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead })).body;
    assert.deepEqual(after.conditions, before.conditions);
    assert.deepEqual(after.expiry, before.expiry);
    assert.equal(after.content_hash, before.content_hash);
  });
});

describe("expiry", () => {
  test("a date alone expires at the end of that day (UTC); a time is used when the thesis depends on one", async () => {
    const day = futureDate(3);
    const dateOnly = (await publish({ ...ETH_THESIS, expiry_date: day })).body;
    assert.equal(dateOnly.expires_at, `${day}T23:59:59.000Z`);
    assert.deepEqual(dateOnly.expiry, {
      expires_at: `${day}T23:59:59.000Z`, evaluation_deadline: `${day}T23:59:59.000Z`, date: day, time: "23:59:59", time_given: false, set_by: "creator", reason: null,
    });
    assert.equal(dateOnly.notice, undefined, "no notice when the creator set the expiry");

    const timed = (await publish({ ...ETH_THESIS, expiry_date: day, expiry_time: "13:30" })).body;
    assert.equal(timed.expires_at, `${day}T13:30:00.000Z`);
    assert.equal(timed.expiry.time_given, true);
    assert.equal((await publish({ ...ETH_THESIS, expiry_date: day, expiry_time: "13:30:45" })).body.expires_at, `${day}T13:30:45.000Z`);

    // A full ISO instant is accepted in place of a date and time.
    const instant = (await publish({ ...UNDATED, expires_at: `${day}T09:15:00Z` })).body;
    assert.equal(instant.expires_at, `${day}T09:15:00.000Z`);
    assert.equal(instant.expiry.set_by, "creator");
    assert.equal(instant.expiry.time_given, true);

    // The token record on the ledger carries the publish time, the expiry and who set it.
    const mint = await mintOf(srv, timed.token_id);
    assert.equal(mint.args.issued_at, timed.created_at);
    assert.equal(mint.args.expires_at, timed.expires_at);
    assert.equal(mint.args.expiry_set_by, "creator");
  });

  test("an expiry that is malformed, impossible or already past is refused", async () => {
    const nextYear = new Date().getUTCFullYear() + 1;
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ expiry_date: "2020-01-01" }, /already passed/],
      [{ expiry_date: "next friday" }, /YYYY-MM-DD/],
      [{ expiry_date: `${nextYear}-02-30` }, /not a real calendar date/],
      [{ expiry_date: `${nextYear}-13-01` }, /not a real calendar date/],
      [{ expiry_date: futureDate(3), expiry_time: "25:00" }, /HH:MM/],
      [{ expiry_date: futureDate(3), expiry_time: "1pm" }, /HH:MM/],
      [{ expiry_date: undefined, expiry_time: "13:30" }, /needs an expiry_date/],
      [{ expiry_date: undefined, expires_at: "2020-01-01T00:00:00Z" }, /already passed/],
      [{ expiry_date: undefined, expires_at: "next friday" }, /ISO 8601/],
      [{ expires_at: `${nextYear}-01-01T00:00:00Z` }, /not both/],
    ];
    for (const [change, message] of refused) {
      const r = await publish({ ...ETH_THESIS, ...change });
      assert.equal(r.status, 400, JSON.stringify(change));
      assert.equal(r.body.error.code, "invalid_expiry");
      assert.match(r.body.error.message, message);
    }
    assert.equal((await api("GET", "/v1/tokens")).body.tokens.length, 1, "nothing was published by the refused requests");
  });

  test("without a date, and with the AI off, ConDex applies its default and says so", async () => {
    const days = [futureDate(DEFAULT_EXPIRY_DAYS)];
    const r = await publish(UNDATED);
    days.push(futureDate(DEFAULT_EXPIRY_DAYS)); // in case the test runs across midnight UTC
    assert.equal(r.status, 201);
    assert.ok(days.includes(r.body.expiry.date), `${r.body.expiry.date} should be ${DEFAULT_EXPIRY_DAYS} days ahead`);
    assert.equal(r.body.expiry.time, "23:59:59");
    assert.equal(r.body.expiry.time_given, false);
    assert.equal(r.body.expiry.set_by, "condex_default");
    assert.match(r.body.expiry.reason, /AI evaluation is not switched on.*default: the end of the day 7 days after publishing/);
    assert.match(r.body.notice, /No expiry date was given, so ConDex set it to \d{4}-\d{2}-\d{2} 23:59 UTC/);

    // Everyone can see that ConDex set it, and why: both are part of the proof of thesis.
    const preview = (await api("GET", `/v1/tokens/${r.body.token_id}/preview`)).body;
    assert.equal(preview.expiry.set_by, "condex_default");
    assert.equal(preview.expiry.reason, r.body.expiry.reason);
    assert.equal((await api("GET", `/v1/tokens/${r.body.token_id}`, { key: s.bobRead })).body.expiry.reason, r.body.expiry.reason);
    assert.equal((await mintOf(srv, r.body.token_id)).args.expiry_set_by, "condex_default");
    assert.equal((await api("GET", "/health")).body.expiry_ai, false);
  });
});

describe("ConDex's AI sets a missing expiry", () => {
  const seen: ThesisForExpiry[] = [];
  let answer: () => Promise<ExpiryEvaluation>;
  const standIn: ExpiryEvaluator = { model: "stand-in", evaluate: async (thesis) => { seen.push(thesis); return answer(); } };
  /** An answer naming a day with no time: the thesis expires at the end of it. */
  const endOf = (day: string, reason: string): ExpiryEvaluation => ({ expiresAt: `${day}T23:59:59.000Z`, timeGiven: false, reason });
  let ai: Server;
  let k: Keys;
  before(async () => { ai = await startServer({ expiryAi: standIn }); });
  after(() => ai.close());
  beforeEach(async () => {
    await ai.api("POST", "/v1/dev/reset");
    seen.length = 0;
    k = await setupAliceAndBob(ai.api);
    assert.equal(seen.length, 0, "a creator's own expiry date never reaches the AI");
  });
  const publishUndated = (key = k.alicePublish) => ai.api("POST", "/v1/insights", { key, body: UNDATED });

  test("it reads the thesis, and its answer is recorded with the reason", async () => {
    const day = futureDate(2);
    answer = async () => ({
      expiresAt: `${day}T13:30:00.000Z`, timeGiven: true, reason: "The thesis says to walk away\n if neither happens by the US open.",
    });
    const r = await publishUndated();
    assert.equal(r.status, 201);
    assert.equal(r.body.expires_at, `${day}T13:30:00.000Z`);
    assert.deepEqual(r.body.expiry, {
      expires_at: `${day}T13:30:00.000Z`, evaluation_deadline: `${day}T13:30:00.000Z`, date: day, time: "13:30:00", time_given: true, set_by: "condex_ai",
      reason: "The thesis says to walk away if neither happens by the US open.",
    });
    assert.match(r.body.notice, /so ConDex's AI set it to \d{4}-\d{2}-\d{2} 13:30 UTC/);
    assert.equal((await mintOf(ai, r.body.token_id)).args.expiry_set_by, "condex_ai");
    assert.equal((await ai.api("GET", "/health")).body.expiry_ai, true);

    assert.equal(seen.length, 1);
    const { now, ...thesis } = seen[0]!;
    assert.ok(now instanceof Date);
    assert.deepEqual(thesis, {
      title: UNDATED.title, summary: UNDATED.summary, market: "ETH-USD", direction: "short", entry: UNDATED.entry,
      invalidation: UNDATED.invalidation, target: UNDATED.target, messages: ETH_MESSAGES,
    });
  });

  test("an answer without a time expires at the end of that day", async () => {
    const day = futureDate(10);
    answer = async () => endOf(day, "A multi-day swing with no stated deadline.");
    const r = await publishUndated();
    assert.equal(r.body.expires_at, `${day}T23:59:59.000Z`);
    assert.equal(r.body.expiry.time_given, false);
    assert.equal(r.body.expiry.set_by, "condex_ai");
  });

  test("when the AI fails or answers with an unusable date, the default applies and says why", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const failures: Array<() => Promise<ExpiryEvaluation>> = [
      async () => { throw new Error("the Anthropic API could not be reached"); },
      async () => endOf("2020-01-01", "Already over."),
      async () => ({ expiresAt: "soon", timeGiven: false, reason: "No idea." }),
      async () => endOf(futureDate(45), "A long-term view."), // further out than the AI may set
    ];
    for (const failing of failures) {
      answer = failing;
      const r = await publishUndated();
      assert.equal(r.status, 201, "publishing still succeeds");
      assert.equal(r.body.expiry.set_by, "condex_default");
      assert.match(r.body.expiry.reason, /ConDex's AI could not evaluate the thesis this time, so ConDex applied its default/);
    }
    assert.equal(warn.mock.callCount(), failures.length, "each failure is logged for the operator");
  });

  test("it is not asked for callers who may not publish, or for requests that are refused anyway", async () => {
    answer = async () => endOf(futureDate(2), "x");
    assert.equal((await publishUndated(k.bobRead)).status, 403);
    assert.equal((await ai.api("POST", "/v1/insights", { key: k.alicePublish, body: { ...UNDATED, entry: undefined } })).status, 400);
    assert.equal((await ai.api("POST", "/v1/insights", { key: k.alicePublish, body: { ...UNDATED, fee_near: "abc" } })).status, 400);
    assert.equal((await ai.api("POST", "/v1/insights", { key: k.alicePublish, body: { ...UNDATED, expiry_time: "13:30" } })).status, 400);
    const bobPublish = (await ai.api("POST", "/v1/keys", { key: k.bobSession, body: { scopes: ["publish"] } })).body.secret;
    const hijack = await ai.api("POST", `/v1/insights/${k.published.body.insight_id}/versions`, { key: bobPublish, body: UNDATED });
    assert.equal(hijack.status, 403);
    assert.equal(seen.length, 0);
  });

  test("each account gets a limited number of AI evaluations an hour, then the default", async () => {
    answer = async () => endOf(futureDate(2), "Intraday setup.");
    for (let i = 0; i < AI_EVALUATIONS_PER_HOUR; i++) {
      assert.equal((await publishUndated()).body.expiry.set_by, "condex_ai");
    }
    const over = await publishUndated();
    assert.equal(over.status, 201);
    assert.equal(over.body.expiry.set_by, "condex_default");
    assert.match(over.body.expiry.reason, /used its AI evaluations for this hour/);
    assert.equal(seen.length, AI_EVALUATIONS_PER_HOUR);

    // Another account still has its own allowance.
    const bobPublish = (await ai.api("POST", "/v1/keys", { key: k.bobSession, body: { scopes: ["publish"] } })).body.secret;
    assert.equal((await publishUndated(bobPublish)).body.expiry.set_by, "condex_ai");
  });
});

describe("the Claude expiry evaluator", () => {
  const thesis: ThesisForExpiry = {
    title: "ETH failed breakout", market: "ETH-USD", direction: "short", entry: ETH_THESIS.entry,
    invalidation: ETH_THESIS.invalidation, target: null, summary: null, messages: ETH_MESSAGES,
    now: new Date("2026-11-13T09:00:00.000Z"),
  };

  /** Stands in for the Anthropic API: records the request and answers with `response` (or throws it). */
  function standInClient(response: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls: Array<{ params: any; options: any }> = [];
    const client = {
      beta: { messages: { parse: async (params: unknown, options: unknown) => {
        calls.push({ params, options });
        if (response instanceof Error) throw response;
        return response;
      } } },
    } as unknown as ExpiryAiClient;
    return { client, calls };
  }

  test("asks Claude once, with the thesis and the current time, and returns its answer", async () => {
    const { client, calls } = standInClient({
      stop_reason: "end_turn", parsed_output: { expiry_date: "2026-11-13", expiry_time: " 14:30 ", reason: "By the US open." },
    });
    const evaluator = new ClaudeExpiryEvaluator(client);
    assert.equal(evaluator.model, EXPIRY_MODEL);
    assert.deepEqual(await evaluator.evaluate(thesis), {
      expiresAt: "2026-11-13T14:30:00.000Z", timeGiven: true, reason: "By the US open.",
    });
    assert.equal(calls.length, 1);
    const { params, options } = calls[0]!;
    assert.equal(params.model, EXPIRY_MODEL);
    assert.equal(params.output_config.effort, "low");
    assert.equal(params.output_config.format.type, "json_schema");
    assert.deepEqual(params.output_config.format.schema.required, ["expiry_date", "expiry_time", "reason"]);
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(options.maxRetries, 0, "one bounded attempt, so publishing never hangs for long");
    assert.ok(options.timeout > 0 && options.timeout <= 60_000);

    const prompt: string = params.messages[0].content;
    assert.ok(prompt.includes("Current time (UTC): 2026-11-13T09:00:00.000Z (Friday)"));
    assert.ok(prompt.includes("Direction: short"));
    assert.ok(prompt.includes("Exit or target: not given"));
    assert.ok(prompt.includes(ETH_MESSAGES[1]!.content), "the whole conversation is sent, not a cut-down copy");
  });

  test("an empty time means the thesis does not depend on one", async () => {
    const { client } = standInClient({
      stop_reason: "end_turn", parsed_output: { expiry_date: "2026-11-20", expiry_time: "", reason: "A week-long swing." },
    });
    const out = await new ClaudeExpiryEvaluator(client).evaluate(thesis);
    assert.equal(out.expiresAt, "2026-11-20T23:59:59.000Z", "it expires at the end of that day");
    assert.equal(out.timeGiven, false);
  });

  test("a declined, unreadable or failed answer is an error, so the caller applies the default", async () => {
    const evaluate = (response: unknown) => new ClaudeExpiryEvaluator(standInClient(response).client).evaluate(thesis);
    await assert.rejects(evaluate({ stop_reason: "refusal", parsed_output: null }), /declined to evaluate/);
    await assert.rejects(evaluate({ stop_reason: "max_tokens", parsed_output: null }), /could not be read \(stop reason: max_tokens\)/);
    await assert.rejects(evaluate(new Error("socket hang up")), /socket hang up/);
    const unusable = { stop_reason: "end_turn", parsed_output: { expiry_date: "next week", expiry_time: "", reason: "Soon." } };
    await assert.rejects(evaluate(unusable), /unusable date or time/);
  });
});

describe("matching a thesis to a real trade", () => {
  const quoteFor = async (tokenId: string) => (await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: tokenId } })).body.quote_id;
  const order = (quoteId: string, side: string, extra: Record<string, unknown> = {}) =>
    api("POST", "/v1/orders", { key: s.bobTrade, body: { quote_id: quoteId, side, quantity: "1", authorise_fee: true, ...extra } });
  /** Moves a thesis's expiry into the past, as if time had gone by. */
  const expire = (tokenId: string) => srv.ctx.db.prepare("UPDATE insight_versions SET expires_at = ? WHERE token_id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), tokenId);

  test("an order must open in the direction of the thesis", async () => {
    const before = await balance("bob.testnet");
    const quoteId = await quoteFor(s.tokenId);
    const against = await order(quoteId, "buy");
    assert.equal(against.status, 409);
    assert.equal(against.body.error.code, "direction_mismatch");
    assert.match(against.body.error.message, /thesis is short, so a linked order must open with a sell, not a buy/);

    // Nothing was reserved and no order exists. The quote is still good for an order that matches.
    assert.deepEqual(await balance("bob.testnet"), before);
    assert.equal((await api("GET", "/v1/orders", { key: s.bobTrade })).body.orders.length, 0);
    assert.equal((await order(quoteId, "sell")).status, 201);
  });

  test("a long thesis takes buys and refuses sells", async () => {
    const long = (await publish({ ...ETH_THESIS, title: "ETH reclaim", direction: "long" })).body.token_id;
    const refused = await order(await quoteFor(long), "sell");
    assert.equal(refused.body.error.code, "direction_mismatch");
    assert.match(refused.body.error.message, /thesis is long, so a linked order must open with a buy/);
    const ok = await order(await quoteFor(long), "buy");
    assert.equal(ok.status, 201);
    assert.equal(ok.body.thesis_match.direction, "long");
  });

  test("an order must be in the market of the thesis", async () => {
    const before = await balance("bob.testnet");
    const other = await order(await quoteFor(s.tokenId), "sell", { market: "BTC-USD" });
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, "market_mismatch");
    assert.match(other.body.error.message, /thesis is about ETH-USD, so an order in BTC-USD cannot be linked/);
    assert.deepEqual(await balance("bob.testnet"), before);

    // The same market written differently is the same market. Leaving it out uses the thesis's market.
    const sameMarket = await order(await quoteFor(s.tokenId), "sell", { market: " eth-usd " });
    assert.equal(sameMarket.status, 201);
    assert.equal(sameMarket.body.market, "ETH-USD");
    assert.equal((await order(await quoteFor(s.tokenId), "sell")).body.market, "ETH-USD");
  });

  test("a linked order records what was checked against the thesis", async () => {
    const { order: placed } = await placeOrder(api, s.bobTrade, s.tokenId);
    assert.deepEqual(placed.body.thesis_match, {
      token_id: s.tokenId,
      content_hash: s.published.body.content_hash,
      market: "ETH-USD",
      direction: "short",
      opens_with: "sell",
      thesis_expires_at: s.published.body.expires_at,
      authorised_at: placed.body.created_at,
      checked: ["market", "direction", "authorised_before_expiry"],
    });
    assert.ok(placed.body.thesis_match.authorised_at < placed.body.thesis_match.thesis_expires_at);
  });

  test("after the expiry no fee is quoted and no order is linked; reading and earlier orders carry on", async () => {
    const { order: early } = await placeOrder(api, s.bobTrade, s.tokenId, "1");
    const quotedBefore = await quoteFor(s.tokenId);
    expire(s.tokenId);

    const quoteAfter = await api("POST", "/v1/quotes", { key: s.bobTrade, body: { token_id: s.tokenId } });
    assert.equal(quoteAfter.status, 409);
    assert.equal(quoteAfter.body.error.code, "insight_expired");
    const late = await order(quotedBefore, "sell");
    assert.equal(late.status, 409, "a quote from before the expiry cannot be used after it");
    assert.equal(late.body.error.code, "insight_expired");
    assert.equal((await balance("bob.testnet")).reserved.near, "0.1", "only the earlier order holds a reserve");

    // The thesis stays readable, for free, and shows as expired.
    assert.equal((await api("GET", `/v1/tokens/${s.tokenId}/preview`)).body.expired, true);
    const read = await api("GET", `/v1/tokens/${s.tokenId}`, { key: s.bobRead });
    assert.equal(read.status, 200);
    assert.equal(read.body.charge.yocto, "0");

    // An order authorised before the expiry still fills, and still pays the creator.
    const fill = await api("POST", `/v1/sim/orders/${early.body.id}/fill`);
    assert.equal(fill.body.event.effect, "settled");
    assert.equal((await balance("alice.testnet")).earned.near, "0.1");
  });

  test("a thesis with an expiry time stops taking orders at that moment", async () => {
    const at = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2000);
    const iso = at.toISOString();
    const soon = await publish({ ...ETH_THESIS, title: "ETH into the open", expiry_date: iso.slice(0, 10), expiry_time: iso.slice(11, 19) });
    assert.equal(soon.status, 201);
    assert.equal(soon.body.expires_at, iso);
    assert.equal(soon.body.expired, false);
    const quoteId = await quoteFor(soon.body.token_id);

    await new Promise((resolve) => setTimeout(resolve, at.getTime() - Date.now() + 50));
    assert.equal((await order(quoteId, "sell")).body.error.code, "insight_expired");
    assert.equal((await api("GET", `/v1/tokens/${soon.body.token_id}/preview`)).body.expired, true);
  });
});
