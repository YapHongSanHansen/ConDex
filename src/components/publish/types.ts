import type { Horizon } from "@/lib/api/types";

export interface Draft {
  exportId: string | null;
  market: string;
  horizon: Horizon;
  expiry: string; // datetime-local value
  fee: string;
  confirmed: boolean;
}

export const EMPTY_DRAFT: Draft = { exportId: null, market: "", horizon: "intraday", expiry: "", fee: "", confirmed: false };

export interface DraftErrors { exportId?: string; market?: string; expiry?: string; fee?: string }

export function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.exportId) e.exportId = "Pick an export from Claude Code.";
  if (d.market.trim().length < 2) e.market = "Name the market, for example BTC/USDT.";
  if (!d.expiry || new Date(d.expiry).getTime() <= Date.now()) e.expiry = "Pick a date and time in the future.";
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
