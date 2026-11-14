"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import type { Evaluation, ProofOfTrade } from "@/lib/api/wire";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatDate, formatNear, truncateAccount } from "@/lib/utils";

function EvaluationView({ e }: { e: Evaluation }) {
  if (e.status === "pending") {
    return <p className="text-sm text-muted">Not judged yet. ConDex compares the thesis with market data once, after <span className="font-mono text-text">{formatDate(e.deadline)}</span> ({e.source} prices).</p>;
  }
  const Icon = e.conditions_met === true ? CheckCircle2 : e.conditions_met === false ? XCircle : CircleDashed;
  return (
    <div className="space-y-1 text-sm">
      <p className="flex items-center gap-2 font-medium"><Icon className="h-4 w-4" aria-hidden />{e.conditions_met === true ? "Conditions met" : e.conditions_met === false ? "Conditions not met" : "Not judged"} · <span className="font-mono text-xs">{e.outcome}</span></p>
      <p className="text-muted">{e.explanation}</p>
      <p className="font-mono text-[11px] text-muted">{e.reference_price ?? "–"} at publish → {e.final_price ?? "–"} at the deadline · {e.prices_used} prices · {e.source}</p>
    </div>
  );
}

function TradeRow({ p }: { p: ProofOfTrade }) {
  const r = p.trade.result;
  return (
    <li className="space-y-1 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono">{p.order.side} {p.order.quantity} {p.order.market} @ {p.fill.price}</span>
        <StatusBadge status={p.trade.status} />
      </div>
      <p className="text-xs text-muted">{truncateAccount(p.trader)} · filled {formatDate(p.fill.at)} · fee {formatNear(Number(p.fee_paid.near))} · {p.fill.source}</p>
      {r?.available && (
        <p className="font-mono text-xs">
          Closed at {r.exit_price}: <span className={r.outcome === "loss" ? "text-danger" : "text-accent"}>{r.outcome} · {r.pnl} · {r.return_pct}%</span>
        </p>
      )}
      {r && !r.available && r.reason && <p className="text-xs text-muted">{r.reason}</p>}
    </li>
  );
}

/** Public: what is recorded about the thesis, whether it turned out right, and every real trade linked to it. */
export function ProofPanel({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["proof", id], queryFn: () => api.trading.proof(id), refetchInterval: 15_000 });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading || !q.data) return <Skeleton className="h-56" />;
  const { proof_of_thesis: t, evaluation, proofs_of_trade: trades, verified_results: v } = q.data;
  return (
    <section className="space-y-4 rounded-md border border-border bg-surface p-6" aria-label="Proof">
      <div className="flex flex-wrap items-center gap-3"><h2 className="label-caps">Proof</h2>
        <span className={`inline-flex items-center gap-1 text-xs ${t.preserved ? "text-accent" : "text-danger"}`}><ShieldCheck className="h-3.5 w-3.5" aria-hidden />{t.preserved ? "Original conditions preserved" : "Stored content no longer matches its fingerprint"}</span>
      </div>
      <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        {[["Published", formatDate(t.published_at)], ["Access expiry", formatDate(t.expires_at)], ["Evaluation deadline", formatDate(t.evaluation_deadline)]].map(([k, val]) => (
          <div key={k}><dt className="label-caps">{k}</dt><dd className="mt-1 font-mono text-xs">{val}</dd></div>
        ))}
      </dl>
      {t.expiry.set_by !== "creator" && <p className="text-xs text-muted">The creator gave no expiry, so {t.expiry.set_by === "condex_ai" ? "ConDex's AI" : "ConDex"} set it{t.expiry.reason ? `: ${t.expiry.reason}` : "."}</p>}
      <div className="space-y-2 border-t border-border pt-4"><h3 className="label-caps">Did it turn out right?</h3><EvaluationView e={evaluation} /></div>
      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="label-caps">Real trades · {v.trades} closed</h3>
        {v.trades > 0 && <p className="font-mono text-xs">Net return {v.net_return_pct}% · net profit ${v.net_profit_usd} · max drawdown {v.max_drawdown_pct}%</p>}
        {trades.length === 0 ? <p className="text-sm text-muted">No order has been linked to this thesis yet.</p> : (
          <ul className="divide-y divide-border rounded-md border border-border">{trades.map((p) => <TradeRow key={p.receipt_id} p={p} />)}</ul>
        )}
        <p className="text-xs text-muted">{v.costs}</p>
      </div>
    </section>
  );
}
