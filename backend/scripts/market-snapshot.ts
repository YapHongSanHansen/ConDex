// Saves a window of real one-minute candles into demo/candles, so that window can be replayed and
// evaluated without the network, and after it has left CoinGecko's free six-month history.
//
//   npm run snapshot -- ETH-USD 2026-08-19T14:30:00Z 2026-08-19T16:30:00Z
//
// Needs CONDEX_COINGECKO_API_KEY (npm run snapshot reads it from .env). The API loads every file in
// demo/candles at startup when its feed is CoinGecko.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { CoinGeckoMarketData } from "../src/market/coinGecko.ts";

const [market, from, to] = process.argv.slice(2);
if (!market || !from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || Date.parse(to) <= Date.parse(from)) {
  console.error("Usage: npm run snapshot -- <MARKET> <from> <to>, for example\n  npm run snapshot -- ETH-USD 2026-08-19T14:30:00Z 2026-08-19T16:30:00Z");
  process.exit(1);
}
const apiKey = process.env.CONDEX_COINGECKO_API_KEY?.trim();
if (!apiKey) {
  console.error("Set CONDEX_COINGECKO_API_KEY (in .env) first: the candles are fetched from CoinGecko.");
  process.exit(1);
}

const feed = new CoinGeckoMarketData(openDb(":memory:"), apiKey);
// One call fetches at most 12,000 candles, so a long window takes several.
for (let round = 0; round < 20; round++) await feed.loadRange(market, Date.parse(from) / 1000, Date.parse(to) / 1000);
const snapshot = feed.exportSnapshot(market, from, to);

const dir = fileURLToPath(new URL("../demo/candles", import.meta.url));
mkdirSync(dir, { recursive: true });
const file = `${dir}/${snapshot.market.toLowerCase()}-${snapshot.from.slice(0, 10)}.json`;
// One candle per line, so the file can be read and compared by eye.
const { candles, ...header } = snapshot;
const text = JSON.stringify(header, null, 2).replace(/\n}$/, `,\n  "candles": [\n${candles.map((c) => `    ${JSON.stringify(c)}`).join(",\n")}\n  ]\n}\n`);
writeFileSync(file, text);
console.log(`Saved ${candles.length} candles of ${snapshot.market} (${snapshot.pair}) from ${snapshot.from} to ${snapshot.to}`);
console.log(`  to ${file}`);
console.log(`  ${snapshot.attribution}`);
