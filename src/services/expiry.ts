import type { Ctx } from "../context.ts";
import { badRequest } from "../errors.ts";

/** Who set a thesis's expiry: its creator, ConDex's AI, or ConDex's default when the AI did not set one. */
export type ExpirySetBy = "creator" | "condex_ai" | "condex_default";

export interface ResolvedExpiry {
  /** ISO 8601, UTC. */
  expiresAt: string;
  /** false when only a date was set: the thesis then expires at the end of that day. */
  timeGiven: boolean;
  setBy: ExpirySetBy;
  /** Why ConDex chose this expiry. null when the creator set it. */
  reason: string | null;
}

/** The thesis as it is about to be published: what an evaluator reads to choose an expiry. */
export interface ThesisForExpiry {
  title: string;
  market: string;
  direction: "long" | "short";
  entry: string;
  invalidation: string;
  target: string | null;
  summary: string | null;
  messages: Array<{ role: string; content: string; at?: string }>;
  now: Date;
}

export interface ExpiryEvaluation {
  /** YYYY-MM-DD, UTC. */
  date: string;
  /** HH:MM or HH:MM:SS, UTC. null when the thesis does not depend on a time of day. */
  time: string | null;
  /** Shown to the creator and to everyone who reads the thesis. */
  reason: string;
}

/** Chooses the expiry of a thesis whose creator gave none. */
export interface ExpiryEvaluator {
  evaluate(thesis: ThesisForExpiry): Promise<ExpiryEvaluation>;
}

/** Applied when the creator gave no expiry and ConDex's AI did not set one. */
export const DEFAULT_EXPIRY_DAYS = 7;
/** Each AI evaluation is a paid model call, so an account gets this many an hour before the default applies. */
export const AI_EVALUATIONS_PER_HOUR = 20;
/** A longer conversation gets the default, rather than being cut down to fit. */
const MAX_AI_INPUT_CHARS = 200_000;
const MAX_REASON_CHARS = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/** Turns an expiry date and optional time (both UTC) into an instant. A date alone means the end of that day. */
export function expiryInstant(date: string, time: string | null): Date {
  if (!DATE_RE.test(date)) {
    throw badRequest("invalid_expiry", 'expiry_date must be a date like "2026-12-31" (YYYY-MM-DD, UTC)');
  }
  if (time !== null && !TIME_RE.test(time)) {
    throw badRequest("invalid_expiry", 'expiry_time must be a UTC time like "13:30" (HH:MM, 24-hour)');
  }
  const clock = time === null ? "23:59:59" : time.length === 5 ? `${time}:00` : time;
  const at = new Date(`${date}T${clock}.000Z`);
  // Date turns 30 February into 2 March instead of refusing it, so check the day survived.
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date) {
    throw badRequest("invalid_expiry", `expiry_date ${date} is not a real calendar date`);
  }
  return at;
}

/**
 * Every thesis version has an expiry. The creator's date (and optional time) is used when given.
 * Otherwise ConDex sets it: its AI reads the thesis, and when the AI is off or fails, a fixed default
 * applies. Either way the result records who set it and why.
 */
export async function resolveExpiry(
  ctx: Ctx,
  accountId: string,
  given: { date: string | null; time: string | null },
  thesis: Omit<ThesisForExpiry, "now">,
): Promise<ResolvedExpiry> {
  const now = new Date();
  if (given.date !== null) {
    const at = expiryInstant(given.date, given.time);
    if (at.getTime() <= now.getTime()) {
      throw badRequest("invalid_expiry", `The expiry must be in the future, and ${at.toISOString()} has already passed`);
    }
    return { expiresAt: at.toISOString(), timeGiven: given.time !== null, setBy: "creator", reason: null };
  }
  if (given.time !== null) {
    throw badRequest("invalid_expiry", "expiry_time needs an expiry_date. Send both, or neither to let ConDex set the expiry");
  }

  if (!ctx.expiryAi) return defaultExpiry(now, "ConDex's AI evaluation is not switched on for this server");
  const size = thesis.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (size > MAX_AI_INPUT_CHARS) return defaultExpiry(now, "The conversation is too long for ConDex's AI to evaluate");
  if (!takeAiEvaluation(ctx, accountId, now.getTime())) {
    return defaultExpiry(now, "This account has used its AI evaluations for this hour");
  }
  try {
    const answer = await ctx.expiryAi.evaluate({ ...thesis, now });
    const at = expiryInstant(answer.date, answer.time);
    // The evaluation took time, so compare with the clock as it is now.
    if (at.getTime() <= Date.now()) throw new Error(`it chose ${at.toISOString()}, which has already passed`);
    return {
      expiresAt: at.toISOString(),
      timeGiven: answer.time !== null,
      setBy: "condex_ai",
      reason: tidy(answer.reason) || "ConDex's AI set this expiry from the timeframe of the thesis.",
    };
  } catch (err) {
    console.warn(`Expiry AI failed, so the default expiry was applied: ${err instanceof Error ? err.message : String(err)}`);
    return defaultExpiry(now, "ConDex's AI could not evaluate the thesis this time");
  }
}

function defaultExpiry(now: Date, why: string): ResolvedExpiry {
  const day = new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS).toISOString().slice(0, 10);
  return {
    expiresAt: expiryInstant(day, null).toISOString(),
    timeGiven: false,
    setBy: "condex_default",
    reason: `No expiry date was given. ${why}, so ConDex applied its default: the end of the day ${DEFAULT_EXPIRY_DAYS} days after publishing (UTC).`,
  };
}

/** Counts one AI evaluation against the account's hourly allowance. false when it is used up. */
function takeAiEvaluation(ctx: Ctx, accountId: string, now: number): boolean {
  const fresh = (times: number[]) => times.filter((t) => t > now - HOUR_MS);
  if (ctx.expiryAiUse.size > 1000) {
    for (const [id, times] of ctx.expiryAiUse) if (fresh(times).length === 0) ctx.expiryAiUse.delete(id);
  }
  const recent = fresh(ctx.expiryAiUse.get(accountId) ?? []);
  const allowed = recent.length < AI_EVALUATIONS_PER_HOUR;
  if (allowed) recent.push(now);
  ctx.expiryAiUse.set(accountId, recent);
  return allowed;
}

function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…` : flat;
}
