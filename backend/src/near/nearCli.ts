/**
 * One-click "Connect wallet" for local development: the server asks near-cli-rs to sign the
 * sign-in message with the key near-cli keeps in this computer's keychain.
 *
 * Only ConDex's own challenge is ever signed (the caller chooses the account, never the message),
 * and the route that uses this is dev-mode only and refuses requests from other machines or sites.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

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

/**
 * Finds a runnable near-cli-rs. If CONDEX_NEAR_CLI is set, only that is considered (a binary, or an
 * npm/pnpm `near` shim, which is followed to the package's real binary). Otherwise: npm's global
 * install, then every directory on PATH (the binary itself, or the package behind a `near` shim),
 * then Volta's package folder. Each candidate must answer `--version` with "near-cli-rs", so a legacy
 * JavaScript `near`, a directory, or a .cmd file that cannot be run directly is never picked.
 */
export function findNearCli(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of nearCliCandidates(env)) {
    if (isNearCliRs(candidate)) return candidate;
  }
  return null;
}

const EXE = process.platform === "win32" ? "near.exe" : "near";
/** near-cli-rs's npm package downloads the real binary to node_modules/.bin_real inside the package. */
const realBinary = (packageDir: string) => join(packageDir, "node_modules", ".bin_real", EXE);

function nearCliCandidates(env: NodeJS.ProcessEnv): string[] {
  const explicit = env.CONDEX_NEAR_CLI?.trim();
  if (explicit) return [explicit, ...behindShim(explicit)];

  const out: string[] = [];
  if (process.platform === "win32" && env.APPDATA) out.push(realBinary(join(env.APPDATA, "npm", "node_modules", "near-cli-rs")));
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    out.push(join(dir, EXE));
    for (const shim of ["near.cmd", "near.ps1", "near"]) out.push(...behindShim(join(dir, shim)));
  }
  if (process.platform === "win32" && env.LOCALAPPDATA) {
    out.push(realBinary(join(env.LOCALAPPDATA, "Volta", "tools", "image", "packages", "near-cli-rs", "node_modules", "near-cli-rs")));
  }
  return [...new Set(out)];
}

/** The real binary behind an npm or pnpm `near` shim, which runs <package>/run-near.js. */
function behindShim(shim: string): string[] {
  if (!existsSync(shim) || !statSync(shim).isFile() || statSync(shim).size > 64 * 1024) return [];
  const dir = dirname(shim);
  const out = [
    realBinary(join(dir, "node_modules", "near-cli-rs")),                // npm on Windows: shims sit beside node_modules
    realBinary(join(dir, "..", "lib", "node_modules", "near-cli-rs")),   // npm on macOS/Linux: <prefix>/bin and <prefix>/lib
  ];
  const text = readFileSync(shim, "utf8");
  for (const m of text.matchAll(/["']?([^"'\s]*near-cli-rs)[\\/]run-near\.js/g)) {
    const pkg = m[1]!.replace(/^(%~?dp0%?|\$basedir)[\\/]?/i, "");
    out.push(realBinary(isAbsolute(pkg) ? pkg : resolve(dir, pkg)));
  }
  return out;
}

function isNearCliRs(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    const out = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return /^near-cli-rs\s/m.test(out);
  } catch {
    return false;
  }
}
