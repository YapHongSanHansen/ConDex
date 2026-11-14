"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, Input, Textarea } from "@/components/ui/input";
import { CreatorSetup } from "@/components/keys/creator-setup";
import { DISCLAIMER } from "@/components/layout/page-header";
import { useWallet } from "@/lib/near/connector";
import { cn, formatDate } from "@/lib/utils";
import { PublicPreview } from "./preview";
import { buildPrompt, EMPTY_DRAFT, validate, type Draft } from "./types";

const STEPS = ["Connect", "Define", "Publish"];

/** Waits for the thesis the agent publishes: any token of this creator newer than the moment this step opened. */
function Watch({ account, since }: { account: string; since: number }) {
  const q = useQuery({ queryKey: ["profile", account], queryFn: () => api.creators.profile(account), refetchInterval: 3000, retry: false });
  const fresh = q.data?.tokens.filter((t) => new Date(t.published_at).getTime() >= since).sort((a, b) => b.published_at.localeCompare(a.published_at))[0];
  if (!fresh) {
    return <p role="status" className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Waiting for your agent to publish it…</p>;
  }
  return (
    <div className="space-y-3 rounded-md border border-accent/50 bg-surface p-5" role="status">
      <p className="label-caps text-accent">Published</p>
      <h3 className="text-xl font-semibold">{fresh.market} · v{fresh.version} is live</h3>
      <p className="text-sm text-muted">Expires {formatDate(fresh.expires_at)}{fresh.expiry.set_by !== "creator" ? ` (set by ${fresh.expiry.set_by === "condex_ai" ? "ConDex's AI" : "ConDex"}${fresh.expiry.reason ? `: ${fresh.expiry.reason}` : ""})` : ""} · judged on prices up to {formatDate(fresh.expiry.evaluation_deadline)}.</p>
      <p className="font-mono text-xs text-muted">{fresh.token_id} · fingerprint {fresh.content_hash.slice(0, 18)}…</p>
      <Button asChild variant="primary"><Link href={`/gallery/${fresh.token_id}`}>View the thesis</Link></Button>
    </div>
  );
}

export function PublishFlow() {
  const from = useSearchParams().get("from");
  const { accountId, signedIn } = useWallet();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  // The moment the creator reached the last step. A thesis published after it is the one being waited for.
  const [startedAt, setStartedAt] = useState(0);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const errors = useMemo(() => validate(draft), [draft]);
  const defineOk = Object.keys(errors).length === 0;
  const canAdvance = step === 0 ? signedIn : step === 1 ? defineOk : false;
  const next = () => {
    if (step === 1) setShowErrors(true);
    if (!canAdvance) return;
    if (step === 1) setStartedAt(Date.now() - 1000);
    setStep((s) => s + 1);
  };

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
        {from && <p className="rounded-md border border-border p-3 text-sm text-muted">New version of <span className="font-mono">{from}</span>. A new version gets its own token, and earlier ones keep working.</p>}

        {step === 0 && <CreatorSetup />}

        {step === 1 && (
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
              <Field label="Entry" htmlFor="entry" help="When to enter, in your own words. Kept private, with the conversation." error={showErrors ? errors.entry : undefined}>
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
            <Field label="Expiry (optional, your local time)" htmlFor="expiry" help="The last moment a trade can be linked. Leave it empty and ConDex sets one and tells you why." error={showErrors ? errors.expiry : undefined}>
              <Input id="expiry" type="datetime-local" value={draft.expiry} onChange={(e) => set({ expiry: e.target.value })} aria-invalid={showErrors && !!errors.expiry} />
            </Field>
            <Field label="Evaluation deadline (optional)" htmlFor="eval" help="Prices up to this day judge the thesis. Up to 30 days after the expiry. Empty means the expiry." error={showErrors ? errors.evaluationDeadline : undefined}>
              <Input id="eval" type="date" value={draft.evaluationDeadline} onChange={(e) => set({ evaluationDeadline: e.target.value })} aria-invalid={showErrors && !!errors.evaluationDeadline} />
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <p className="text-sm text-muted">Your conversation is on your side, so your agent publishes it. Paste this into Claude Code, with the ConDex MCP tool connected using a key that has Publish access. Only the messages you approve are shared.</p>
            <CodeBlock title="say this in claude code" code={buildPrompt(draft, from)} />
            {accountId ? <Watch account={accountId} since={startedAt} /> : null}
            <p className="text-xs text-muted">Testnet only. {DISCLAIMER}</p>
          </div>
        )}

        <div className="flex justify-between border-t border-border pt-5">
          <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}>Back</Button>
          {step < 2 && <Button variant="primary" onClick={next} disabled={step === 0 && !canAdvance}>Continue</Button>}
        </div>
      </div>
      <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <PublicPreview draft={draft} creator={accountId} />
        <p className="text-xs text-muted">Only the market, direction, expiry, fee and your record are public. Entry, invalidation and the conversation need a subscription.</p>
      </div>
    </div>
  );
}
