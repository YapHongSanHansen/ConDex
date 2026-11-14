import { createHash, randomBytes } from "node:crypto";
import { badRequest } from "./errors.ts";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---- Clocks -------------------------------------------------------------
// ConDex keeps two clocks. The business clock times everything a thesis and its trades go through: publishing,
// expiry, quotes, orders, fills, closes and the evaluation. In dev mode it can be set to a past moment, so a
// demo can replay a real market window (see services/replay.ts). The system clock is always real time, and is
// what sign-in, sessions, API keys and subscriptions use, so a replay never logs anyone out.

/** The moment the business clock is frozen at, in Unix milliseconds. null: it follows real time. */
let replayAt: number | null = null;

/** The business clock, in Unix milliseconds. */
export function nowMs(): number {
  return replayAt ?? Date.now();
}

/** The business clock, as ISO 8601. */
export function nowIso(): string {
  return new Date(nowMs()).toISOString();
}

/** Real time, whatever the business clock says. */
export function systemNowIso(): string {
  return new Date().toISOString();
}

/** Freezes the business clock at a moment. It stays there until it is set again or cleared. */
export function setReplayClock(atMs: number): void {
  replayAt = atMs;
}

export function clearReplayClock(): void {
  replayAt = null;
}

/** The moment a replay is frozen at, as ISO 8601, or null when the business clock follows real time. */
export function replayClock(): string | null {
  return replayAt === null ? null : new Date(replayAt).toISOString();
}

/** JSON with object keys sorted, so the same content always hashes the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

// ---- NEAR amounts -------------------------------------------------------
// All amounts are stored and computed as yoctoNEAR strings (1 NEAR = 10^24 yocto).

const YOCTO_PER_NEAR = 10n ** 24n;

export function parseNear(amount: string | number, field = "amount"): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(text)) {
    throw badRequest("invalid_amount", `${field} must be a non-negative NEAR amount like "0.1"`);
  }
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0") || "0");
}

export function formatNear(yocto: bigint | string): string {
  const value = BigInt(yocto);
  const whole = value / YOCTO_PER_NEAR;
  const frac = (value % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Amount object returned by the API: exact yocto string plus a readable NEAR string. */
export function amount(yocto: bigint | string) {
  return { yocto: BigInt(yocto).toString(), near: formatNear(yocto) };
}
