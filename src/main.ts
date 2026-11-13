import { createApp } from "./api/app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const { app, ctx } = createApp(config);

app.listen(config.port, () => {
  console.log(`ConDex API listening on http://localhost:${config.port}`);
  console.log(`  ledger: ${ctx.ledger.kind}   venue: ${ctx.venue.name}   db: ${config.dbPath}`);
  if (config.devMode) console.log(`  test page: http://localhost:${config.port}/test`);
});
