"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Order } from "@/lib/api/wire";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { StatusBadge, StatusLegend } from "@/components/ui/status-badge";
import { SignInGate } from "@/components/ui/sign-in-gate";
import { useWallet } from "@/lib/near/connector";
import { formatDate, formatNear } from "@/lib/utils";
import { OrderDrawer } from "./order-drawer";

/** An order whose position is open and has no closing order waiting. */
function closable(o: Order): boolean {
  return !!o.trade && o.trade.status !== "closed" && Number(o.trade.open_quantity) > 0 && !o.closing_orders.some((c) => c.status === "open" || c.status === "submitted");
}

function Result({ o }: { o: Order }) {
  const r = o.trade?.result;
  if (!o.trade) return <span className="text-muted">n/a</span>;
  if (r?.available) return <span className={r.outcome === "loss" ? "text-danger" : "text-accent"}>{r.pnl} · {r.return_pct}%</span>;
  return <StatusBadge status={o.trade.status} />;
}

/** The orders this wallet linked to theses: their status, the fee, and the trade result once closed. */
export function OrdersTable() {
  const { signedIn } = useWallet();
  const q = useQuery({ queryKey: ["orders"], queryFn: () => api.trading.listOrders(), enabled: signedIn, refetchInterval: 10_000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const current = q.data?.find((o) => o.id === openId) ?? null;

  return (
    <section id="orders" aria-labelledby="orders-h" className="scroll-mt-24 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="orders-h" className="text-lg font-semibold">Your orders</h2>
        <StatusLegend statuses={["open", "filled", "cancelled", "closed"]} />
      </div>
      {!signedIn ? <SignInGate why="to see the orders you placed" />
        : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.isLoading ? <Skeleton className="h-48" />
        : q.data!.length === 0 ? <EmptyState title="No orders yet." body="Open a thesis in the gallery, subscribe if you want to read it, and place an order linked to it." action={<Button asChild variant="primary"><Link href="/gallery">Browse theses</Link></Button>} />
        : (
          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="label-caps border-b border-border"><tr>{["Order", "Status", "Fee", "Result", "Created", "Actions"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {q.data!.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3"><button className="cursor-pointer text-left font-mono hover:text-accent" onClick={() => setOpenId(o.id)}>{o.side} {o.quantity} {o.market}</button><div className="font-mono text-[11px] text-muted">{o.id}</div></td>
                    <td className="px-4 py-3"><StatusBadge status={o.status} /></td>
                    <td className="px-4 py-3 font-mono">{formatNear(Number(o.fee.near))} <span className="text-xs text-muted">{o.settlement.status}</span></td>
                    <td className="px-4 py-3 font-mono text-xs"><Result o={o} /></td>
                    <td className="px-4 py-3 font-mono text-xs">{formatDate(o.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Button asChild size="sm" variant="ghost"><Link href={`/gallery/${o.token_id}`}>Open thesis</Link></Button>
                        <Button size="sm" variant={closable(o) ? "secondary" : "ghost"} onClick={() => setOpenId(o.id)}>{closable(o) ? "Close trade" : "Details"}</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      <OrderDrawer order={current} onClose={() => setOpenId(null)} />
    </section>
  );
}
