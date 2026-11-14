"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShieldCheck } from "lucide-react";
import { api, friendlyError, horizonOf, toApiError } from "@/lib/api";
import type { InsightDetail } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { DISCLAIMER } from "@/components/layout/page-header";
import { CreatorSetup, EXPORT_PROMPT } from "@/components/keys/creator-setup";
import { CodeBlock } from "@/components/ui/code-block";
import { registerInsight } from "@/lib/near/contract";
import { useWallet } from "@/lib/near/connector";
import { cn, defaultExpiryIso, formatDate, formatNear } from "@/lib/utils";
import { PublicPreview } from "./preview";
import { EMPTY_DRAFT, toLocalInput, validate, type Draft } from "./types";

const STEPS = ["Connect", "Export", "Define", "Register"];

export function PublishFlow() {
  const from = useSearchParams().get("from");
  const { accountId, connect, getWallet, connecting } = useWallet();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [done, setDone] = useState<InsightDetail | null>(null);
  const set = (p: Partial<Draft>) => { setDraft((d) => ({ ...d, ...p })); setDirty(true); };

  const exportsQ = useQuery({ queryKey: ["exports"], queryFn: () => api.creators.listExports(), enabled: step === 1 && !!accountId });
  const selected = exportsQ.data?.find((e) => e.id === draft.exportId) ?? null;
  const simulate = useMutation({
    mutationFn: () => api.creators.simulateExport!(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["exports"] }),
  });

  const pick = (id: string) => {
    const e = exportsQ.data?.find((x) => x.id === id);
    if (!e) return;
    set({ exportId: id, market: e.suggested_market, expiry: e.suggested_expires_at ? toLocalInput(e.suggested_expires_at) : "" });
  };

  useEffect(() => {
    if (!dirty || done) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty, done]);

  const errors = useMemo(() => validate(draft), [draft]);
  const canAdvance = step === 0 ? !!accountId : step === 1 ? !errors.exportId : step === 2 ? !errors.market && !errors.direction && !errors.entry && !errors.invalidation && !errors.target && !errors.expiry && !errors.fee : false;
  const next = () => { if (step === 2) setShowErrors(true); if (canAdvance) setStep((s) => s + 1); };

  const publish = useMutation({
    mutationFn: async () => {
      const wallet = await getWallet().catch(() => null);
      // No expiry given: ConDex sets one (the backend uses the end of the day seven days out), and the thesis page says so.
      const expiresAt = draft.expiry ? new Date(draft.expiry).toISOString() : null;
      const effective = expiresAt ?? defaultExpiryIso();
      const tx = await registerInsight(wallet, { versionHash: selected!.version_hash, payoutAccount: accountId!, feeNear: Number(draft.fee), expiresAt: effective });
      return api.creators.publishExport({
        export_id: selected!.id, market: draft.market.trim(), horizon: horizonOf({ published_at: new Date().toISOString(), expires_at: effective }),
        direction: draft.direction as "long" | "short", entry: draft.entry.trim(), invalidation: draft.invalidation.trim(), target: draft.target.trim() || null,
        expires_at: expiresAt,
        fee: Number(draft.fee), payout_account: accountId!, register_tx_hash: tx.txHash,
      });
    },
    onSuccess: (r) => { setDone(r.insight); setDirty(false); qc.invalidateQueries({ queryKey: ["my-insights"] }); },
  });
  const err = publish.isError ? friendlyError(toApiError(publish.error)) : null;

  if (done) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 rounded-md border border-accent/50 bg-surface p-8" role="status">
        <p className="label-caps text-accent">Registered on NEAR testnet</p>
        <h2 className="text-2xl font-semibold">{done.market} · v{done.version} is live</h2>
        <p className="label-caps">Version hash</p>
        <div className="flex flex-wrap items-center gap-3"><code className="break-all font-mono text-xs">{done.version_hash}</code><CopyButton value={done.version_hash} /></div>
        <p className="text-sm text-muted">Keep your MCP server running so borrowers can retrieve it.</p>
        <Button asChild variant="primary"><Link href={`/gallery/${done.id}`}>View gallery entry</Link></Button>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <div className="min-w-0 space-y-6">
        <ol className="flex flex-wrap gap-2" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-2 rounded-md border px-3 py-1.5 font-mono text-xs uppercase tracking-wider", i === step ? "border-accent text-text" : "border-border text-muted")}>
              {i < step ? <Check className="h-3.5 w-3.5 text-accent" aria-hidden /> : <span>{i + 1}</span>}{s}
            </li>
          ))}
        </ol>
        {from && <p className="rounded-md border border-border p-3 text-sm text-muted">New version of <span className="font-mono">{from}</span>. Export the updated context, then pick it.</p>}

        {step === 0 && <CreatorSetup />}

        {step === 1 && (
          <section className="space-y-4" aria-label="Pick your export">
            <p className="flex items-start gap-2 text-sm text-muted"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />Exports from your Claude Code. Only a hash and details are shown; the text stays on your machine.</p>
            {exportsQ.isError ? <ErrorState error={exportsQ.error} onRetry={() => exportsQ.refetch()} />
              : exportsQ.isLoading ? <Skeleton className="h-32" />
              : exportsQ.data!.length === 0 ? (
                <div className="space-y-4 rounded-md border border-dashed border-border p-6">
                  <p className="font-medium">No exports yet</p>
                  <p className="text-sm text-muted">In Claude Code, say:</p>
                  <CodeBlock title="say this in claude code" code={EXPORT_PROMPT} />
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" onClick={() => exportsQ.refetch()}>Check again</Button>
                    {api.creators.simulateExport && <Button variant="secondary" loading={simulate.isPending} onClick={() => simulate.mutate()}>Simulate export (demo)</Button>}
                  </div>
                </div>
              ) : (
                <fieldset className="space-y-3">
                  <legend className="sr-only">Exports</legend>
                  {exportsQ.data!.map((e) => (
                    <label key={e.id} className={cn("flex cursor-pointer items-start gap-3 rounded-md border p-4", draft.exportId === e.id ? "border-accent/70 bg-surface" : "border-border")}>
                      <input type="radio" name="export" checked={draft.exportId === e.id} onChange={() => pick(e.id)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                      <span className="space-y-1 text-sm">
                        <span className="block font-mono font-medium">{e.suggested_market} · {e.suggested_horizon}</span>
                        <span className="block text-muted">{e.message_count} messages · exported {formatDate(e.exported_at)}{e.suggested_expires_at ? ` · expires ${formatDate(e.suggested_expires_at)}` : ""}</span>
                        {e.includes_pnl && <span className="block text-muted">Includes your PNL (private).</span>}
                        <span className="block font-mono text-[11px] text-muted">hash {e.version_hash.slice(0, 18)}…</span>
                      </span>
                    </label>
                  ))}
                  <Button variant="ghost" size="sm" onClick={() => exportsQ.refetch()}>Refresh</Button>
                </fieldset>
              )}
          </section>
        )}

        {step === 2 && (
          <div className="grid gap-5 md:grid-cols-2">
            <Field label="Market" htmlFor="market" help="Public." error={showErrors ? errors.market : undefined}>
              <Input id="market" placeholder="e.g. ETH-USD" value={draft.market} onChange={(e) => set({ market: e.target.value })} aria-invalid={showErrors && !!errors.market} />
            </Field>
            <Field label="Direction" htmlFor="direction" help="Public. A long opens with a buy, a short with a sell." error={showErrors ? errors.direction : undefined}>
              <select id="direction" value={draft.direction} onChange={(e) => set({ direction: e.target.value as Draft["direction"] })} aria-invalid={showErrors && !!errors.direction} className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm aria-[invalid=true]:border-danger">
                <option value="">Choose…</option><option value="long">Long</option><option value="short">Short</option>
              </select>
            </Field>
            <div className="md:col-span-2">
              <Field label="Entry" htmlFor="entry" help="When to enter, in your own words. Kept with the thesis." error={showErrors ? errors.entry : undefined}>
                <Textarea id="entry" className="min-h-20" placeholder="e.g. A 15-minute candle closes back below yesterday's UTC high." value={draft.entry} onChange={(e) => set({ entry: e.target.value })} aria-invalid={showErrors && !!errors.entry} />
              </Field>
            </div>
            <div className="md:col-span-2">
              <Field label="Invalidation" htmlFor="invalidation" help="What would prove the idea wrong." error={showErrors ? errors.invalidation : undefined}>
                <Textarea id="invalidation" className="min-h-20" placeholder="e.g. A 1-hour close above the sweep high." value={draft.invalidation} onChange={(e) => set({ invalidation: e.target.value })} aria-invalid={showErrors && !!errors.invalidation} />
              </Field>
            </div>
            <Field label="Target (optional)" htmlFor="target" error={showErrors ? errors.target : undefined}>
              <Input id="target" placeholder="e.g. Yesterday's UTC low" value={draft.target} onChange={(e) => set({ target: e.target.value })} aria-invalid={showErrors && !!errors.target} />
            </Field>
            <Field label="Fee (NEAR)" htmlFor="fee" help="Paid once, when a linked order first fills." error={showErrors ? errors.fee : undefined}>
              <Input id="fee" inputMode="decimal" placeholder="e.g. 0.5" value={draft.fee} onChange={(e) => set({ fee: e.target.value })} aria-invalid={showErrors && !!errors.fee} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Expiry (optional, your local time)" htmlFor="expiry" help="Leave it empty and ConDex sets one and tells you why." error={showErrors ? errors.expiry : undefined}>
                <Input id="expiry" type="datetime-local" value={draft.expiry} onChange={(e) => set({ expiry: e.target.value })} aria-invalid={showErrors && !!errors.expiry} />
              </Field>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-5">
            <dl className="divide-y divide-border rounded-md border border-border bg-surface text-sm">
              {([["Market", draft.market], ["Direction", draft.direction], ["Entry", draft.entry], ["Invalidation", draft.invalidation], ...(draft.target ? [["Target", draft.target]] : []), ["Fee", formatNear(Number(draft.fee))], ["Expiry", draft.expiry ? draft.expiry.replace("T", " ") : "ConDex sets it"], ["Version hash", selected?.version_hash ?? ""], ["Payout account", accountId ?? "Connect your wallet"]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-4 py-3"><dt className="text-muted">{k}</dt><dd className="break-all text-right font-mono">{v}</dd></div>
              ))}
            </dl>
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" checked={draft.confirmed} onChange={(e) => set({ confirmed: e.target.checked })} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
              The context stays on my machine and has no names, account numbers or wallet details.
            </label>
            <p className="text-xs text-muted">Signs a NEAR <strong>testnet</strong> transaction (gas only). Trade reports are self-reported. {DISCLAIMER}</p>
            {err && <div role="alert" className="rounded-md border border-danger/50 p-3 text-sm"><p className="text-danger">{err.title}</p><p className="text-muted">{err.next}</p></div>}
            {accountId ? (
              <Button variant="primary" size="lg" loading={publish.isPending} disabled={!draft.confirmed} onClick={() => publish.mutate()}>Register on NEAR (testnet)</Button>
            ) : (
              <Button variant="primary" size="lg" loading={connecting} onClick={() => connect()}>Connect wallet to publish</Button>
            )}
          </div>
        )}

        <div className="flex justify-between border-t border-border pt-5">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</Button>
          {step < 3 && <Button variant="primary" onClick={next} disabled={step !== 2 && !canAdvance}>Continue</Button>}
        </div>
      </div>
      <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <PublicPreview draft={draft} creator={accountId} />
        <p className="text-xs text-muted">Only market, direction and price are public. Entry and invalidation stay with the thesis.</p>
      </div>
    </div>
  );
}
