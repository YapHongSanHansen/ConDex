import type { Ctx } from "../context.ts";
import { transaction } from "../db.ts";
import { ApiError } from "../errors.ts";
import { amount, newId, nowIso, parseNear } from "../util.ts";
import { type Principal, requireScope } from "./accounts.ts";

// Reading is split like a paper behind a paywall: the abstract and the author's accuracy are public, and one
// subscription to ConDex unlocks every full thesis (its conditions and conversation). The subscription fee
// goes to ConDex. It only controls reading: trading needs no subscription, and the creator's usage fee is
// charged on a linked order's first confirmed fill (settlement.ts).
//
// Recorded on the mock ledger until the NEAR adapter exists. The status mirrors the contract's
// subscription_of view (contract/src/subscription.rs), so the adapter can replace it.

interface SubscriptionRow {
  id: string; account_id: string; starts_at: string; ends_at: string; amount_yocto: string; tx: string; created_at: string;
}

/** The subscription terms, as shown on every abstract and in the error when one is needed. */
export function subscriptionTerms(ctx: Ctx) {
  const { feeNear, days, treasuryAccount } = ctx.config.subscription;
  return {
    fee: amount(parseNear(feeNear)),
    period_days: days,
    paid_to: treasuryAccount,
    unlocks: "Every thesis's conditions and conversation. Trading needs no subscription.",
    how: "POST /v1/subscription with your wallet session or a trade key (MCP: condex_subscribe).",
  };
}

/**
 * Pays for one period from the caller's ledger balance. A renewal starts when the current period ends, so
 * renewing early loses nothing. A read-only key cannot spend, so this needs the session or a trade key.
 */
export function subscribe(ctx: Ctx, principal: Principal) {
  requireScope(principal, "trade");
  const { feeNear, days, treasuryAccount } = ctx.config.subscription;
  const feeYocto = parseNear(feeNear);
  return transaction(ctx.db, () => {
    const now = nowIso();
    const current = activeSubscription(ctx, principal.account.id, now);
    const startsAt = current ? current.ends_at : now;
    const row: SubscriptionRow = {
      id: newId("sub"),
      account_id: principal.account.id,
      starts_at: startsAt,
      ends_at: new Date(Date.parse(startsAt) + days * 86_400_000).toISOString(),
      amount_yocto: feeYocto.toString(),
      tx: "",
      created_at: now,
    };
    row.tx = ctx.ledger.chargeSubscription({
      subscriptionId: row.id, payer: principal.account.near_account_id, payee: treasuryAccount, amountYocto: feeYocto,
    }).tx;
    ctx.db.prepare(
      "INSERT INTO subscriptions (id, account_id, starts_at, ends_at, amount_yocto, tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.account_id, row.starts_at, row.ends_at, row.amount_yocto, row.tx, row.created_at);
    return {
      payment: {
        id: row.id, starts_at: row.starts_at, ends_at: row.ends_at, paid: amount(row.amount_yocto), ledger: ctx.ledger.kind, tx: row.tx,
      },
      ...subscriptionStatus(ctx, principal),
    };
  });
}

/** Like the contract's subscription_of: until when the account is subscribed, whether that is still ahead, and the terms. */
export function subscriptionStatus(ctx: Ctx, principal: Principal) {
  const current = activeSubscription(ctx, principal.account.id);
  return {
    account_id: principal.account.near_account_id,
    active: current !== null,
    subscribed_until: current?.ends_at ?? null,
    terms: subscriptionTerms(ctx),
  };
}

/**
 * The period covering `at`, extended by any renewals that follow it without a gap. null when the account has
 * no subscription at that time.
 */
export function activeSubscription(ctx: Ctx, accountId: string, at: string = nowIso()): { ends_at: string } | null {
  const rows = ctx.db.prepare(
    "SELECT starts_at, ends_at FROM subscriptions WHERE account_id = ? AND ends_at > ? ORDER BY starts_at",
  ).all(accountId, at) as Array<{ starts_at: string; ends_at: string }>;
  if (rows.length === 0 || rows[0]!.starts_at > at) return null;
  let endsAt = rows[0]!.ends_at;
  for (const r of rows.slice(1)) {
    if (r.starts_at > endsAt) break;
    if (r.ends_at > endsAt) endsAt = r.ends_at;
  }
  return { ends_at: endsAt };
}

/** Throws 402 `subscription_required`, with the terms, when the caller has no active subscription. */
export function requireSubscription(ctx: Ctx, principal: Principal): { ends_at: string } {
  const current = activeSubscription(ctx, principal.account.id);
  if (current) return current;
  throw new ApiError(
    402,
    "subscription_required",
    "The abstract and the author's accuracy are free. A ConDex subscription unlocks the full thesis.",
    subscriptionTerms(ctx),
  );
}
