import { badRequest } from "./errors.ts";

// Order quantities and prices are decimal strings. Arithmetic uses BigInt scaled by 10^18
// so partial fills add up exactly.

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);

export function parseDecimal(value: string | number, field: string, opts: { positive?: boolean } = {}): bigint {
  const text = String(value).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(text)) throw badRequest("invalid_number", `${field} must be a decimal like "1.5"`);
  const [whole = "0", frac = ""] = text.split(".");
  const scaled = BigInt(whole) * FACTOR + BigInt(frac.padEnd(SCALE, "0") || "0");
  if (opts.positive && scaled <= 0n) throw badRequest("invalid_number", `${field} must be greater than zero`);
  return scaled;
}

export function formatDecimal(scaled: bigint): string {
  const whole = scaled / FACTOR;
  const frac = (scaled % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
