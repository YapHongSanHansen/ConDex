import { z } from "zod";
import { badRequest } from "../errors.ts";
import { ISSUABLE_SCOPES } from "../services/accounts.ts";
import { EVENT_TYPES } from "../services/settlement.ts";

const nearAmount = z.union([z.string(), z.number()]).transform(String);
const decimal = z.union([z.string(), z.number()]).transform(String);

export const createAccountBody = z.object({
  near_account_id: z.string().min(2).max(64),
  display_name: z.string().min(1).max(80),
});

export const issueKeyBody = z.object({
  scopes: z.array(z.enum(ISSUABLE_SCOPES)).min(1),
  label: z.string().min(1).max(80).optional(),
  token_ids: z.array(z.string().min(1)).max(100).nullable().optional(),
  expires_in_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).nullable().optional(),
});

export const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string().min(1).max(20_000),
  at: z.string().max(40).optional(),
});

export const publishBody = z.object({
  title: z.string().min(1).max(200),
  market: z.string().min(1).max(64).nullable().optional(),
  summary: z.string().max(1000).nullable().optional(),
  expires_at: z.string().nullable().optional(),
  fee_near: nearAmount,
  payout_account: z.string().nullable().optional(),
  messages: z.array(messageSchema).min(1).max(200),
});

export const depositBody = z.object({ amount_near: nearAmount });

export const quoteBody = z.object({ token_id: z.string().min(1) });

export const orderBody = z.object({
  quote_id: z.string().min(1),
  side: z.enum(["buy", "sell"]),
  quantity: decimal,
  market: z.string().min(1).max(64).nullable().optional(),
  limit_price: decimal.nullable().optional(),
  authorise_fee: z.boolean(),
});

export const executionEventBody = z.object({
  event_id: z.string().min(1).max(128),
  order_id: z.string().min(1),
  type: z.enum(EVENT_TYPES),
  quantity: decimal.nullable().optional(),
  price: decimal.nullable().optional(),
  source: z.string().min(1),
});

export const simBody = z.object({
  quantity: decimal.optional(),
  price: decimal.optional(),
});

export function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const summary = issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
    throw badRequest("invalid_request", summary, issues);
  }
  return result.data;
}
