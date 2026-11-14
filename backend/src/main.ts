import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { CoinGeckoMarketData, POOLS } from "./market/coinGecko.ts";
import { NearCliSigner } from "./near/nearCli.ts";

const config = loadConfig();
const { app, ctx, marketSnapshots } = createApp(config);

const marketData = ctx.market instanceof CoinGeckoMarketData
  ? `${ctx.market.name}, real one-minute candles (${Object.entries(POOLS).map(([market, pool]) => `${market}: ${pool.pair}`).join("; ")}); ` +
    `${marketSnapshots} saved window${marketSnapshots === 1 ? "" : "s"} loaded; ` +
    (ctx.market.canFetch ? "fetching from CoinGecko is on" : "no CONDEX_COINGECKO_API_KEY, so only the saved windows can be evaluated")
  : `${ctx.market.name} (prices typed in through the dev route; set CONDEX_COINGECKO_API_KEY for real prices)`;

const storage = config.dbPath === ":memory:"
  ? "memory (nothing written to disk; everything resets when the server restarts)"
  : `file ${config.dbPath}`;
const reach = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1"
  ? "this computer only"
  : `all interfaces on ${config.host}`;

app.listen(config.port, config.host, () => {
  console.log(`ConDex API listening on http://localhost:${config.port} (${reach})`);
  console.log(`  ledger: ${ctx.ledger.kind}   venue: ${ctx.venue.name}   wallet key check: ${ctx.accessKeys.mode}`);
  if (config.ledgerBackupReason) console.log(`  ledger: using the mock backup, not NEAR: ${config.ledgerBackupReason}`);
  if (ctx.chain && config.near) {
    console.log(`  NEAR contract: ${config.near.contractId} (operator ${config.near.operatorId}, reporter ${config.near.reporterId})`);
  }
  console.log(`  storage: ${storage}`);
  console.log(`  market data: ${marketData}`);
  console.log(`  thesis without an expiry: ${ctx.expiryAi
    ? `ConDex's AI sets it (${ctx.expiryAi.model})`
    : "ConDex's default, 7 days (set CONDEX_LLM_API_KEY or ANTHROPIC_API_KEY to have ConDex's AI read the thesis instead)"}`);
  if (config.devMode) {
    console.log(`  test page: http://localhost:${config.port}/test`);
    console.log(`  one-click near-cli connect: ${ctx.nearCli instanceof NearCliSigner
      ? ctx.nearCli.binary
      : "off (near-cli-rs not found; install it with npm install -g near-cli-rs or set CONDEX_NEAR_CLI)"}`);
  }
});
