/**
 * Opens the test console in headless Chrome or Edge against a fresh in-memory server and checks it:
 *   1. /test?autorun=1 — "Run every button" clicks every test button; each must pass.
 *   2. The navbar Connect wallet button — one-click near-cli sign-in (first click asks for the account,
 *      later clicks connect straight away), MCP key, reload, restarts and resets, disconnect, switch
 *      wallet, test wallet, the copy-and-paste near-cli path, and the phone layout.
 * The server's near-cli signer always uses a throwaway key, never the keychain of the machine running this.
 * The sign-in recipient contains a space here, so the quoting of the displayed near-cli command is tested.
 * Exits non-zero if anything fails or the page throws.
 *
 *   npm run test:page    (CHROME_PATH / CONDEX_NEAR_CLI pick the browser / near-cli binary;
 *                         REQUIRE_NEAR_CLI=1 fails instead of skipping when near-cli is missing;
 *                         SCREENSHOT_DIR saves screenshots of the navbar states)
 */
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/app.ts";
import { loadConfig } from "../src/config.ts";
import { type MessageSigner, NearCliSigner, findNearCli } from "../src/near/nearCli.ts";
import { signNep413, toNearPrivateKey, toNearPublicKey } from "../src/near/nep413.ts";

const BROWSERS = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((p): p is string => !!p);

const browserPath = BROWSERS.find((p) => existsSync(p));
if (!browserPath) {
  console.error("No Chrome or Edge found. Set CHROME_PATH.");
  process.exit(2);
}

// A throwaway key for every signature in this run. Real near-cli signs with it when installed.
const throwaway = generateKeyPairSync("ed25519").privateKey;
const throwawayNearKey = toNearPrivateKey(throwaway);
const nearCli = findNearCli();
const signer: MessageSigner = nearCli
  ? new NearCliSigner(nearCli, () => ["sign-with-plaintext-private-key", throwawayNearKey])
  : {
      async sign(input) {
        const sig = signNep413(throwaway, { message: input.message, nonce: input.nonce, recipient: input.recipient });
        return { accountId: input.accountId, publicKey: toNearPublicKey(createPublicKey(throwaway)), signature: sig };
      },
    };

