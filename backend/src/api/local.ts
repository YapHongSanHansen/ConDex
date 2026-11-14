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
 * Headers that proxies and tunnels (ngrok, Cloudflare, editor port forwarding, nginx) add. A tunnel
 * connects from this computer, so its requests look local; these headers are the only sign they are not.
 * A tunnel configured to strip them and rewrite Host cannot be detected, which is why the README says
 * never to expose the dev server through one.
 */
const PROXY_HEADERS = [
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip",
  "cf-connecting-ip", "true-client-ip", "x-original-host", "via",
];

/**
 * For the dev routes, which act on this computer's data and wallet: accept only requests made on this
 * computer, addressed to it by a local name, not passed on by a proxy or tunnel, and (when sent by a
 * browser) coming from this server's own pages. This rules out other machines, other websites
 * (cross-site form posts and fetches), and DNS-rebinding hostnames.
 */
export function assertSameMachine(req: LocalRequestInfo): void {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? "")) {
    throw forbidden("local_only", "This only works from the computer running ConDex");
  }
  if (!LOCAL_HOSTNAMES.has(req.hostname)) {
    throw forbidden("local_only", "Open the test console at http://localhost to use this");
  }
  if (PROXY_HEADERS.some((h) => req.get(h) !== undefined)) {
    throw forbidden("local_only", "Requests passed on by a proxy or tunnel are refused. Open the test console directly at http://localhost");
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

export function isSameMachine(req: LocalRequestInfo): boolean {
  try {
    assertSameMachine(req);
    return true;
  } catch {
    return false;
  }
}
