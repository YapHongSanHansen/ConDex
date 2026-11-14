// The presenter's control for a replay: puts the running ConDex API at a past moment and steps it forward.
//
//   npm run replay -- status
//   npm run replay -- set "2026-08-19 23:22"     a moment, in this computer's time zone
//   npm run replay -- set 2026-08-19T15:22:00Z   or as a full ISO time
//   npm run replay -- to 23:32                   forward to a time on the same day (this computer's time zone)
//   npm run replay -- reset                      back to real time (accounts, keys and data are kept)
//
// Each step prints the market's price at that moment, the simulated orders it filled and the theses it judged.
// The API must be in dev mode on the mock ledger (CONDEX_API_URL, default http://localhost:8787).
const BASE = process.env.CONDEX_API_URL ?? "http://localhost:8787";
const MARKET = process.env.CONDEX_REPLAY_MARKET ?? "ETH-USD";
const [command, ...rest] = process.argv.slice(2);
const when = rest.join(" ").trim();

interface Clock {
  mode: "real" | "replay"; now: string;
  price?: { market: string; source: string; price: string | null; at: string | null };
  fills?: Array<{ order_id: string; at: string; price: string }>; evaluated?: number;
}

async function api(method: string, path: string, body?: unknown): Promise<Clock> {
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error(`No ConDex API answered at ${BASE}. Start it with npm start`);
  }
  const json = await res.json() as Clock & { error?: { message: string } };
  if (!res.ok) throw new Error(json.error?.message ?? `${method} ${path} answered ${res.status}`);
  return json;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** A moment in this computer's time zone, with the UTC time beside it. */
function show(isoTime: string): string {
  const d = new Date(isoTime);
  const offset = -d.getTimezoneOffset();
  const zone = `UTC${offset >= 0 ? "+" : "-"}${Math.floor(Math.abs(offset) / 60)}${offset % 60 ? `:${pad(Math.abs(offset) % 60)}` : ""}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${zone}` +
    ` (${isoTime.slice(11, 19)} UTC)`;
}

function report(clock: Clock) {
  console.log(clock.mode === "replay" ? `Replay clock: ${show(clock.now)}` : `Real time: ${show(clock.now)} (no replay)`);
  if (clock.price) {
    console.log(clock.price.price
      ? `  ${clock.price.market} ${clock.price.price}  (${clock.price.source})`
      : `  ${clock.price.market}: no price held for this moment (${clock.price.source})`);
  }
  for (const f of clock.fills ?? []) console.log(`  filled ${f.order_id} at ${f.price}  (candle closed ${show(f.at)})`);
  if (clock.evaluated) console.log(`  judged ${clock.evaluated} thesis${clock.evaluated === 1 ? "" : "es"} whose deadline has passed`);
}

/** "2026-08-19 23:22" (this computer's time zone) or any full ISO time. */
function parseMoment(text: string): Date {
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(" ", "T") : text);
  if (Number.isNaN(d.getTime())) throw new Error(`"${text}" is not a time. Use "2026-08-19 23:22" or 2026-08-19T15:22:00Z`);
  return d;
}

try {
  if (command === "status" || command === undefined) {
    report(await api("GET", `/v1/dev/clock?market=${encodeURIComponent(MARKET)}`));
  } else if (command === "set") {
    report(await api("POST", "/v1/dev/clock", { now: parseMoment(when).toISOString(), market: MARKET }));
  } else if (command === "to") {
    const current = await api("GET", "/v1/dev/clock");
    if (current.mode !== "replay") throw new Error('No replay is running. Start one with: npm run replay -- set "2026-08-19 23:22"');
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(when);
    if (!match) throw new Error(`"${when}" is not a time of day. Use HH:MM, for example: npm run replay -- to 23:32`);
    const target = new Date(current.now);
    target.setHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
    if (target.getTime() < Date.parse(current.now)) {
      throw new Error(`${when} is before the replay clock (${show(current.now)}). To go back, use: npm run replay -- set "<date> ${when}"`);
    }
    report(await api("POST", "/v1/dev/clock", { now: target.toISOString(), market: MARKET }));
  } else if (command === "reset") {
    report(await api("DELETE", "/v1/dev/clock"));
  } else {
    throw new Error("Use: npm run replay -- status | set <time> | to <HH:MM> | reset");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
