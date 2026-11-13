import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ExecutionVenue } from "./execution/venue.ts";
import type { Ledger } from "./ledger/ledger.ts";
import type { AccessKeyChecker } from "./near/accessKeys.ts";
import type { MessageSigner } from "./near/nearCli.ts";
import type { ExpiryAdvisor } from "./services/expiry.ts";

/** An MCP server that has said hello for one API key. Kept in memory only: it describes a live process. */
export interface McpConnection {
  connectedAt: string;
  lastSeenAt: string;
  client: string;
  tools: string[];
}

/** Everything a service function needs. Built once in `createApp`. */
export interface Ctx {
  config: Config;
  db: Db;
  ledger: Ledger;
  venue: ExecutionVenue;
  accessKeys: AccessKeyChecker;
  /** Dev mode only: signs sign-in messages with this computer's near-cli wallet. null when unavailable. */
  nearCli: MessageSigner | null;
  /** Sets a thesis's expiry when the creator gives none. null when no reasoning model is configured. */
  expiryAdvisor: ExpiryAdvisor | null;
  /** MCP servers that have connected, by API key id. */
  mcp: Map<string, McpConnection>;
}
