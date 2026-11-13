import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncateAccount(id: string, head = 8, tail = 8): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export function truncateHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

export function formatAmount(n: number): string {
  return String(Number(n.toFixed(3)));
}

export function formatNear(n: number): string {
  return `${formatAmount(n)} NEAR`;
}

export function timeUntil(iso: string, now = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function isExpiringSoon(iso: string, now = Date.now()): boolean {
  const ms = new Date(iso).getTime() - now;
  return ms > 0 && ms < 24 * 3600 * 1000;
}

export function formatDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isValidNearAccount(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && NEAR_ACCOUNT.test(id);
}
