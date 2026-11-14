import type { Ctx } from "../context.ts";
import { badRequest } from "../errors.ts";

/** Who set a thesis's expiry: its creator, ConDex's AI, or ConDex's default when the AI did not set one. */
export type ExpirySetBy = "creator" | "condex_ai" | "condex_default";

export interface ResolvedExpiry {
  /** ISO 8601, UTC: the last moment a trade can be linked to the thesis. */
  expiresAt: string;
  /** false when only a day was set: the thesis then expires at the end of that day. */
  timeGiven: boolean;
  setBy: ExpirySetBy;
  /** Why ConDex chose this expiry. null when the creator set it. */
  reason: string | null;
}

/** The expiry as the creator may give it. All null means ConDex sets it. */
export interface ExpiryInput {
  /** A UTC calendar day, "YYYY-MM-DD". */
  date: string | null;
  /** Time on that day in UTC, "HH:MM". Without it the thesis expires at the end of the day. */
  time: string | null;
  /** Instead of a date and time: a full ISO 8601 instant. */
  instant: string | null;
}

/** The thesis as it is about to be published: what ConDex's AI reads to choose an expiry. */
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

/** What ConDex's AI answers. */
export interface ExpiryEvaluation {
  /** ISO 8601 instant, UTC. */
  expiresAt: string;
  /** false when it chose a day without a time, so the thesis expires at the end of that day. */
  timeGiven: boolean;
  /** One or two sentences. Recorded in the proof of thesis, so anyone can read it. */
  reason: string;
}

/** ConDex's AI: reads a thesis whose creator gave no expiry and chooses one. */
export interface ExpiryEvaluator {
  /** The model that answers, shown at startup. */
  readonly model: string;
  evaluate(thesis: ThesisForExpiry): Promise<ExpiryEvaluation>;
}

/** Applied when the creator gave no expiry and ConDex's AI did not set one. */
export const DEFAULT_EXPIRY_DAYS = 7;
/** The AI may not set an expiry further out than this, so a vague thesis cannot stay open indefinitely. */
export const MAX_AI_EXPIRY_DAYS = 30;
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

/** How long after the expiry a creator may set the evaluation deadline. */
export const MAX_EVALUATION_DAYS = 30;

/**
 * The evaluation deadline: the moment up to which market prices are used to judge the thesis. It is separate from
 * the expiry (the last moment a trade can be linked), so a trade opened just before the expiry has time to play out.
 * The creator gives a date (the end of that day, UTC) or a full instant. Without one it is the expiry.
 */
export function evaluationDeadline(given: string | null, expiresAt: string): string {
  if (given === null) return expiresAt;
  const at = DATE_RE.test(given) ? expiryInstant(given, null) : new Date(given);
  if (Number.isNaN(at.getTime())) {
    throw badRequest("invalid_evaluation_deadline", 'evaluation_deadline must be a date like "2026-12-31" or an ISO 8601 date-time like "2026-12-31T13:30:00Z"');
  }
  const expiry = Date.parse(expiresAt);
  if (at.getTime() < expiry) {
    throw badRequest("invalid_evaluation_deadline", `The evaluation deadline cannot be before the expiry (${expiresAt})`);
  }
  if (at.getTime() > expiry + MAX_EVALUATION_DAYS * DAY_MS) {
    throw badRequest("invalid_evaluation_deadline", `The evaluation deadline can be at most ${MAX_EVALUATION_DAYS} days after the expiry`);
  }
  return at.toISOString();
}

/**
 * The creator's own expiry, if they gave one: a date with an optional UTC time, or a full instant.
 * null when they gave none, so ConDex sets it. Throws when what they gave is unusable.
 */
export function creatorExpiry(given: ExpiryInput, now = new Date()): { expiresAt: string; timeGiven: boolean } | null {
  let at: Date;
  let timeGiven = true;
  if (given.date !== null) {
    if (given.instant !== null) {
      throw badRequest("invalid_expiry", "Send expiry_date (with an optional expiry_time) or expires_at, not both");
    }
    at = expiryInstant(given.date, given.time);
    timeGiven = given.time !== null;
  } else if (given.time !== null) {
    throw badRequest("invalid_expiry", "expiry_time needs an expiry_date. Send both, or neither to let ConDex set the expiry");
  } else if (given.instant !== null) {
    at = new Date(given.instant);
    if (Number.isNaN(at.getTime())) {
      throw badRequest("invalid_expiry", 'expires_at must be an ISO 8601 date-time like "2026-12-31T13:30:00Z", or send expiry_date (YYYY-MM-DD) instead');
    }
  } else {
    return null;
  }
  if (at.getTime() <= now.getTime()) {
    throw badRequest("invalid_expiry", `The expiry must be in the future, and ${at.toISOString()} has already passed`);
  }
  return { expiresAt: at.toISOString(), timeGiven };
}

/**
 * Every thesis version has an expiry. The creator's own is used when given. Otherwise ConDex sets it:
 * its AI reads the thesis, and when the AI is off or gives no usable answer, a fixed default applies.
 * Either way the result records who set it and why, so nothing is ever published without an expiry.
 */
export async function resolveExpiry(
  ctx: Ctx,
  accountId: string,
  given: ExpiryInput,
  thesis: Omit<ThesisForExpiry, "now">,
): Promise<ResolvedExpiry> {
  const now = new Date();
  const own = creatorExpiry(given, now);
  if (own) return { ...own, setBy: "creator", reason: null };

  if (!ctx.expiryAi) return defaultExpiry(now, "ConDex's AI evaluation is not switched on for this server");
  const size = thesis.messages.reduce((sum, m) => sum + m.content.length, 0);
  if (size > MAX_AI_INPUT_CHARS) return defaultExpiry(now, "The conversation is too long for ConDex's AI to evaluate");
  if (!takeAiEvaluation(ctx, accountId, now.getTime())) {
    return defaultExpiry(now, "This account has used its AI evaluations for this hour");
  }
  try {
    const answer = await ctx.expiryAi.evaluate({ ...thesis, now });
    return {
      expiresAt: usableInstant(answer.expiresAt, now),
      timeGiven: answer.timeGiven,
      setBy: "condex_ai",
      reason: tidy(answer.reason) || "ConDex's AI set this expiry from the timeframe of the thesis.",
    };
  } catch (err) {
    console.warn(`Expiry AI failed, so the default expiry was applied: ${err instanceof Error ? err.message : String(err)}`);
    return defaultExpiry(now, "ConDex's AI could not evaluate the thesis this time");
  }
}

/** The AI's answer must be a real moment, still ahead, and no further out than the limit. */
function usableInstant(answer: string, asked: Date): string {
  const at = Date.parse(answer);
  if (Number.isNaN(at)) throw new Error("it gave an expiry that is not a date");
  // The evaluation took time, so compare with the clock as it is now.
  if (at <= Date.now()) throw new Error(`it chose ${new Date(at).toISOString()}, which has already passed`);
  if (at > asked.getTime() + MAX_AI_EXPIRY_DAYS * DAY_MS) {
    throw new Error(`it chose an expiry more than ${MAX_AI_EXPIRY_DAYS} days away`);
  }
  return new Date(at).toISOString();
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
