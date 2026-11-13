"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Pencil } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogClose, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { MockBadge } from "@/components/ui/mock-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { StatusBadge, StatusLegend } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Hint } from "@/components/ui/tooltip";
import { EXPLORER_TX_URL } from "@/lib/config";
import { formatDate, formatNear, isValidNearAccount, truncateAccount, truncateHash } from "@/lib/utils";

function PayoutAccount({ account }: { account: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [value, setValue] = useState(account);
  const error = value && !isValidNearAccount(value) ? "Use a valid NEAR account id, like alice.testnet." : !value ? "Enter an account id." : null;
  const m = useMutation({
    mutationFn: () => api.creators.updatePayoutAccount(value),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["earnings"] }); setConfirming(false); setEditing(false); toast.success("Payout account updated"); },
  });
  return (
    <div className="space-y-2">
      <p className="label-caps flex items-center gap-1.5">Payout account <Hint label="Where your fees are sent." /></p>
      {editing ? (
        <div className="space-y-2">
          <Field label="NEAR account" htmlFor="payout" error={error}>
            <Input id="payout" value={value} onChange={(e) => setValue(e.target.value.trim().toLowerCase())} aria-invalid={!!error} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={!!error || value === account} onClick={() => setConfirming(true)}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(account); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2"><p className="break-all font-mono text-sm">{account}</p><Button variant="ghost" size="icon" aria-label="Edit payout account" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></Button></div>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title="Change payout account?" description="Future fees go to the new account.">
          <p className="break-all font-mono text-sm">{account} → {value}</p>
          <p className="mt-3 text-sm text-muted">Past receipts are unchanged.</p>
          <div className="mt-6 flex justify-end gap-2"><DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose><Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Confirm change</Button></div>
          {m.isError && <p role="alert" className="mt-3 text-sm text-danger">We couldn&apos;t update it. Try again in a moment.</p>}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Summary() {
  const q = useQuery({ queryKey: ["earnings"], queryFn: () => api.creators.getEarnings() });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const cards: [string, string, string][] = [
    ["Total earned", d ? formatNear(d.total_earned) : "", "Trade reported, fee paid."],
    ["Pending", d ? formatNear(d.pending) : "", "Reserved, awaiting a trade report."],
    ["Released", d ? formatNear(d.released) : "", "Expired without a trade."],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, v, help]) => (
        <div key={label} className="space-y-2 rounded-md border border-border bg-surface p-5">
          <p className="label-caps">{label}</p>
          {q.isLoading ? <Skeleton className="h-8 w-24" /> : <p className="font-mono text-2xl tabular-nums">{v}</p>}
          <p className="text-xs text-muted">{help}</p>
        </div>
      ))}
      <div className="rounded-md border border-border bg-surface p-5">{d ? <PayoutAccount key={d.payout_account} account={d.payout_account} /> : <Skeleton className="h-16" />}</div>
    </div>
  );
}

function Receipts() {
  const q = useQuery({ queryKey: ["receipts"], queryFn: () => api.creators.listReceipts() });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!q.data!.length) return <EmptyState title="No receipts yet." body="They appear when a borrower reports a trade." action={<Button asChild variant="primary"><Link href="/publish">Publish your first insight</Link></Button>} />;
  return (
    <div className="space-y-4">
      <StatusLegend statuses={["settled", "pending", "released"]} />
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="label-caps border-b border-border"><tr>{["Date", "Insight", "Borrower", "Fee", "Status", "Transaction"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                <td className="px-4 py-3 font-mono text-xs">{formatDate(r.date)}</td>
                <td className="px-4 py-3 font-mono">{r.market} · v{r.version}</td>
                <td className="px-4 py-3 font-mono text-muted">{truncateAccount(r.borrower)}</td>
                <td className="px-4 py-3 font-mono">{r.status === "released" ? "0 NEAR" : formatNear(r.fee)}</td>
                <td className="px-4 py-3"><StatusBadge status={r.status} /></td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2"><MockBadge />
                    <a href={`${EXPLORER_TX_URL}${r.tx_hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">{truncateHash(r.tx_hash)}<ExternalLink className="h-3 w-3" aria-label="opens explorer" /></a>
                    <CopyButton value={r.tx_hash} label="Copy" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MyInsights() {
  const q = useQuery({ queryKey: ["my-insights"], queryFn: () => api.creators.listMyInsights() });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <Skeleton className="h-48" />;
  if (!q.data!.length) return <EmptyState title="No insights yet." action={<Button asChild variant="primary"><Link href="/publish">Publish your first insight</Link></Button>} />;
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead className="label-caps border-b border-border"><tr>{["Insight", "Status", "Borrows", "Retrievals", "Earned", ""].map((h, i) => <th key={i} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
        <tbody>
          {q.data!.map((i) => (
            <tr key={i.id} className="border-b border-border last:border-0 hover:bg-surface-2">
              <td className="px-4 py-3 font-mono"><Link className="hover:text-accent" href={`/gallery/${i.id}`}>{i.market} · v{i.version}</Link></td>
              <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
              <td className="px-4 py-3 font-mono">{i.borrows}</td>
              <td className="px-4 py-3 font-mono">{i.retrievals}</td>
              <td className="px-4 py-3 font-mono">{formatNear(i.earned)}</td>
              <td className="px-4 py-3 text-right"><Button asChild size="sm" variant="secondary"><Link href={`/publish?from=${i.id}`}>Publish new version</Link></Button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PayoutsView() {
  return (
    <div className="space-y-8">
      <Summary />
      <Tabs defaultValue="receipts">
        <TabsList aria-label="Payout sections"><TabsTrigger value="receipts">Receipts</TabsTrigger><TabsTrigger value="insights">My insights</TabsTrigger></TabsList>
        <div className="pt-5">
          <TabsContent value="receipts"><Receipts /></TabsContent>
          <TabsContent value="insights"><MyInsights /></TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
