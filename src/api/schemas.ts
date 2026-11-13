import { z } from "zod";
import { badRequest } from "../errors.ts";
import { ISSUABLE_SCOPES } from "../services/accounts.ts";
import { EVENT_TYPES } from "../services/settlement.ts";

const nearAmount = z.union([z.string(), z.number()]).transform(String);
const decimal = z.union([z.string(), z.number()]).transform(String);

/** What the wallet's NEP-413 signMessage returns, plus the challenge nonce it signed. */
export const verifySignInBody = z.object({
  account_id: z.string().min(2).max(64),
  public_key: z.string().min(1).max(128),
  signature: z.string().min(1).max(256),
  nonce: z.string().min(1).max(128),
  /** Only for redirect wallets (e.g. MyNearWallet): the exact callbackUrl the website gave the wallet. */
  callback_url: z.string().min(1).max(2048).optional(),
  display_name: z.string().min(1).max(80).optional(),
});

export const updateMeBody = z.object({ display_name: z.string().min(1).max(80) });

/** One-click sign-in with this computer's near-cli wallet: only the account is chosen by the caller. */
export const nearCliConnectBody = z.object({ account_id: z.string().min(2).max(80) });

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

/** A condition every thesis records. The message says what to send, for agents that publish without it. */
const condition = (max: number, what: string) =>
  z.string({ error: `is required: ${what}` }).trim().min(1, `is required: ${what}`).max(max);

export const publishBody = z.object({
  title: z.string().min(1).max(200),
  // Thesis conditions.
  market: condition(64, 'what is traded, for example "ETH-USD"'),
  direction: z.enum(["long", "short"], { error: 'must be "long" or "short"' }),
  entry: condition(500, "when to enter, in the creator's words"),
  invalidation: condition(500, "what would prove the idea wrong, in the creator's words"),
  target: z.string().trim().max(500).nullable().optional(),
  summary: z.string().max(1000).nullable().optional(),
  // Expiry, in UTC: expiry_date with an optional expiry_time, or a full ISO expires_at instead.
  // With none of them, ConDex sets the expiry and says so in the response.
  expiry_date: z.string().trim().max(40).nullable().optional(),
  expiry_time: z.string().trim().max(40).nullable().optional(),
  expires_at: z.string().trim().max(40).nullable().optional(),
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