// The checks sign in dozens of times a minute from this computer, so the per-client limit is raised.
const config = { ...loadConfig({}), dbPath: ":memory:", devMode: true, authRecipient: "ConDex Test", signInsPerMinute: 10_000 };
const { app } = createApp(config, { nearCli: signer });
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const profile = mkdtempSync(join(tmpdir(), "condex-chrome-"));
const browser = spawn(browserPath, [
  "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

type Outcome = "pass" | "fail" | "skip";
const checks: Array<{ name: string; outcome: Outcome; note: string }> = [];
const pageErrors: string[] = [];
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
  const target = targets.find((t) => t.type === "page");
  if (!target) throw new Error("No page target");

  const cdp = await connect(target.webSocketDebuggerUrl);
  cdp.on("Runtime.exceptionThrown", (p) => {
    const d = (p as { exceptionDetails: { exception?: { description?: string }; text: string } }).exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
  });
  cdp.on("Runtime.consoleAPICalled", (p) => {
    const e = p as { type: string; args: Array<{ value?: unknown; description?: string }> };
    if (e.type === "error") pageErrors.push(e.args.map((a) => a.value ?? a.description).join(" "));
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });

  const page = pageHelpers(cdp);

  // ---- 1. every test button -------------------------------------------------
  await page.goto(`${origin}/test?autorun=1`);
  const raw = await page.waitFor(`document.body?.dataset.autorun === "done" && document.getElementById("autorun-result").textContent`, 120_000);
  const run = JSON.parse(raw as string) as { total: number; passed: number; failed: number; results: Array<{ label: string; ok: boolean; note: string }> };
  for (const r of run.results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(50)} ${r.note}`);
  console.log(`\n${run.passed}/${run.total} buttons passed\n`);

  // ---- 2. navbar Connect wallet ----------------------------------------------
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, outcome: "pass", note: await fn() });
    } catch (err) {
      checks.push({ name, outcome: "fail", note: (err as Error).message });
      await page.eval(`(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); })()`).catch(() => {});
    }
  };
  const skip = (name: string, why: string) => {
    checks.push({ name, outcome: process.env.REQUIRE_NEAR_CLI === "1" ? "fail" : "skip", note: why });
  };
  const shotDir = process.env.SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const shot = async (name: string) => {
    if (!shotDir) return;
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, "base64"));
  };
  const disconnect = async () => {
    await page.click("#wallet-btn");
    await page.click("#menu-disconnect");
    await page.waitFor(`WALLET === null && !connecting`);
  };
  const oneClickConnect = async (account: string) => {
    await page.waitFor(`NEAR_CLI_AVAILABLE === true && WALLET === null`);
    await page.click("#wallet-btn");
    await page.waitFor(`WALLET?.account === ${JSON.stringify(account)}`, 20_000);
  };
  const noticeShows = (pattern: string) =>
    page.waitFor(`!document.getElementById("notice").hidden && ${pattern}.test(document.getElementById("notice-text").textContent)`);
  const sessionStatus = (token: string) =>
    page.eval(`fetch("/v1/me", { headers: { authorization: "Bearer " + ${JSON.stringify(token)} } }).then((r) => r.status)`);

  await check("navbar: Connect wallet button sits at the top right", async () => {
    await page.waitFor(`NEAR_CLI_AVAILABLE === true`);
    const r = await page.eval(`(() => {
      const b = document.getElementById("wallet-btn").getBoundingClientRect();
      return { text: document.getElementById("wallet-btn").textContent.trim(), right: Math.round(innerWidth - b.right), top: Math.round(b.top) };
    })()`) as { text: string; right: number; top: number };
    if (r.text !== "Connect wallet") throw new Error(`button says "${r.text}"`);
    if (r.right > 40 || r.top > 40) throw new Error(`button is ${r.right}px from the right and ${r.top}px from the top`);
    await shot("1-navbar-disconnected");
    return `${r.right}px from right edge, ${r.top}px from top`;
  });

  await check("one click: the first time asks only for the account, then connects", async () => {
    await page.click("#wallet-btn");
    await page.waitFor(`document.getElementById("connect-dialog").open && !document.getElementById("local-flow").hidden`);
    await shot("2-first-time-account");
    await page.setValue("#local-account", "Oneclick-User.testnet ");
    await page.click("#local-connect");
    await page.waitFor(`WALLET?.account === "oneclick-user.testnet" && !document.getElementById("connect-dialog").open`, 20_000);
    const remembered = await page.eval(`localStorage.getItem("condex.nearCliAccount")`);
    if (remembered !== "oneclick-user.testnet") throw new Error(`remembered ${remembered}`);
    return `connected as oneclick-user.testnet via ${nearCli ? "near-cli" : "a stand-in signer (near-cli not installed)"}`;
  });

  await check("the request log never shows the full session token", async () => {
    const leaked = await page.eval(`document.getElementById("log").textContent.includes(WALLET.token)`);
    if (leaked) throw new Error("the session token appears in full in the request log");
    return "tokens are shortened in the log";
  });

  let mcpKey = "";
  await check("menu: Create an MCP key gives a working key and two commands that are safe to paste again", async () => {
    await page.click("#wallet-btn");
    await page.waitFor(`!document.getElementById("wallet-menu").hidden`);
    await shot("3-wallet-menu");
    await page.click("#menu-mcp");
    await page.waitFor(`document.getElementById("mcp-dialog").open`);
    mcpKey = String(await page.eval(`document.getElementById("mcp-key").textContent`));
    const lines = String(await page.eval(`document.getElementById("mcp-cmd").textContent`)).split("\n");
    if (!mcpKey.startsWith("cdx_")) throw new Error(`key looks wrong: ${mcpKey.slice(0, 12)}`);
    if (lines.length !== 2 || lines[0] !== "claude mcp remove condex") throw new Error(`expected remove + add lines, got ${JSON.stringify(lines)}`);
    if (!lines[1]!.includes(`CONDEX_API_KEY=${mcpKey}`) || !lines[1]!.includes(`"--" node "`) || !/server\.ts"$/.test(lines[1]!)) {
      throw new Error(`add line looks wrong: ${lines[1]}`);
    }
    const me = await page.eval(`fetch("/v1/me", { headers: { authorization: "Bearer " + ${JSON.stringify(mcpKey)} } }).then((r) => r.json())`) as { credential: { type: string; scopes: string[] } };
    if (me.credential.type !== "api_key" || me.credential.scopes.join() !== "publish,read,trade") throw new Error(`key has ${JSON.stringify(me.credential)}`);
    await shot("4-mcp-dialog");
    await page.eval(`document.getElementById("mcp-dialog").close()`);
    const focused = await page.eval(`document.activeElement?.id`);
    if (focused !== "wallet-btn") throw new Error(`after closing the dialog, focus is on ${focused}`);
    return "key works for publish, read and trade; focus returns to the wallet button";
  });

  await check("README demo buttons keep your wallet and MCP key (no hidden reset)", async () => {
    await page.goto(`${origin}/test`); // fresh page: the State panel is empty, so the demo sets itself up
    await page.waitFor(`WALLET?.account === "oneclick-user.testnet"`);
    await page.click(`[data-action="demo2"]`);
    await page.waitFor(`document.querySelector('[data-action="demo2"] .dot').classList.contains("pass")`, 30_000);
    if (await page.eval(`WALLET?.account`) !== "oneclick-user.testnet") throw new Error("the demo signed the wallet out");
    if (await sessionStatus(mcpKey) !== 200) throw new Error("the demo revoked the MCP key");
    return "demo passed; wallet still connected; MCP key still works";
  });

  await check("README demo buttons recover after a server restart and keep Bob's balance topped up", async () => {
    // A restart (memory storage) kills the keys still shown in the State panel; demos must notice.
    await page.eval(`fetch("/v1/dev/reset", { method: "POST" })`);
    await page.eval(`document.querySelector('[data-action="demo4"] .dot').className = "dot"`);
    for (let run = 1; run <= 12; run++) { // each paid fill costs Bob 0.1 NEAR; his first deposit was 1 NEAR
      await page.click(`[data-action="demo4"]`);
      await page.waitFor(`(() => { const d = document.querySelector('[data-action="demo4"] .dot'); return d.classList.contains("pass") || d.classList.contains("fail"); })()`, 30_000);
      const outcome = await page.eval(`document.querySelector('[data-action="demo4"]').title`);
      if (!String(outcome).startsWith("PASS")) throw new Error(`run ${run}: ${outcome}`);
      await page.eval(`document.querySelector('[data-action="demo4"] .dot').className = "dot"`);
    }
    return "12 paid demo runs in a row after a restart, all passed";
  });

  await check("test wallets keep their key across reloads; another key cannot take over the account", async () => {
    await page.goto(`${origin}/test`);
    const first = await page.eval(`connectDevWallet("pinned-user.testnet").then((r) => r.b.new_account)`);
    await page.goto(`${origin}/test`);
    const again = await page.eval(`connectDevWallet("pinned-user.testnet").then((r) => r.b.new_account)`);
    if (first !== true || again !== false) throw new Error(`expected a new account then the same one, got ${first} then ${again}`);
    const impostor = await page.eval(`(async () => {
      localStorage.removeItem("condex.devKey.pinned-user.testnet");
      delete devKeys["pinned-user.testnet"];
      try { await connectDevWallet("pinned-user.testnet"); return "signed in"; } catch (e) { return e.message; }
    })()`);
    if (!/first connected with a different key/.test(String(impostor))) throw new Error(`a different key got: ${impostor}`);
    return "same browser key works after reload; a new key is refused";
  });

  await check("Disconnect ends the session on the server (and the menu survives a click that focuses nothing)", async () => {
    await oneClickConnect("oneclick-user.testnet");
    const token = String(await page.eval(`WALLET.token`));
    await page.click("#wallet-btn");
    await page.waitFor(`!document.getElementById("wallet-menu").hidden`);
    // Safari and Firefox on macOS do not focus a button on click: focus leaves with relatedTarget null.
    await page.eval(`document.activeElement.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }))`);
    if (await page.eval(`document.getElementById("wallet-menu").hidden`)) throw new Error("the menu closed before the click registered");
    await page.click("#menu-disconnect");
    await page.waitFor(`WALLET === null && !connecting`);
    await page.waitFor(`document.getElementById("wallet-btn").textContent.trim() === "Connect wallet"`);
    if (await sessionStatus(token) !== 401) throw new Error("old session still accepted");
    return "button back to Connect wallet; old session returns 401";
  });

  await check("one click: after that, a single click connects without any dialog", async () => {
    await page.eval(`(() => {
      window.__dialogsOpened = 0;
      const show = HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal = function () { window.__dialogsOpened++; return show.call(this); };
    })()`);
    await oneClickConnect("oneclick-user.testnet");
    const opened = await page.eval(`window.__dialogsOpened`);
    if (opened !== 0) throw new Error(`a dialog opened ${opened} time(s)`);
    await shot("5-connected-one-click");
    return "one click → connected";
  });

  await check("Reset all data while connected signs the wallet out and says why", async () => {
    await page.click(`[data-action="reset"]`);
    await page.waitFor(`WALLET === null`);
    await noticeShows(`/revoked its MCP keys/`);
    await shot("6-reset-notice");
    return "signed out with a visible notice";
  });

  await check("a session ended by the server is noticed when the menu opens", async () => {
    await page.eval(`document.getElementById("notice").hidden = true`);
    await oneClickConnect("oneclick-user.testnet");
    await page.eval(`fetch("/v1/dev/reset", { method: "POST" })`); // what a server restart does to memory storage
    await page.click("#wallet-btn");
    await page.waitFor(`WALLET === null && document.getElementById("wallet-menu").hidden`);
    await noticeShows(`/session ended/`);
    return "menu did not open; signed out with a visible notice";
  });

  await check("after a server-side reset, a reload shows Connect wallet and clears the stored session", async () => {
    await oneClickConnect("oneclick-user.testnet");
    await page.eval(`fetch("/v1/dev/reset", { method: "POST" })`);
    await page.goto(`${origin}/test`);
    await page.waitFor(`document.getElementById("wallet-btn").textContent.trim() === "Connect wallet"`);
    const stored = await page.eval(`sessionStorage.getItem("condex.wallet")`);
    if (stored !== null) throw new Error("the dead session is still stored");
    await noticeShows(`/session ended/`);
    return "stored session dropped; notice shown";
  });

  await check("Switch wallet… shows every way to connect; Test wallet works", async () => {
    await oneClickConnect("oneclick-user.testnet");
    await page.click("#wallet-btn");
    await page.click("#menu-switch");
    await page.waitFor(`WALLET === null && document.getElementById("connect-dialog").open && !document.getElementById("connect-choices").hidden`);
    const choices = await page.eval(`[...document.querySelectorAll("[data-choice]")].filter((b) => !b.hidden).map((b) => b.dataset.choice).join(",")`);
    if (choices !== "local,cli,test") throw new Error(`choices shown: ${choices}`);
    await shot("7-switch-wallet-choices");
    await page.click(`[data-choice="test"]`);
    await page.setValue("#test-account", "navbar-user.testnet");
    await page.click("#test-connect");
    await page.waitFor(`WALLET?.account === "navbar-user.testnet" && !document.getElementById("connect-dialog").open`);
    await disconnect();
    return `choices: ${choices}; test wallet connected and disconnected`;
  });

  await check("copy-and-paste path explains a bad account name and a bad paste", async () => {
    await page.eval(`localStorage.removeItem("condex.nearCliAccount")`);
    await page.click("#wallet-btn");
    // With near-cli available and no remembered account, the dialog opens on the one-click step.
    await page.waitFor(`document.getElementById("connect-dialog").open && !document.getElementById("local-flow").hidden`);
    await page.click(`#local-flow [data-back]`);
    await page.click(`[data-choice="cli"]`);
    await page.waitFor(`!document.getElementById("cli-flow").hidden`);
    await page.setValue("#cli-account", "bad paste.testnet");
    await page.click("#cli-get");
    await page.waitFor(`/Enter your NEAR account/.test(document.getElementById("cli-msg").textContent)`);
    await page.setValue("#cli-account", "probe-user.testnet");
    await page.click("#cli-get");
    await page.waitFor(`!!window.__pendingChallenge && !document.getElementById("cli-step2").hidden`);
    await shot("8-copy-paste-command");
    await page.setValue("#cli-output", "hello");
    await page.click("#cli-connect");
    await page.waitFor(`/curly braces/.test(document.getElementById("cli-msg").textContent)`);
    return "invalid account and invalid paste both explained";
  });

  if (!nearCli) {
    skip("copy-and-paste path end to end with near-cli", "near-cli not found (set CONDEX_NEAR_CLI)");
  } else {
    await check("copy-and-paste path: run the exact displayed command with near-cli (throwaway key)", async () => {
      const ch = await page.eval(`window.__pendingChallenge`) as { message: string; nonce: string; recipient: string; account: string };
      const cmd = String(await page.eval(`document.getElementById("cli-cmd").textContent`));
      // Split the displayed command the way a shell would for double-quoted words.
      const words = [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
      const expected = ["near", "message", "sign-nep413", "utf8", ch.message, "nonce", ch.nonce, "recipient", ch.recipient,
        "sign-as", ch.account, "sign-with-keychain", "network-config", config.nearNetwork];
      if (JSON.stringify(words) !== JSON.stringify(expected)) throw new Error(`displayed command does not match the challenge: ${cmd}`);
      // Run it, swapping only the keychain signer for the throwaway key.
      const signed = spawnSync(nearCli, [...words.slice(1, -3), "sign-with-plaintext-private-key", throwawayNearKey], { encoding: "utf8", timeout: 60_000 });
      if (signed.status !== 0) throw new Error(`near-cli failed: ${signed.stderr || signed.error}`);
      await page.setValue("#cli-output", signed.stdout); // exactly what near-cli printed
      await page.click("#cli-connect");
      await page.waitFor(`WALLET?.account === "probe-user.testnet"`, 15_000);
      await disconnect();
      return `near-cli ran the displayed command (recipient "${ch.recipient}"); connected as probe-user.testnet`;
    });
  }

  await check("phone width: no sideways scroll and no overlap, even with a long account name", async () => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 800, deviceScaleFactor: 1, mobile: true });
    await page.goto(`${origin}/test`);
    await page.waitFor(`NEAR_CLI_AVAILABLE === true && WALLET === null`); // the click depends on both
    await page.click("#wallet-btn");
    await page.waitFor(`document.getElementById("connect-dialog").open && !document.getElementById("local-flow").hidden`);
    await page.setValue("#local-account", "trading-agent.yaphongsanhansen.testnet");
    await page.click("#local-connect");
    await page.waitFor(`WALLET?.account === "trading-agent.yaphongsanhansen.testnet"`, 20_000);
    const r = await page.eval(`(() => {
      const box = (el) => el.getBoundingClientRect();
      const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      const brand = [...document.querySelectorAll(".brand > *")].filter((el) => el.offsetParent !== null).map(box);
      const right = box(document.querySelector(".nav-right"));
      const wallet = box(document.getElementById("wallet-btn"));
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        overlap: brand.some((b) => overlaps(b, right)),
        walletRight: Math.round(innerWidth - wallet.right),
      };
    })()`) as { overflow: number; overlap: boolean; walletRight: number };
    await shot("9-phone-connected-long-name");
    if (r.overflow > 0) throw new Error(`page scrolls sideways by ${r.overflow}px`);
    if (r.overlap) throw new Error("the title overlaps the navbar buttons");
    if (r.walletRight > 40) throw new Error(`wallet button is ${r.walletRight}px from the right edge`);
    return `360px wide: no overlap; wallet button ${r.walletRight}px from the right`;
  });

  for (const c of checks) console.log(`${c.outcome.toUpperCase().padEnd(4)}  ${c.name.padEnd(84)} ${c.note}`);
  const failed = checks.filter((c) => c.outcome === "fail").length;
  const skipped = checks.filter((c) => c.outcome === "skip").length;
  console.log(`\n${checks.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped (navbar checks, ${browserPath.split(/[\\/]/).pop()})`);
  if (pageErrors.length) console.log(`\nPage errors:\n  ${pageErrors.join("\n  ")}`);
  exitCode = run.failed === 0 && failed === 0 && pageErrors.length === 0 ? 0 : 1;
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

// ---- helpers ------------------------------------------------------------------

function pageHelpers(cdp: Awaited<ReturnType<typeof connect>>) {
  const evalPage = async (expression: string): Promise<unknown> => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }) as {
      result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string };
    };
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    eval: evalPage,
    async goto(url: string) {
      await cdp.send("Page.navigate", { url });
      await this.waitFor(`document.readyState === "complete"`);
    },
    async waitFor(expression: string, timeoutMs = 10_000): Promise<unknown> {
      const deadline = Date.now() + timeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        try {
          last = await evalPage(expression);
          if (last) return last;
        } catch { /* page may be navigating */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async click(selector: string, timeoutMs = 5_000) {
      await this.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !!el && !el.disabled && el.offsetParent !== null; })()`, timeoutMs);
      await evalPage(`document.querySelector(${JSON.stringify(selector)}).click()`);
    },
    async setValue(selector: string, value: string) {
      await evalPage(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    },
  };
}

// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
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
