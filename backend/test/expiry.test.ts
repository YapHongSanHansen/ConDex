import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { LlmExpiryEvaluator, parseSuggestion } from "../src/ai/llmExpiry.ts";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_EXPIRY_DAYS, type ThesisForExpiry } from "../src/services/expiry.ts";
import { ETH_MESSAGES, ETH_THESIS, connectWallet, fakeAdvisor, futureDate, setupAliceAndBob, startServer } from "./helpers.ts";

const advisor = fakeAdvisor();
const srv = await startServer({ expiryAi: advisor });
const noAi = await startServer({ expiryAi: null });
beforeEach(async () => { await srv.api("POST", "/v1/dev/reset"); });
after(async () => { await srv.close(); await noAi.close(); });

const tomorrow = () => futureDate(1);
/** A complete thesis with no expiry, unless `extra` gives one. */
const { expiry_date: _expiryDate, ...UNDATED } = ETH_THESIS;
const body = (extra: Record<string, unknown> = {}) => ({ ...UNDATED, title: "ETH short", ...extra });

describe("every thesis has an expiry", () => {
  test("the creator's date and UTC time are used and recorded as the creator's", async () => {
    const s = await setupAliceAndBob(srv.api);
    const date = tomorrow();
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: date, expiry_time: "14:30" }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.expires_at, `${date}T14:30:00.000Z`);
    assert.equal(r.body.expiry.set_by, "creator");
    assert.equal(r.body.expiry.reason, null);
  });

  test("a date without a time expires at the end of that day, 23:59:59 UTC", async () => {
    const s = await setupAliceAndBob(srv.api);
    const date = tomorrow();
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: date }) });
    assert.equal(r.body.expires_at, `${date}T23:59:59.000Z`);
  });

  test("a full ISO expires_at still works", async () => {
    const s = await setupAliceAndBob(srv.api);
    const at = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expires_at: at }) });
    assert.equal(r.body.expires_at, at);
    assert.equal(r.body.expiry.set_by, "creator");
  });

  test("a past, malformed or time-only expiry is refused, and the AI is not asked", async () => {
    const s = await setupAliceAndBob(srv.api);
    const before = advisor.calls;
    for (const bad of [{ expiry_date: "2020-01-01" }, { expiry_date: "tomorrow" }, { expiry_date: tomorrow(), expiry_time: "25:00" }, { expiry_time: "14:30" }, { expires_at: "2020-01-01T00:00:00Z" }]) {
      const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body(bad) });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.error.code, "invalid_expiry");
    }
    assert.equal(advisor.calls, before);
  });
});

describe("ConDex's AI sets a missing expiry", () => {
  test("it is recorded as set by the AI, with the reason, on the preview and the proof", async () => {
    const s = await setupAliceAndBob(srv.api);
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body() });
    assert.equal(r.status, 201);
    assert.equal(r.body.expiry.set_by, "condex_ai");
    assert.match(r.body.expiry.reason, /short-term/);
    assert.ok(Date.parse(r.body.expires_at) > Date.now());

    const preview = (await srv.api("GET", `/v1/tokens/${r.body.token_id}/preview`)).body;
    assert.deepEqual(preview.expiry, r.body.expiry);
    const proof = (await srv.api("GET", `/v1/tokens/${r.body.token_id}/proof`)).body.proof_of_thesis;
    assert.deepEqual(proof.expiry, r.body.expiry);
    assert.equal(proof.expires_at, r.body.expires_at);
  });

  test("who set the expiry, and why, are part of the fingerprint", async () => {
    const s = await setupAliceAndBob(srv.api);
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body() });
    const read = (await srv.api("GET", `/v1/tokens/${r.body.token_id}`, { key: s.bobRead })).body;
    assert.equal(read.integrity.matches, true);
    srv.ctx.db.prepare("UPDATE insight_versions SET expiry_set_by = 'creator', expiry_reason = NULL WHERE token_id = ?").run(r.body.token_id);
    assert.equal((await srv.api("GET", `/v1/tokens/${r.body.token_id}`, { key: s.bobRead })).body.integrity.matches, false);
  });

  test("the creator's expiry is never replaced by the AI", async () => {
    const s = await setupAliceAndBob(srv.api);
    const before = advisor.calls;
    await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: tomorrow() }) });
    assert.equal(advisor.calls, before);
  });

  test("a caller without publish scope cannot trigger a model call", async () => {
    const s = await setupAliceAndBob(srv.api);
    const before = advisor.calls;
    const r = await srv.api("POST", "/v1/insights", { key: s.bobRead, body: body() });
    assert.equal(r.status, 403);
    assert.equal(advisor.calls, before);
  });

  test("a new version gets its own expiry", async () => {
    const s = await setupAliceAndBob(srv.api);
    const v1 = (await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: tomorrow() }) })).body;
    const v2 = await srv.api("POST", `/v1/insights/${v1.insight_id}/versions`, { key: s.alicePublish, body: body() });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.expiry.set_by, "condex_ai");
    assert.equal((await srv.api("GET", `/v1/tokens/${v1.token_id}/preview`)).body.expiry.set_by, "creator");
  });
});

