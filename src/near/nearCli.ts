/**
 * One-click "Connect wallet" for local development: the server asks near-cli-rs to sign the
 * sign-in message with the key near-cli keeps in this computer's keychain.
 *
 * Only ConDex's own challenge is ever signed (the caller chooses the account, never the message),
 * and the route that uses this is dev-mode only and refuses requests from other machines or sites.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface SignedMessage {
  accountId: string;
  publicKey: string;
  signature: string;
}

export interface MessageSigner {
  sign(input: { accountId: string; message: string; nonce: Buffer; recipient: string; network: string }): Promise<SignedMessage>;
}

export class NearCliError extends Error {}

export class NearCliSigner implements MessageSigner {
  readonly binary: string;
  /** near-cli arguments after `sign-as <account>`. Tests swap the keychain for a throwaway key. */
  private readonly signWith: (network: string) => string[];

  constructor(binary: string, signWith: (network: string) => string[] = (network) => ["sign-with-keychain", "network-config", network]) {
    this.binary = binary;
    this.signWith = signWith;
  }

  sign(input: { accountId: string; message: string; nonce: Buffer; recipient: string; network: string }): Promise<SignedMessage> {
    const args = [
      "message", "sign-nep413", "utf8", input.message, "nonce", input.nonce.toString("base64"),
      "recipient", input.recipient, "sign-as", input.accountId, ...this.signWith(input.network),
    ];
    return new Promise((resolve, reject) => {
      // execFile passes arguments directly (no shell), so nothing in them is interpreted.
      execFile(this.binary, args, { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
          reject(new NearCliError(timedOut ? "near-cli took longer than 60 seconds" : nearCliErrorText(stderr) || err.message));
          return;
        }
        const parsed = parseNearCliJson(stdout);
        if (!parsed) {
          reject(new NearCliError("near-cli did not print the expected { accountId, publicKey, signature } output"));
          return;
        }
        resolve(parsed);
      });
    });
  }
}

/** near-cli prints the signed message as JSON: { "accountId", "publicKey", "signature" }. */
export function parseNearCliJson(stdout: string): SignedMessage | null {
  const block = stdout.match(/\{[\s\S]*\}/)?.[0];
  if (!block) return null;
  try {
    const j = JSON.parse(block) as Record<string, unknown>;
    if (typeof j.accountId === "string" && typeof j.publicKey === "string" && typeof j.signature === "string") {
      return { accountId: j.accountId, publicKey: j.publicKey, signature: j.signature };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/** near-cli errors look like "Error: \n   0: No access keys found in keychain". Returns the numbered reasons. */
export function nearCliErrorText(stderr: string): string {
  const plain = stderr.replace(/\x1b\[[0-9;]*m/g, "");
  const reasons = [...plain.matchAll(/^\s*\d+:\s*(.+?)\s*$/gm)].map((m) => m[1]!);
  return reasons.join(": ");
}

/** Finds near-cli-rs: CONDEX_NEAR_CLI, then npm's global install on Windows, then `near` on PATH. */
export function findNearCli(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CONDEX_NEAR_CLI) return existsSync(env.CONDEX_NEAR_CLI) ? env.CONDEX_NEAR_CLI : null;
  if (process.platform === "win32") {
    // npm's `near` shim is a .cmd/.ps1 wrapper; the real binary sits here.
    const exe = env.APPDATA ? join(env.APPDATA, "npm", "node_modules", "near-cli-rs", "node_modules", ".bin_real", "near.exe") : null;
    if (exe && existsSync(exe)) return exe;
    for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
      if (dir && existsSync(join(dir, "near.exe"))) return join(dir, "near.exe");
    }
    return null;
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, "near"))) return join(dir, "near");
  }
  return null;
}
