/**
 * Opens /test?autorun=1 in headless Chrome or Edge against a fresh in-memory server,
 * waits for "Run every button" to finish and prints the result of each button.
 * Exits non-zero if any button fails or the page throws.
 *
 *   npm run test:page            (set CHROME_PATH to use a specific browser)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { loadConfig } from "../src/config.ts";

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => !!p);

const browserPath = CANDIDATES.find((p) => existsSync(p));
if (!browserPath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH.");
  process.exit(2);
}

const config = { ...loadConfig({}), dbPath: ":memory:", devMode: true };
const { app } = createApp(config);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/test?autorun=1`;

const profile = mkdtempSync(join(tmpdir(), "condex-chrome-"));
const browser = spawn(browserPath, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let exitCode = 1;
try {
  const wsBrowser = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Browser did not start")), 20_000);
    browser.stderr!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
  });
  const debugPort = new URL(wsBrowser).port;
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target");

  const cdp = await connect(page.webSocketDebuggerUrl);
  const pageErrors: string[] = [];
  cdp.on("Runtime.exceptionThrown", (p) => pageErrors.push(String((p as { exceptionDetails: { exception?: { description?: string }; text: string } }).exceptionDetails.exception?.description ?? (p as { exceptionDetails: { text: string } }).exceptionDetails.text)));
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const e = p as { type: string; args: Array<{ value?: unknown; description?: string }> };
    if (e.type === "error") pageErrors.push(e.args.map((a) => a.value ?? a.description).join(" "));
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: pageUrl });

  const deadline = Date.now() + 90_000;
  let raw = "";
  while (Date.now() < deadline) {
    const r = await cdp.send("Runtime.evaluate", {
      expression: `document.body && document.body.dataset.autorun === "done" ? document.getElementById("autorun-result").textContent : ""`,
      returnByValue: true,
    }) as { result: { value?: string } };
    raw = r.result.value ?? "";
    if (raw) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  if (!raw) throw new Error("Timed out waiting for the test page to finish");

  const out = JSON.parse(raw) as { total: number; passed: number; failed: number; results: Array<{ label: string; ok: boolean; note: string }> };
  for (const r of out.results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(48)} ${r.note}`);
  console.log(`\n${out.passed}/${out.total} buttons passed in ${browserPath.split(/[\\/]/).pop()}`);
  if (pageErrors.length) console.log(`\nPage errors:\n  ${pageErrors.join("\n  ")}`);
  exitCode = out.failed === 0 && pageErrors.length === 0 ? 0 : 1;
  cdp.close();
} catch (err) {
  console.error(err);
} finally {
  browser.kill();
  server.close();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}
process.exit(exitCode);

// ---- minimal Chrome DevTools Protocol client over Node's built-in WebSocket ----
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP connect failed")), { once: true });
  });
  let nextId = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Array<(p: unknown) => void>>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
    if (msg.id !== undefined) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message)); else w?.resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  return {
    send(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<unknown>((resolve, reject) => waiting.set(id, { resolve, reject }));
    },
    on(method: string, fn: (p: unknown) => void) {
      listeners.set(method, [...(listeners.get(method) ?? []), fn]);
    },
    close() { ws.close(); },
  };
}
