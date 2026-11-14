export type Direction = "long" | "short";

export interface Draft {
  exportId: string | null;
  market: string;
  /** Empty until the creator chooses: a thesis cannot be published without a direction. */
  direction: Direction | "";
  /** When to enter and what would prove the idea wrong, in the creator's own words. */
  entry: string;
  invalidation: string;
  target: string;
  /** datetime-local value. Empty means ConDex sets the expiry. */
  expiry: string;
  fee: string;
  confirmed: boolean;
}

export const EMPTY_DRAFT: Draft = { exportId: null, market: "", direction: "", entry: "", invalidation: "", target: "", expiry: "", fee: "", confirmed: false };

export interface DraftErrors { exportId?: string; market?: string; direction?: string; entry?: string; invalidation?: string; target?: string; expiry?: string; fee?: string }

const MAX_TEXT = 500;

export function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.exportId) e.exportId = "Pick an export from Claude Code.";
  if (d.market.trim().length < 2) e.market = "Name the market, for example ETH-USD.";
  if (!d.direction) e.direction = "Choose long or short.";
  if (d.entry.trim().length < 3) e.entry = "Say when to enter, in your own words.";
  else if (d.entry.length > MAX_TEXT) e.entry = `Keep it under ${MAX_TEXT} characters.`;
  if (d.invalidation.trim().length < 3) e.invalidation = "Say what would prove the idea wrong.";
  else if (d.invalidation.length > MAX_TEXT) e.invalidation = `Keep it under ${MAX_TEXT} characters.`;
  if (d.target.length > MAX_TEXT) e.target = `Keep it under ${MAX_TEXT} characters.`;
  // The expiry is optional. If one is given it must still be ahead.
  if (d.expiry && new Date(d.expiry).getTime() <= Date.now()) e.expiry = "Pick a date and time in the future, or leave it empty.";
  const fee = Number(d.fee);
  if (!d.fee || Number.isNaN(fee) || fee <= 0) e.fee = "Enter a fee above 0 NEAR, for example 0.5.";
  return e;
}

/** ISO string to the value format <input type="datetime-local"> expects (local time). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
