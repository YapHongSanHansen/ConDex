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
import { ConnectClaude } from "@/components/connect/connect-claude";
import { DISCLAIMER } from "@/components/layout/page-header";
import { useWallet } from "@/lib/near/connector";
import { cn, formatDate } from "@/lib/utils";
import { PublicPreview } from "./preview";
import { buildPrompt, EMPTY_DRAFT, validate, type Draft } from "./types";

const STEPS = ["Connect Claude Code", "Describe your thesis", "Publish"];

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

const COMMON_MARKETS = ["ETH-USD", "BTC-USD", "SOL-USD", "NEAR-USD"];
const FEES = ["0.1", "0.5", "1"];

function Choice({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn("h-11 flex-1 cursor-pointer rounded-md border px-4 text-sm font-medium transition-colors", active ? "border-accent bg-accent/10 text-text" : "border-border text-muted hover:text-text")}>
      {children}
    </button>
  );
}

export function PublishFlow() {
  const from = useSearchParams().get("from");
  const { accountId } = useWallet();
  const [step, setStep] = useState(0);
  const [connected, setConnected] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  // The moment the creator reached the last step. A thesis published after it is the one being waited for.
  const [startedAt, setStartedAt] = useState(0);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const errors = useMemo(() => validate(draft), [draft]);
  const next = () => {
    if (step === 1) {
      setShowErrors(true);
      if (Object.keys(errors).length > 0) return;
      setStartedAt(Date.now() - 1000);
    }
    setStep((s) => s + 1);
  };
  const advanced = !!(draft.target || draft.expiry || draft.evaluationDeadline);

  return (
    <div className={cn("grid gap-8", step > 0 && "lg:grid-cols-[1fr_320px]")}>
      <div className="min-w-0 space-y-6">
        <ol className="flex flex-wrap gap-2" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={cn("flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm", i === step ? "border-accent text-text" : "border-border text-muted")}>
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-full font-mono text-[11px]", i < step ? "bg-accent text-accent-fg" : "border border-current")}>{i < step ? <Check className="h-3 w-3" aria-hidden /> : i + 1}</span>{s}
            </li>
          ))}
        </ol>
        {from && <p className="rounded-md border border-border p-3 text-sm text-muted">This will be a new version of <span className="font-mono">{from}</span>. It gets its own token, and earlier versions keep working.</p>}

        {step === 0 && (
          <ConnectClaude
            onConnected={() => setConnected(true)}
            after={<Button variant="primary" onClick={() => setStep(1)}>Continue</Button>}
          />
        )}

        {step === 1 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="market" className="block text-sm font-medium">Which market?</label>
              <Input id="market" list="markets" placeholder="For example ETH-USD" value={draft.market} onChange={(e) => set({ market: e.target.value })} aria-invalid={showErrors && !!errors.market} />
              <datalist id="markets">{COMMON_MARKETS.map((m) => <option key={m} value={m} />)}</datalist>
              {showErrors && errors.market && <p role="alert" className="text-xs text-danger">{errors.market}</p>}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Which way do you expect it to go?</legend>
              <div className="flex gap-2">
                <Choice active={draft.direction === "long"} onClick={() => set({ direction: "long" })}>Up: long</Choice>
                <Choice active={draft.direction === "short"} onClick={() => set({ direction: "short" })}>Down: short</Choice>
              </div>
              {showErrors && errors.direction && <p role="alert" className="text-xs text-danger">{errors.direction}</p>}
            </fieldset>

            <div className="space-y-2">
              <label htmlFor="entry" className="block text-sm font-medium">When would you get in?</label>
              <Textarea id="entry" className="min-h-20" placeholder="In your own words, for example: a 15-minute candle closes back below yesterday's high." value={draft.entry} onChange={(e) => set({ entry: e.target.value })} aria-invalid={showErrors && !!errors.entry} />
              {showErrors && errors.entry && <p role="alert" className="text-xs text-danger">{errors.entry}</p>}
            </div>

            <div className="space-y-2">
              <label htmlFor="invalidation" className="block text-sm font-medium">What would prove you wrong?</label>
              <Textarea id="invalidation" className="min-h-20" placeholder="For example: a 1-hour close above the sweep high." value={draft.invalidation} onChange={(e) => set({ invalidation: e.target.value })} aria-invalid={showErrors && !!errors.invalidation} />
              {showErrors && errors.invalidation && <p role="alert" className="text-xs text-danger">{errors.invalidation}</p>}
            </div>

            <div className="space-y-2">
              <label htmlFor="fee" className="block text-sm font-medium">What should a trader pay you?</label>
              <div className="flex flex-wrap items-center gap-2">
                <Input id="fee" inputMode="decimal" className="w-28" placeholder="0.5" value={draft.fee} onChange={(e) => set({ fee: e.target.value })} aria-invalid={showErrors && !!errors.fee} />
                <span className="text-sm text-muted">NEAR, once, when a trade based on your thesis first fills</span>
              </div>
              <div className="flex gap-1.5">{FEES.map((f) => <button key={f} type="button" onClick={() => set({ fee: f })} className="cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:text-text">{f}</button>)}</div>
              {showErrors && errors.fee && <p role="alert" className="text-xs text-danger">{errors.fee}</p>}
            </div>

            <details open={advanced} className="rounded-md border border-border p-4">
              <summary className="cursor-pointer text-sm font-medium">More options <span className="font-normal text-muted">(all optional)</span></summary>
              <div className="mt-4 grid gap-5 md:grid-cols-2">
                <Field label="Target" htmlFor="target" help="Where you would take profit." error={showErrors ? errors.target : undefined}>
                  <Input id="target" placeholder="For example: yesterday's low" value={draft.target} onChange={(e) => set({ target: e.target.value })} />
                </Field>
                <Field label="Expires" htmlFor="expiry" help="After this, no new trade can link to it. Leave it empty and ConDex picks a time and tells you why." error={showErrors ? errors.expiry : undefined}>
                  <Input id="expiry" type="datetime-local" value={draft.expiry} onChange={(e) => set({ expiry: e.target.value })} />
                </Field>
                <Field label="Judge it up to" htmlFor="eval" help="Prices up to this day decide whether you were right. Up to 30 days after it expires. Empty: judged when it expires." error={showErrors ? errors.evaluationDeadline : undefined}>
                  <Input id="eval" type="date" value={draft.evaluationDeadline} onChange={(e) => set({ evaluationDeadline: e.target.value })} />
                </Field>
              </div>
            </details>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <ol className="space-y-5">
              <li className="space-y-2">
                <p className="font-medium">1. Open Claude Code and paste this</p>
                <CodeBlock title="say this in claude code" code={buildPrompt(draft, from)} />
              </li>
              <li className="space-y-2">
                <p className="font-medium">2. Tell Claude which messages to share</p>
                <p className="text-sm text-muted">Claude will ask. Share only what you want readers to see. The rest stays on your computer.</p>
              </li>
              <li className="space-y-2">
                <p className="font-medium">3. Wait here</p>
                {accountId ? <Watch account={accountId} since={startedAt} /> : null}
              </li>
            </ol>
            <p className="text-xs text-muted">Testnet only. {DISCLAIMER}</p>
          </div>
        )}

        {step > 0 && (
          <div className="flex items-center justify-between border-t border-border pt-5">
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>Back</Button>
            {step === 1 && <Button variant="primary" size="lg" onClick={next}>Continue</Button>}
          </div>
        )}
        {step === 0 && connected && <p className="sr-only" role="status">Claude Code is connected.</p>}
      </div>
      {step > 0 && (
        <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
          <PublicPreview draft={draft} creator={accountId} />
          <p className="text-xs text-muted">This is what everyone sees. The entry, the invalidation and your conversation are only for subscribers.</p>
        </div>
      )}
    </div>
  );
}
