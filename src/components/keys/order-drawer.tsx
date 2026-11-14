"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { api, friendlyError, toApiError } from "@/lib/api";
import type { Order } from "@/lib/api/wire";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { DemoVenueLink } from "./demo-venue";
import { useChainActions } from "@/lib/near/use-chain";
import { formatDate, formatNear } from "@/lib/utils";

function Timeline({ o }: { o: Order }) {
  const filled = Number(o.filled_quantity) > 0;
  const t = o.trade;
  const rows = [
    { label: "Order linked to the thesis", detail: `Checked: ${o.thesis_match.checked.join(", ").replace(/_/g, " ")}. Fee ${formatNear(Number(o.fee.near))} reserved.`, at: o.thesis_match.authorised_at, done: true },
    { label: "First fill", detail: filled ? `${o.filled_quantity} filled. The fee was charged once and paid to the creator.` : "Waiting for the venue. No fill, no fee.", at: filled ? (o.execution_events.find((e) => e.type === "fill")?.received_at ?? o.updated_at) : null, done: filled },
    { label: "Closed", detail: t?.status === "closed" ? (t.result?.available ? `Entry ${t.result.entry_price}, exit ${t.result.exit_price}: ${t.result.outcome}, ${t.result.pnl} (${t.result.return_pct}%).` : "Closed.") : t ? `${t.open_quantity} still open. Closing is free.` : "Not open yet.", at: t?.closing_fill?.at ?? null, done: t?.status === "closed" },
  ];
  return (
    <ol className="space-y-4 border-l border-border pl-5">
      {rows.map((r) => (
        <li key={r.label} className="relative">
          <span className="absolute -left-[31px] top-0.5 bg-surface">{r.done ? <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden /> : <Circle className="h-4 w-4 text-muted" aria-hidden />}</span>
          <p className="font-medium">{r.label}</p>
          <p className="text-sm text-muted">{r.detail}</p>
          {r.at && <p className="font-mono text-[11px] text-muted">{formatDate(r.at)}</p>}
        </li>
      ))}
    </ol>
  );
}

export function OrderDrawer({ order, onClose }: { order: Order | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["orders"] }); qc.invalidateQueries({ queryKey: ["proof"] }); qc.invalidateQueries({ queryKey: ["balances"] }); };
  const close = useMutation({
    mutationFn: () => api.trading.closeOrder(order!.id, { quantity: qty.trim() || null }),
    onSuccess: refresh,
  });
  const chain = useChainActions();
  const approve = useMutation({ mutationFn: () => chain.approve(order!), onSuccess: refresh });
  const dismiss = () => { setQty(""); close.reset(); onClose(); };
  const err = close.isError ? friendlyError(toApiError(close.error)) : approve.isError ? friendlyError(toApiError(approve.error)) : null;
  const canClose = !!order?.trade && order.trade.status !== "closed" && Number(order.trade.open_quantity) > 0 && !order.closing_orders.some((c) => c.status === "open" || c.status === "submitted");
  const pendingClose = order?.closing_orders.find((c) => c.status === "open" || c.status === "submitted");

  return (
    <Dialog open={!!order} onOpenChange={(o) => { if (!o) dismiss(); }}>
      {order && (
        <DialogContent side="right" title={`${order.side} ${order.quantity} ${order.market}`} description={`Order ${order.id}`}>
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={order.status} />{order.trade && <StatusBadge status={order.trade.status} />}</div>
            <Timeline o={order} />
            <p className="rounded-md border border-border p-3 text-sm text-muted">The fee depends on the fill, not on the result. A loss still counts in the creator&apos;s record, and closing a trade costs nothing.</p>

            {order.status === "awaiting_approval" && (
              <div role="status" className="space-y-2 rounded-md border border-warning/50 p-3 text-sm">
                <p className="text-warning">This order waits for you to approve the fee in your wallet. Nothing is reserved until you do.</p>
                <Button variant="primary" size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>Approve the fee in your wallet</Button>
              </div>
            )}
            {canClose && (
              <div className="space-y-2 border-t border-border pt-5">
                <h3 className="label-caps">Close the position</h3>
                <label htmlFor="close-qty" className="text-sm text-muted">Quantity to close (open: {order.trade!.open_quantity}). Leave empty to close it all.</label>
                <Input id="close-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
                <Button variant="primary" loading={close.isPending} onClick={() => close.mutate()}>Place the closing order</Button>
              </div>
            )}
            {pendingClose && <p role="status" className="text-sm text-muted">Closing order {pendingClose.id} is {pendingClose.status}.</p>}
            {(order.status === "open" || order.status === "submitted" || !!pendingClose) && <DemoVenueLink orderId={pendingClose?.id ?? order.id} />}
            {err && <div role="alert" className="rounded-md border border-danger/50 p-3 text-sm"><p className="text-danger">{err.title}</p><p className="text-muted">{err.next}</p></div>}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
