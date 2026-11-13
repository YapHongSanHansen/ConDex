import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";
import { NearCliSigner } from "./near/nearCli.ts";

const config = loadConfig();
const { app, ctx } = createApp(config);

const storage = config.dbPath === ":memory:"
  ? "memory (nothing written to disk; everything resets when the server restarts)"
  : `file ${config.dbPath}`;
const reach = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1"
  ? "this computer only"
  : `all interfaces on ${config.host}`;

app.listen(config.port, config.host, () => {
  console.log(`ConDex API listening on http://localhost:${config.port} (${reach})`);
  console.log(`  ledger: ${ctx.ledger.kind}   venue: ${ctx.venue.name}   wallet key check: ${ctx.accessKeys.mode}`);
  console.log(`  storage: ${storage}`);
  if (config.devMode) {
    console.log(`  test page: http://localhost:${config.port}/test`);
    console.log(`  one-click near-cli connect: ${ctx.nearCli instanceof NearCliSigner
      ? ctx.nearCli.binary
      : "off (near-cli-rs not found; install it with npm install -g near-cli-rs or set CONDEX_NEAR_CLI)"}`);
  }
});
