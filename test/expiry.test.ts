import assert from "node:assert/strict";
import { after, beforeEach, describe, test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { LlmExpiryAdvisor, parseSuggestion } from "../src/services/expiry.ts";
import type { Message } from "../src/services/insights.ts";
import { ETH_MESSAGES as MESSAGES, connectWallet, fakeAdvisor, setupAliceAndBob, startServer } from "./helpers.ts";

const advisor = fakeAdvisor();
const srv = await startServer({ expiryAdvisor: advisor });
const noAi = await startServer({ expiryAdvisor: null });
const ETH_MESSAGES = MESSAGES as Message[];
beforeEach(async () => { await srv.api("POST", "/v1/dev/reset"); });
after(async () => { await srv.close(); await noAi.close(); });

const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
const body = (extra: Record<string, unknown> = {}) => ({ title: "ETH short", market: "ETH-USD", fee_near: "0.1", messages: ETH_MESSAGES, ...extra });

describe("every thesis has an expiry", () => {
  test("the creator's date and UTC time are used and recorded as the creator's", async () => {
    const s = await setupAliceAndBob(srv.api);
    const date = tomorrow();
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: date, expiry_time: "14:30" }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.expires_at, `${date}T14:30:00.000Z`);
    assert.deepEqual(r.body.expiry, { set_by: "creator", reason: null });
  });

  test("a date without a time expires at 23:59 UTC", async () => {
    const s = await setupAliceAndBob(srv.api);
    const date = tomorrow();
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body({ expiry_date: date }) });
    assert.equal(r.body.expires_at, `${date}T23:59:00.000Z`);
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
    assert.equal(r.body.expiry.set_by, "ai");
    assert.match(r.body.expiry.reason, /short-term/);
    assert.ok(Date.parse(r.body.expires_at) > Date.now());

    const proof = (await srv.api("GET", `/v1/tokens/${r.body.token_id}/proof`)).body.proof_of_thesis;
    assert.deepEqual(proof.expiry, r.body.expiry);
    assert.equal(proof.expires_at, r.body.expires_at);
  });

  test("who set the expiry, and why, are part of the fingerprint", async () => {
    const s = await setupAliceAndBob(srv.api);
    const r = await srv.api("POST", "/v1/insights", { key: s.alicePublish, body: body() });
    const read = (await srv.api("GET", `/v1/tokens/${r.body.token_id}`, { key: s.bobRead })).body;
    assert.equal(read.integrity.matches, true);
    srv.ctx.db.prepare("UPDATE insight_versions SET expiry_source = 'creator', expiry_reason = NULL WHERE token_id = ?").run(r.body.token_id);
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
    assert.equal(v2.body.expiry.set_by, "ai");
    assert.equal((await srv.api("GET", `/v1/tokens/${v1.token_id}/preview`)).body.expiry.set_by, "creator");
  });
});

describe("with no usable AI, publishing without an expiry is refused", () => {
  test("with no model configured, the error says what to pass, and nothing is published", async () => {
    await noAi.api("POST", "/v1/dev/reset");
    const session = (await connectWallet(noAi.api, "alice.testnet")).session;
    const key = (await noAi.api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
    const r = await noAi.api("POST", "/v1/insights", { key, body: body() });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "expiry_required");
    assert.match(r.body.error.message, /expiry_date/);
    assert.equal((await noAi.api("GET", "/v1/tokens")).body.tokens.length, 0);
    const ok = await noAi.api("POST", "/v1/insights", { key, body: body({ expiry_date: tomorrow() }) });
    assert.equal(ok.status, 201);
  });

  test("the model failing refuses publishing with the reason", async () => {
    const failing = await startServer({ expiryAdvisor: { model: "x", suggest: async () => { throw new Error("the model answered 503"); } } });
    try {
      const session = (await connectWallet(failing.api, "alice.testnet")).session;
      const key = (await failing.api("POST", "/v1/keys", { key: session, body: { scopes: ["publish"] } })).body.secret;
      const r = await failing.api("POST", "/v1/insights", { key, body: body() });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "expiry_required");
      assert.match(r.body.error.message, /503/);
    } finally {
      await failing.close();
    }
  });
});

describe("the reasoning model", () => {
  const now = new Date("2026-11-13T10:00:00Z");

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
    const llm = new LlmExpiryAdvisor(loadConfig({ CONDEX_LLM_API_KEY: "k-test" }).llm!, fetcher);
    const out = await llm.suggest({ title: "t", market: "ETH-USD", summary: null, conditions: null, messages: ETH_MESSAGES }, now);
    assert.equal(out.expiresAt, "2026-11-14T14:30:00.000Z");
    assert.equal(seen!.url, "https://llm.grafilab.ai/v1/chat/completions");
    assert.equal(seen!.headers.authorization, "Bearer k-test");
    assert.equal(seen!.body.model, "qwen/qwen3.7-flash");
    assert.equal(seen!.body.reasoning_effort, "low");
    assert.match(seen!.body.messages[1]!.content, /ETH swept yesterday's high/);
  });

  test("a non-200 answer is an error", async () => {
    const llm = new LlmExpiryAdvisor(loadConfig({ CONDEX_LLM_API_KEY: "k" }).llm!, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
    await assert.rejects(llm.suggest({ title: "t", market: null, summary: null, conditions: null, messages: ETH_MESSAGES }, now), /401/);
  });

  test("config: off without a key, defaults with one, and bad effort fails at startup", () => {
    assert.equal(loadConfig({}).llm, null);
    const cfg = loadConfig({ CONDEX_LLM_API_KEY: "k", CONDEX_LLM_MODEL: "m", CONDEX_LLM_BASE_URL: "https://x.test/v1/" }).llm!;
    assert.deepEqual([cfg.model, cfg.baseUrl, cfg.reasoningEffort], ["m", "https://x.test/v1", "low"]);
    assert.throws(() => loadConfig({ CONDEX_LLM_API_KEY: "k", CONDEX_LLM_REASONING_EFFORT: "max" }), /CONDEX_LLM_REASONING_EFFORT/);
  });
});
