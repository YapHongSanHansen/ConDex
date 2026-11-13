import { createHash, randomBytes } from "node:crypto";
import { badRequest } from "./errors.ts";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
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
