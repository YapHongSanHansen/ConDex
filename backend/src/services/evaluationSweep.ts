import type { Ctx } from "../context.ts";
import { nowIso } from "../util.ts";
import { evaluateThesis } from "./evaluation.ts";
import type { VersionRow } from "./insights.ts";

/**
 * Evaluates every thesis whose expiry has passed and that has no evaluation yet. Without it a thesis is only
 * evaluated when someone reads it; with it each one is evaluated, and recorded on its token, soon after its
 * expiry ("over time verifying" in the flow drawing). Returns how many it evaluated.
 */
export function sweepEvaluations(ctx: Ctx, limit = 100): number {
  const due = ctx.db.prepare(
    `SELECT v.* FROM insight_versions v LEFT JOIN thesis_evaluations e ON e.token_id = v.token_id
      WHERE e.token_id IS NULL AND v.evaluation_deadline <= ? ORDER BY v.evaluation_deadline LIMIT ?`,
  ).all(nowIso(), limit) as unknown as VersionRow[];
  for (const row of due) evaluateThesis(ctx, row);
  return due.length;
}

/** Runs the sweep every `intervalMs`, without keeping the process alive. */
export function startEvaluationSweep(ctx: Ctx, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      sweepEvaluations(ctx);
    } catch (err) {
      console.error(`evaluation sweep: ${String(err)}`);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
