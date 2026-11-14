"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { MockBadge } from "@/components/ui/mock-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { SignInGate } from "@/components/ui/sign-in-gate";
import { StatusBadge } from "@/components/ui/status-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Hint } from "@/components/ui/tooltip";
import { EXPLORER_TX_URL } from "@/lib/config";
import { useWallet } from "@/lib/near/connector";
import { formatDate, formatNear, truncateHash } from "@/lib/utils";

function Summary({ account }: { account: string }) {
  const earn = useQuery({ queryKey: ["earnings", account], queryFn: () => api.creators.earnings(account) });
  const prof = useQuery({ queryKey: ["profile", account], queryFn: () => api.creators.profile(account), retry: false });
  if (earn.isError) return <ErrorState error={earn.error} onRetry={() => earn.refetch()} />;
  const e = earn.data;
  const p = prof.data;
  const score = p?.score;
  const cards: [string, string, string][] = [
    ["Fees earned", e ? formatNear(e.earned) : "", "Paid when a linked order first fills, whatever the result."],
    ["Available", e ? formatNear(e.available) : "", "In your balance, free to use or withdraw."],
    ["Accuracy", score ? (score.accuracy.accuracy_pct === null ? "n/a" : `${score.accuracy.accuracy_pct}%`) : "", score ? `${score.accuracy.met} of ${score.accuracy.evaluated} judged theses met their conditions. ${score.accuracy.pending} waiting.` : "Judged against market data after each thesis's evaluation deadline."],
    ["Traders' results", score ? `${score.borrowers.net_return_pct}%` : "", score ? `${score.borrowers.trades} closed trades · $${score.borrowers.net_profit_usd} · max drawdown ${score.borrowers.max_drawdown_pct}%` : "What real trades of your theses returned."],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, v, help]) => (
        <div key={label} className="space-y-2 rounded-md border border-border bg-surface p-5">
          <p className="label-caps">{label}</p>
          {earn.isLoading || (prof.isLoading && label !== "Fees earned" && label !== "Available") ? <Skeleton className="h-8 w-24" /> : <p className="font-mono text-2xl tabular-nums">{v || "n/a"}</p>}
          <p className="text-xs text-muted">{help}</p>
        </div>
      ))}
      <div className="space-y-2 rounded-md border border-border bg-surface p-5 sm:col-span-2 xl:col-span-4">
        <p className="label-caps flex items-center gap-1.5">Payout account <Hint label="The payout account is set on each thesis when it is published. It is fixed in the thesis." /></p>
        <p className="break-all font-mono text-sm">{(p?.stats.payout_accounts.length ? p.stats.payout_accounts : [account]).join(", ")}</p>
        <p className="text-xs text-muted">By default your own wallet. A thesis pays the account named when it was published, and that cannot change afterwards.</p>
      </div>
    </div>
  );
}

function Receipts() {
  const q = useQuery({ queryKey: ["receipts"], queryFn: () => api.creators.receipts() });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (!q.data!.length) return <EmptyState title="No receipts yet." body="A receipt appears when an order linked to a thesis first fills." action={<Button asChild variant="primary"><Link href="/publish">Publish a thesis</Link></Button>} />;
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full min-w-[860px] text-left text-sm">
        <thead className="label-caps border-b border-border"><tr>{["Date", "Thesis", "Role", "Fee", "Evidence", "Transaction"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
        <tbody>
          {q.data!.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
              <td className="px-4 py-3 font-mono text-xs">{formatDate(r.date)}</td>
              <td className="px-4 py-3 font-mono"><Link className="hover:text-accent" href={`/gallery/${r.insight_id}`}>{r.market} · v{r.version}</Link></td>
              <td className="px-4 py-3"><StatusBadge status={r.role === "earned" ? "settled" : "released"} /> <span className="text-xs text-muted">{r.role}</span></td>
              <td className="px-4 py-3 font-mono">{formatNear(r.fee)}</td>
              <td className="px-4 py-3 text-xs text-muted">{r.evidence}</td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">{r.ledger === "mock" && <MockBadge />}
                  {r.ledger === "mock" ? <span className="font-mono text-xs">{truncateHash(r.tx_hash)}</span> : (
                    <a href={`${EXPLORER_TX_URL}${r.tx_hash}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline">{truncateHash(r.tx_hash)}<ExternalLink className="h-3 w-3" aria-label="opens explorer" /></a>
                  )}
                  <CopyButton value={r.tx_hash} label="Copy" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MyInsights({ account }: { account: string }) {
  const q = useQuery({ queryKey: ["profile", account], queryFn: () => api.creators.profile(account), retry: false });
  if (q.isError) return <EmptyState title="No theses yet." body="Publish one from your agent and it appears here." action={<Button asChild variant="primary"><Link href="/publish">Publish a thesis</Link></Button>} />;
  if (q.isLoading) return <Skeleton className="h-48" />;
  const { tokens, stats } = q.data!;
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs text-muted">{stats.insights} theses · {stats.reads} reads · {stats.paid_orders} paid orders · {formatNear(Number(stats.fees_paid.near))} in fees</p>
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="label-caps border-b border-border"><tr>{["Thesis", "Status", "Fee per filled trade", "Expires", ""].map((h, i) => <th key={i} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.token_id} className="border-b border-border last:border-0 hover:bg-surface-2">
                <td className="px-4 py-3 font-mono"><Link className="hover:text-accent" href={`/gallery/${t.token_id}`}>{t.market} · v{t.version}</Link><div className="text-[11px] text-muted">{t.title}</div></td>
                <td className="px-4 py-3"><StatusBadge status={t.expired ? "expired" : "live"} /></td>
                <td className="px-4 py-3 font-mono">{formatNear(Number(t.fee_per_filled_order.near))}</td>
                <td className="px-4 py-3 font-mono text-xs">{formatDate(t.expires_at)}</td>
                <td className="px-4 py-3 text-right"><Button asChild size="sm" variant="secondary"><Link href={`/publish?from=${t.insight_id}`}>New version</Link></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function PayoutsView() {
  const { accountId } = useWallet();
  return (
    <SignInGate why="to see your earnings and receipts">
      {accountId && (
        <div className="space-y-8">
          <Summary account={accountId} />
          <Tabs defaultValue="receipts">
            <TabsList aria-label="Payout sections"><TabsTrigger value="receipts">Receipts</TabsTrigger><TabsTrigger value="insights">My theses</TabsTrigger></TabsList>
            <div className="pt-5">
              <TabsContent value="receipts"><Receipts /></TabsContent>
              <TabsContent value="insights"><MyInsights account={accountId} /></TabsContent>
            </div>
          </Tabs>
        </div>
      )}
    </SignInGate>
  );
}
