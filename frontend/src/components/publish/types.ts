export type Direction = "long" | "short";

export interface Draft {
  market: string;
  /** Empty until the creator chooses: a thesis cannot be published without a direction. */
  direction: Direction | "";
  /** When to enter and what would prove the idea wrong, in the creator's own words. */
  entry: string;
  invalidation: string;
  target: string;
  /** datetime-local value. Empty means ConDex sets the expiry. */
  expiry: string;
  /** YYYY-MM-DD. Empty means the thesis is judged at its expiry. */
  evaluationDeadline: string;
  fee: string;
}

export const EMPTY_DRAFT: Draft = { market: "", direction: "", entry: "", invalidation: "", target: "", expiry: "", evaluationDeadline: "", fee: "" };

export interface DraftErrors { market?: string; direction?: string; entry?: string; invalidation?: string; target?: string; expiry?: string; evaluationDeadline?: string; fee?: string }

const MAX_TEXT = 500;
const DAY_MS = 86_400_000;
/** The backend allows the evaluation deadline up to this long after the expiry. */
export const MAX_EVALUATION_DAYS = 30;

export function validate(d: Draft): DraftErrors {
  const e: DraftErrors = {};
  if (d.market.trim().length < 2) e.market = "Name the market, for example ETH-USD.";
  if (!d.direction) e.direction = "Choose long or short.";
  if (d.entry.trim().length < 3) e.entry = "Say when to enter, in your own words.";
  else if (d.entry.length > MAX_TEXT) e.entry = `Keep it under ${MAX_TEXT} characters.`;
  if (d.invalidation.trim().length < 3) e.invalidation = "Say what would prove the idea wrong.";
  else if (d.invalidation.length > MAX_TEXT) e.invalidation = `Keep it under ${MAX_TEXT} characters.`;
  if (d.target.length > MAX_TEXT) e.target = `Keep it under ${MAX_TEXT} characters.`;
  // The expiry is optional. If one is given it must still be ahead.
  if (d.expiry && new Date(d.expiry).getTime() <= Date.now()) e.expiry = "Pick a date and time in the future, or leave it empty.";
  if (d.evaluationDeadline) {
    const at = new Date(`${d.evaluationDeadline}T23:59:59Z`).getTime();
    // Without an expiry, ConDex sets it and the deadline is checked there instead.
    const expiry = d.expiry ? new Date(d.expiry).getTime() : null;
    if (Number.isNaN(at)) e.evaluationDeadline = "Pick a date.";
    else if (expiry !== null && at < expiry) e.evaluationDeadline = "It cannot be before the expiry.";
    else if (expiry !== null && at > expiry + MAX_EVALUATION_DAYS * DAY_MS) e.evaluationDeadline = `At most ${MAX_EVALUATION_DAYS} days after the expiry.`;
    else if (expiry === null) e.evaluationDeadline = "Set an expiry first: the deadline is counted from it.";
  }
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

/**
 * The words the creator pastes into Claude Code. The agent publishes with the ConDex MCP tool and asks the creator
 * which messages to share. Nothing is sent from this page: the conversation is on the creator's side.
 */
export function buildPrompt(d: Draft, versionOf: string | null): string {
  const expiry = d.expiry ? new Date(d.expiry).toISOString() : null;
  const lines = [
    versionOf ? `Publish a new version of my ConDex thesis ${versionOf}, using the ConDex tool.` : "Publish this conversation to ConDex, using the ConDex tool.",
    `Market: ${d.market.trim().toUpperCase()}. Direction: ${d.direction}.`,
    `Entry: ${d.entry.trim()}`,
    `Invalidation: ${d.invalidation.trim()}`,
    ...(d.target.trim() ? [`Target: ${d.target.trim()}`] : []),
    expiry ? `Expiry: ${expiry}.` : "Expiry: none given, so ConDex sets one.",
    ...(d.evaluationDeadline ? [`Evaluation deadline: ${d.evaluationDeadline}.`] : []),
    `Fee: ${d.fee.trim()} NEAR per filled trade.`,
    "Ask me which messages to share, and share only those.",
  ];
  return lines.join("\n");
}
