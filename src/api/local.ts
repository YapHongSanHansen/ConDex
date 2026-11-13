import { forbidden } from "../errors.ts";

/** The parts of an Express request this check reads (kept narrow so it is easy to test). */
export interface LocalRequestInfo {
  socket: { remoteAddress?: string | undefined };
  hostname: string;
  get(name: string): string | undefined;
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * For routes that act with this computer's own wallet: accept only requests made on this computer,
 * addressed to it by a local name, and (when sent by a browser) coming from this server's own pages.
 * This rules out other machines on the network, other websites, and DNS-rebinding hostnames.
 */
export function assertSameMachine(req: LocalRequestInfo): void {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
    throw forbidden("local_only", "This only works from the computer running ConDex");
  }
  if (!LOCAL_HOSTNAMES.has(req.hostname)) {
    throw forbidden("local_only", "Open the test console at http://localhost to use this");
  }
  const origin = req.get("origin");
  if (origin === undefined) return; // not a browser request (curl, scripts on this computer)
  let sameSite = false;
  try {
    const url = new URL(origin);
    sameSite = LOCAL_HOSTNAMES.has(url.hostname) && url.host === req.get("host");
  } catch {
    sameSite = false;
  }
  if (!sameSite) throw forbidden("cross_site", "Requests from other websites are refused");
}
