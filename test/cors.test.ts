import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { startServer } from "./helpers.ts";

const SITE = "https://condex.example";
const srv = await startServer({}, { corsOrigins: [SITE] });
after(() => srv.close());

const call = (method: string, path: string, origin?: string, extra: Record<string, string> = {}) =>
  fetch(srv.base + path, { method, headers: { ...(origin ? { origin } : {}), ...extra } });

describe("CORS for the website", () => {
  test("a listed origin may call the API and sees its own origin echoed back", async () => {
    const res = await call("GET", "/v1/tokens", SITE);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), SITE);
    assert.equal(res.headers.get("vary"), "Origin");
  });

  test("the preflight is answered with the headers a bearer call needs", async () => {
    const res = await call("OPTIONS", "/v1/orders", SITE, { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /Authorization/);
    assert.match(res.headers.get("access-control-allow-methods") ?? "", /POST/);
  });

  test("any other origin gets no CORS header, so a browser refuses the answer", async () => {
    const res = await call("GET", "/v1/tokens", "https://evil.example");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    const pre = await call("OPTIONS", "/v1/orders", "https://evil.example");
    assert.equal(pre.headers.get("access-control-allow-origin"), null);
  });

  test("the dev routes still refuse a listed website: CORS does not open them", async () => {
    const res = await call("POST", "/v1/dev/reset", SITE);
    assert.equal(res.status, 403);
  });
});

describe("without CORS_ORIGINS", () => {
  test("no origin is allowed", async () => {
    const plain = await startServer();
    const res = await fetch(plain.base + "/v1/tokens", { headers: { origin: SITE } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
    await plain.close();
  });
});
