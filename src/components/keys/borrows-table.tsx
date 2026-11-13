"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Borrow } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { StatusBadge, StatusLegend } from "@/components/ui/status-badge";
import { useNow } from "@/hooks/use-now";
import { formatNear, timeUntil } from "@/lib/utils";
import { BorrowDrawer } from "./borrow-drawer";

export function BorrowsTable() {
  const qc = useQueryClient();
  const now = useNow();
  const q = useQuery({ queryKey: ["borrows"], queryFn: () => api.borrows.listBorrows() });
  const [open, setOpen] = useState<Borrow | null>(null);
  const [revoking, setRevoking] = useState<Borrow | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.borrows.revokeBorrow(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["borrows"] }); setRevoking(null); },
  });
  // Keep the drawer in sync with refetched data.
  const current = open ? q.data?.find((b) => b.id === open.id) ?? open : null;

  return (
    <section aria-labelledby="borrows" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="borrows" className="text-lg font-semibold">Your borrows</h2>
        <StatusLegend statuses={["active", "retrieved", "traded", "expired", "revoked"]} />
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.isLoading ? <Skeleton className="h-64" />
        : q.data!.length === 0 ? <EmptyState title="No borrows yet." body="Borrow an insight from the gallery and it will appear here." action={<Button asChild variant="primary"><Link href="/gallery">Browse the gallery</Link></Button>} />
        : (
          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="label-caps border-b border-border"><tr>{["Insight", "Status", "Reserved cap", "Charged", "Expires in", "Actions"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {q.data!.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3"><button className="cursor-pointer text-left font-mono hover:text-accent" onClick={() => setOpen(b)}>{b.market} · v{b.insight_version}</button><div className="font-mono text-[11px] text-muted">{b.id}</div></td>
                    <td className="px-4 py-3"><StatusBadge status={b.status} /></td>
                    <td className="px-4 py-3 font-mono">{formatNear(b.fee_cap)}</td>
                    <td className="px-4 py-3 font-mono">{formatNear(b.charged)}</td>
                    <td className="px-4 py-3 font-mono">{b.status === "active" || b.status === "retrieved" ? timeUntil(b.expires_at, now) : "n/a"}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Button asChild size="sm" variant="ghost"><Link href={`/gallery/${b.insight_id}`}>Open insight</Link></Button>
                        <Button size="sm" variant="ghost" onClick={() => setOpen(b)}>{b.status === "traded" ? "View receipt" : "Details"}</Button>
                        {(b.status === "active" || b.status === "retrieved") && <Button size="sm" variant="danger" onClick={() => setRevoking(b)}>Revoke</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      <BorrowDrawer borrow={current} onClose={() => setOpen(null)} />

      <Dialog open={!!revoking} onOpenChange={(o) => { if (!o) setRevoking(null); }}>
        {revoking && (
          <DialogContent title="Revoke this key?" description={`${revoking.market} · ${revoking.id}`}>
            <p className="text-sm leading-relaxed text-muted">The key stops working for new requests right away and the reserved {formatNear(revoking.fee_cap)} is released. Nothing is charged because no trade was reported. You&apos;d need to borrow again to get a new key.</p>
            <div className="mt-6 flex justify-end gap-2">
              <DialogClose asChild><Button variant="ghost">Keep key</Button></DialogClose>
              <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(revoking.id)}>Revoke key</Button>
            </div>
            {revoke.isError && <p role="alert" className="mt-3 text-sm text-danger">We couldn&apos;t revoke the key. Try again in a moment.</p>}
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
