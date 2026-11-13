/**
 * NEP-413: signing an off-chain message with a NEAR account key.
 * https://github.com/near/NEPs/blob/master/neps/nep-0413.md
 *
 * The wallet signs sha256( borsh(u32 tag) ++ borsh(payload) ) with ed25519, where
 *   tag     = 2^31 + 413
 *   payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }
 * and returns { accountId, publicKey: "ed25519:<base58>", signature: <base64> }.
 */
import { type KeyObject, createHash, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array; // exactly 32 bytes
  recipient: string;
  callbackUrl?: string | null;
}

export function nep413Hash(p: Nep413Payload): Buffer {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const parts: Buffer[] = [u32(NEP413_TAG), str(p.message), Buffer.from(p.nonce), str(p.recipient)];
  parts.push(p.callbackUrl == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), str(p.callbackUrl)]));
  return createHash("sha256").update(Buffer.concat(parts)).digest();
}

/**
 * True if `signature` is a valid NEP-413 signature of `payload` by `publicKey` ("ed25519:<base58>").
 * Accepts both encodings wallets use: base64 (NEAR Wallet Selector) and "ed25519:<base58>" (near-cli).
 */
export function verifyNep413(publicKey: string, signature: string, payload: Nep413Payload): boolean {
  let key: KeyObject;
  try {
    key = ed25519PublicKey(publicKey);
  } catch {
    return false;
  }
  const sig = decodeSignature(signature);
  if (!sig || sig.length !== 64) return false;
  return edVerify(null, nep413Hash(payload), key, sig);
}

export function decodeSignature(text: string): Buffer | null {
  try {
    if (text.startsWith("ed25519:")) return Buffer.from(base58Decode(text.slice("ed25519:".length)));
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
    return Buffer.from(text, "base64");
  } catch {
    return null;
  }
}

/** Signs like a wallet would. Used by tests and dev tooling; production signing happens in the user's wallet. */
export function signNep413(privateKey: KeyObject, payload: Nep413Payload): string {
  return edSign(null, nep413Hash(payload), privateKey).toString("base64");
}

/** "ed25519:<base58>" -> KeyObject. Throws on any other key type or bad encoding. */
export function ed25519PublicKey(nearKey: string): KeyObject {
  const [type, data] = nearKey.split(":");
  if (type !== "ed25519" || !data) throw new Error("Only ed25519 NEAR keys are supported");
  const raw = base58Decode(data);
  if (raw.length !== 32) throw new Error("ed25519 public key must be 32 bytes");
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/** KeyObject -> "ed25519:<base58>" */
export function toNearPublicKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (jwk.crv !== "Ed25519" || !jwk.x) throw new Error("Not an Ed25519 key");
  return `ed25519:${base58Encode(Buffer.from(jwk.x, "base64url"))}`;
}

// ---- encoding helpers ----

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function str(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`Invalid base58 character "${ch}"`);
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const ch of text) {
    if (ch !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
