import type { Ctx } from "../context.ts";
import { nowIso } from "../util.ts";
import { evaluateThesis } from "./evaluation.ts";
import type { VersionRow } from "./insights.ts";

/** Every thesis whose evaluation deadline has passed and that has no evaluation yet, oldest deadline first. */
function dueTheses(ctx: Ctx, limit: number): VersionRow[] {
  return ctx.db.prepare(
    `SELECT v.* FROM insight_versions v LEFT JOIN thesis_evaluations e ON e.token_id = v.token_id
      WHERE e.token_id IS NULL AND v.evaluation_deadline <= ? ORDER BY v.evaluation_deadline LIMIT ?`,
  ).all(nowIso(), limit) as unknown as VersionRow[];
}

/**
 * Evaluates every thesis whose expiry has passed and that has no evaluation yet. Without it a thesis is only
 * evaluated when someone reads it; with it each one is evaluated, and recorded on its token, soon after its
 * expiry ("over time verifying" in the flow drawing). Returns how many it evaluated. A thesis whose prices
 * the feed does not hold yet is left for a later round.
 */
export function sweepEvaluations(ctx: Ctx, limit = 100): number {
  let evaluated = 0;
  for (const row of dueTheses(ctx, limit)) if (evaluateThesis(ctx, row)) evaluated++;
  return evaluated;
}

/** Warnings already printed, so a thesis the feed cannot price is reported once and not every minute. */
const warned = new Set<string>();

/**
 * Has the feed fetch the prices each due thesis still needs. This is the only place a live feed is asked for
 * data on behalf of the evaluation, and it runs outside every read path and database transaction. A failure
 * leaves that thesis pending and moves on to the next. Returns how many windows it fetched.
 */
export async function loadDueCandles(ctx: Ctx, limit = 100): Promise<number> {
  let loaded = 0;
  for (const row of dueTheses(ctx, limit)) {
    if (ctx.market.covers(row.market, row.created_at, row.evaluation_deadline)) continue;
    try {
      await ctx.market.load(row.market, row.created_at, row.evaluation_deadline);
      loaded++;
    } catch (err) {
      const warning = `market data for ${row.token_id}: ${(err as Error).message}`;
      if (!warned.has(warning)) {
        warned.add(warning);
        console.warn(`${warning}. Its evaluation stays pending.`);
      }
    }
  }
  return loaded;
}

/** Fetches what is missing and runs the sweep every `intervalMs`, without keeping the process alive. */
export function startEvaluationSweep(ctx: Ctx, intervalMs = 60_000): NodeJS.Timeout {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // the last round is still fetching
    busy = true;
    try {
      await loadDueCandles(ctx);
      sweepEvaluations(ctx);
    } catch (err) {
      console.error(`evaluation sweep: ${String(err)}`);
    } finally {
      busy = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
