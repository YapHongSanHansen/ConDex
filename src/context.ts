import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ExecutionVenue } from "./execution/venue.ts";
import type { Ledger } from "./ledger/ledger.ts";

/** Everything a service function needs. Built once in `createApp`. */
export interface Ctx {
  config: Config;
  db: Db;
  ledger: Ledger;
  venue: ExecutionVenue;
}
