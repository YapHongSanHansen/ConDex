import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { ExecutionVenue } from "./execution/venue.ts";
import type { Ledger } from "./ledger/ledger.ts";
import type { MarketData } from "./market/marketData.ts";
import type { AccessKeyChecker } from "./near/accessKeys.ts";
import type { MessageSigner } from "./near/nearCli.ts";
import type { ExpiryEvaluator } from "./services/expiry.ts";

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
  /** Market prices a thesis is evaluated against after its deadline. */
  market: MarketData;
  accessKeys: AccessKeyChecker;
  /** Dev mode only: signs sign-in messages with this computer's near-cli wallet. null when unavailable. */
  nearCli: MessageSigner | null;
  /** MCP servers that have connected, by API key id. */
  mcp: Map<string, McpConnection>;
  /** ConDex's AI for a thesis published without an expiry. null: only the default expiry is applied. */
  expiryAi: ExpiryEvaluator | null;
  /** When each account used the expiry AI in the past hour, to cap paid model calls. */
  expiryAiUse: Map<string, number[]>;
}