describe("with no usable AI, ConDex applies its default rather than publishing without an expiry", () => {
  test("with no model configured, the thesis gets the default expiry and says so", async () => {
    await noAi.api("POST", "/v1/dev/reset");
    const session = (await connectWallet(noAi.api, "alice.testnet")).session;
    const key = (await noAi.api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
    const r = await noAi.api("POST", "/v1/insights", { key, body: body() });
    assert.equal(r.status, 201);
    assert.equal(r.body.expiry.set_by, "condex_default");
    assert.match(r.body.expiry.reason, /AI evaluation is not switched on/);
    assert.match(r.body.notice, /expiry_date/, "the creator is told how to choose their own");
    const days = (Date.parse(r.body.expires_at) - Date.now()) / 86_400_000;
    assert.ok(days > DEFAULT_EXPIRY_DAYS - 1 && days <= DEFAULT_EXPIRY_DAYS + 1, `expires in about ${DEFAULT_EXPIRY_DAYS} days`);
    const ok = await noAi.api("POST", "/v1/insights", { key, body: body({ expiry_date: tomorrow() }) });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.expiry.set_by, "creator");
  });

  test("the model failing applies the default, and the failure is logged", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const failing = await startServer({ expiryAi: { model: "x", evaluate: async () => { throw new Error("the model answered 503"); } } });
    try {
      const session = (await connectWallet(failing.api, "alice.testnet")).session;
      const key = (await failing.api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
      const r = await failing.api("POST", "/v1/insights", { key, body: body() });
      assert.equal(r.status, 201);
      assert.equal(r.body.expiry.set_by, "condex_default");
      assert.match(r.body.expiry.reason, /could not evaluate the thesis/);
      assert.match(String(warn.mock.calls[0]!.arguments[0]), /503/);
    } finally {
      await failing.close();
    }
  });
});

describe("the reasoning model", () => {
  const now = new Date("2026-11-13T10:00:00Z");
  const thesis: ThesisForExpiry = {
    title: "t", market: "ETH-USD", direction: "short", entry: "Close below the high.", invalidation: "Close above the sweep high.",
    target: null, summary: null, messages: ETH_MESSAGES, now,
  };

  test("its answer is parsed through think tags and code fences", () => {
    const text = '<think>US open is 14:30 UTC</think>\n```json\n{"expires_at": "2026-11-14T14:30:00Z", "reason": "Thesis says by the US open."}\n```';
    assert.deepEqual(parseSuggestion(text, now), { expiresAt: "2026-11-14T14:30:00.000Z", reason: "Thesis says by the US open." });
  });

  test("an unusable answer is rejected", () => {
    for (const text of ["", "no json here", "{not json}", '{"reason":"x"}', '{"expires_at":"soon"}', '{"expires_at":"2026-11-12T00:00:00Z"}', '{"expires_at":"2027-06-01T00:00:00Z"}']) {
      assert.throws(() => parseSuggestion(text, now), Error, text);
    }
  });

  test("it calls the configured OpenAI-compatible endpoint with the key, model and effort", async () => {
    let seen: { url: string; headers: Record<string, string>; body: { model: string; reasoning_effort: string; messages: Array<{ content: string }> } } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"expires_at":"2026-11-14T14:30:00Z","reason":"US open"}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const llm = new LlmExpiryEvaluator(loadConfig({ CONDEX_LLM_API_KEY: "k-test" }).llm!, fetcher);
    const out = await llm.evaluate(thesis);
    assert.deepEqual(out, { expiresAt: "2026-11-14T14:30:00.000Z", reason: "US open", timeGiven: true });
    assert.equal(llm.model, "qwen/qwen3.7-flash");
    assert.equal(seen!.url, "https://llm.grafilab.ai/v1/chat/completions");
    assert.equal(seen!.headers.authorization, "Bearer k-test");
    assert.equal(seen!.body.model, "qwen/qwen3.7-flash");
    assert.equal(seen!.body.reasoning_effort, "low");
    assert.match(seen!.body.messages[1]!.content, /ETH swept yesterday's high/);
    assert.match(seen!.body.messages[1]!.content, /Direction: short/);
  });

  test("a non-200 answer is an error", async () => {
    const llm = new LlmExpiryEvaluator(loadConfig({ CONDEX_LLM_API_KEY: "k" }).llm!, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    await assert.rejects(llm.evaluate(thesis), /401/);
  });

  test("config: off without a key, defaults with one, and bad effort fails at startup", () => {
    assert.equal(loadConfig({}).llm, null);
    const cfg = loadConfig({ CONDEX_LLM_API_KEY: "k", CONDEX_LLM_MODEL: "m", CONDEX_LLM_BASE_URL: "https://x.test/v1/" }).llm!;
    assert.deepEqual([cfg.model, cfg.baseUrl, cfg.reasoningEffort], ["m", "https://x.test/v1", "low"]);
    assert.throws(() => loadConfig({ CONDEX_LLM_API_KEY: "k", CONDEX_LLM_REASONING_EFFORT: "max" }), /CONDEX_LLM_REASONING_EFFORT/);
  });

  test("config: which AI sets a missing expiry", () => {
    assert.equal(loadConfig({}).expiryAi, "off");
    assert.equal(loadConfig({ CONDEX_LLM_API_KEY: "k" }).expiryAi, "llm");
    assert.equal(loadConfig({ ANTHROPIC_API_KEY: "a" }).expiryAi, "claude");
    assert.equal(loadConfig({ CONDEX_LLM_API_KEY: "k", ANTHROPIC_API_KEY: "a" }).expiryAi, "llm", "the OpenAI-compatible model wins when both have a key");
    assert.equal(loadConfig({ CONDEX_LLM_API_KEY: "k", ANTHROPIC_API_KEY: "a", CONDEX_EXPIRY_AI: "claude" }).expiryAi, "claude");
    assert.equal(loadConfig({ CONDEX_LLM_API_KEY: "k", CONDEX_EXPIRY_AI: "off" }).expiryAi, "off");
    assert.throws(() => loadConfig({ CONDEX_EXPIRY_AI: "llm" }), /CONDEX_LLM_API_KEY/);
  });
});
