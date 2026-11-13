import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, ctx } = createApp(config);

const storage = config.dbPath === ":memory:"
  ? "memory (nothing written to disk; everything resets when the server restarts)"
  : `file ${config.dbPath}`;

app.listen(config.port, () => {
  console.log(`ConDex API listening on http://localhost:${config.port}`);
  console.log(`  ledger: ${ctx.ledger.kind}   venue: ${ctx.venue.name}   wallet key check: ${ctx.accessKeys.mode}`);
  console.log(`  storage: ${storage}`);
  if (config.devMode) console.log(`  test page: http://localhost:${config.port}/test`);
});
