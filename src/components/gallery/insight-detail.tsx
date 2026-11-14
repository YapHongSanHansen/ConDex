"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Lock } from "lucide-react";
import { api } from "@/lib/api";
import type { InsightDetail } from "@/lib/api/types";
import { CopyButton } from "@/components/ui/copy-button";
import { MockBadge } from "@/components/ui/mock-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { DISCLAIMER } from "@/components/layout/page-header";
import { EXPLORER_TX_URL } from "@/lib/config";
import { formatDate, formatNear, timeUntil } from "@/lib/utils";
import { ProofPanel } from "./proof-panel";
import { TradePanel } from "./trade-panel";

export function InsightDetailView({ id }: { id: string }) {
  const q = useQuery({ queryKey: ["insight", id], queryFn: () => api.insights.getInsight(id) });
  return (
    <div className="container-wide space-y-6 py-10">
      <Link href="/gallery" className="inline-flex items-center gap-2 text-sm text-muted hover:text-text"><ArrowLeft className="h-4 w-4" />Back to gallery</Link>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading || !q.data ? (
        <div className="grid gap-8 lg:grid-cols-[1.4fr_1fr]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
      ) : (
        <Detail i={q.data} />
      )}
    </div>
  );
}

function Detail({ i }: { i: InsightDetail }) {
  return (
    // On a phone the panel follows the preview, so reading and trading are not buried under the proof.
    <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr] lg:items-start">
        <section className="space-y-4 rounded-md border border-border bg-surface p-6 lg:col-start-1" aria-label="Public preview">
          <div className="flex flex-wrap items-center gap-3"><p className="label-caps">Preview</p><StatusBadge status={i.status} /></div>
          <h1 className="font-mono text-3xl font-semibold">{i.market}</h1>
          <p className="text-lg">{i.title}</p>
          {i.summary && <p className="text-sm text-muted">{i.summary}</p>}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[["Direction", i.direction], ["Fee per filled trade", formatNear(i.price)], ["Version", `v${i.version}`], ["Expires in", timeUntil(i.expires_at)]].map(([k, v]) => (
              <div key={k}><dt className="label-caps">{k}</dt><dd className="mt-1 font-mono text-lg">{v}</dd></div>
            ))}
          </dl>
          <p className="flex items-center gap-2 rounded-md border border-dashed border-border p-3 text-sm text-muted"><Lock className="h-4 w-4 shrink-0" aria-hidden />The entry, invalidation and conversation are private: subscribers read them on the right. The creator&apos;s accuracy: {i.accuracy_pct === null ? "not judged yet" : `${i.accuracy_pct}% of ${i.judged} judged`}.</p>
        </section>

      <TradePanel insight={i} />

      <div className="space-y-6 lg:col-start-1">
                <section className="space-y-3" aria-label="Version history">
          <h2 className="label-caps">Versions</h2>
          <ul className="divide-y divide-border rounded-md border border-border bg-surface">
            {[...i.versions].reverse().map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <Link href={`/gallery/${v.id}`} className="font-mono hover:text-accent">v{v.version}{v.version === i.version ? " · current" : ""}</Link>
                <span className="font-mono text-xs text-muted">{v.version_hash.slice(0, 18)}…</span>
                <span className="text-xs text-muted">{formatDate(v.created_at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-3 rounded-md border border-border bg-surface p-6" aria-label="Registered on NEAR">
          <div className="flex items-center gap-3"><h2 className="label-caps">On NEAR testnet</h2><MockBadge /></div>
          <div className="space-y-2 text-sm">
            <p className="label-caps">Version hash · creator <span className="normal-case tracking-normal text-text">{i.creator}</span></p>
            <div className="flex flex-wrap items-center gap-3"><code className="break-all font-mono text-xs">{i.version_hash}</code><CopyButton value={i.version_hash} /></div>
            {i.register_tx_hash ? (
              <a className="inline-flex items-center gap-2 text-accent hover:underline" href={`${EXPLORER_TX_URL}${i.register_tx_hash}`} target="_blank" rel="noreferrer">View on explorer <ExternalLink className="h-3.5 w-3.5" /></a>
            ) : <p className="text-muted">Not available yet.</p>}
          </div>
        </section>
        <ProofPanel id={i.id} />
        <p className="text-xs text-muted">{DISCLAIMER}</p>
      </div>
    </div>
  );
}
