import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ExecutionVenue } from "./execution/venue.ts";
import type { Ledger } from "./ledger/ledger.ts";
import type { AccessKeyChecker } from "./near/accessKeys.ts";
import type { MessageSigner } from "./near/nearCli.ts";

/** Everything a service function needs. Built once in `createApp`. */
export interface Ctx {
  config: Config;
  db: Db;
  ledger: Ledger;
  venue: ExecutionVenue;
  accessKeys: AccessKeyChecker;
  /** Dev mode only: signs sign-in messages with this computer's near-cli wallet. null when unavailable. */
  nearCli: MessageSigner | null;
}
