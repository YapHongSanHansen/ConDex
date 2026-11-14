"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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


/** Waits for the thesis the agent publishes: any token of this creator newer than the moment this step opened. */
function Watch({ account, since, onAnother }: { account: string; since: number; onAnother: () => void }) {
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
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="primary"><Link href={`/gallery/${fresh.token_id}`}>View the thesis</Link></Button>
        <Button variant="ghost" onClick={onAnother}>Publish another</Button>
      </div>
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

/** What to say in a chat. Claude asks for anything that is missing, so the short version is enough. */
const QUICK_PROMPT = "Publish this conversation to ConDex as a thesis.";
const DETAILED_EXAMPLE = `Publish this conversation to ConDex, using the ConDex tool.
Market: ETH-USD. Direction: short.
Entry: A 15-minute candle closes back below yesterday's UTC high.
Invalidation: A 1-hour close above the sweep high.
Target: Yesterday's UTC low.
Expiry: in 3 days.
Fee: 0.1 NEAR per filled trade.
Ask me which messages to share, and share only those.`;

/** Optional: for people who would rather fill in boxes. It only writes the prompt, nothing is sent from here. */
function PromptForm({ from }: { from: string | null }) {
  const { accountId } = useWallet();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const errors = useMemo(() => validate(draft), [draft]);
  const valid = Object.keys(errors).length === 0;
  const advanced = !!(draft.target || draft.expiry || draft.evaluationDeadline);
  const err = (k: keyof typeof errors) => showErrors && errors[k] ? <p role="alert" className="text-xs text-danger">{errors[k]}</p> : null;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_280px]">
      <div className="min-w-0 space-y-6">
        <div className="space-y-2">
          <label htmlFor="market" className="block text-sm font-medium">Which market?</label>
          <Input id="market" list="markets" placeholder="For example ETH-USD" value={draft.market} onChange={(e) => set({ market: e.target.value })} aria-invalid={showErrors && !!errors.market} />
          <datalist id="markets">{COMMON_MARKETS.map((m) => <option key={m} value={m} />)}</datalist>
          {err("market")}
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Which way do you expect it to go?</legend>
          <div className="flex gap-2">
            <Choice active={draft.direction === "long"} onClick={() => set({ direction: "long" })}>Up: long</Choice>
            <Choice active={draft.direction === "short"} onClick={() => set({ direction: "short" })}>Down: short</Choice>
          </div>
          {err("direction")}
        </fieldset>
        <div className="space-y-2">
          <label htmlFor="entry" className="block text-sm font-medium">When would you get in?</label>
          <Textarea id="entry" className="min-h-20" placeholder="In your own words, for example: a 15-minute candle closes back below yesterday's high." value={draft.entry} onChange={(e) => set({ entry: e.target.value })} aria-invalid={showErrors && !!errors.entry} />
          {err("entry")}
        </div>
        <div className="space-y-2">
          <label htmlFor="invalidation" className="block text-sm font-medium">What would prove you wrong?</label>
          <Textarea id="invalidation" className="min-h-20" placeholder="For example: a 1-hour close above the sweep high." value={draft.invalidation} onChange={(e) => set({ invalidation: e.target.value })} aria-invalid={showErrors && !!errors.invalidation} />
          {err("invalidation")}
        </div>
        <div className="space-y-2">
          <label htmlFor="fee" className="block text-sm font-medium">What should a trader pay you?</label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="fee" inputMode="decimal" className="w-28" placeholder="0.5" value={draft.fee} onChange={(e) => set({ fee: e.target.value })} aria-invalid={showErrors && !!errors.fee} />
            <span className="text-sm text-muted">NEAR, once, when a trade based on your thesis first fills</span>
          </div>
          <div className="flex gap-1.5">{FEES.map((f) => <button key={f} type="button" onClick={() => set({ fee: f })} className="cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:text-text">{f}</button>)}</div>
          {err("fee")}
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

        {valid ? (
          <div className="space-y-2">
            <p className="font-medium">Paste this into Claude Code</p>
            <CodeBlock title="say this in claude code" code={buildPrompt(draft, from)} />
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setShowErrors(true)}>Write the prompt</Button>
        )}
      </div>
      <div className="space-y-3 lg:sticky lg:top-24 lg:self-start">
        <PublicPreview draft={draft} creator={accountId} />
        <p className="text-xs text-muted">This is what everyone sees. The entry, the invalidation and your conversation are only for subscribers.</p>
      </div>
    </div>
  );
}

/** Where publishing happens. The whole job is one sentence to Claude Code, so that comes first and the form is optional. */
function PublishPanel({ from }: { from: string | null }) {
  const { accountId } = useWallet();
  // A thesis published after this moment is the one being waited for.
  const [since, setSince] = useState(0);
  useEffect(() => { queueMicrotask(() => setSince(Date.now() - 1000)); }, []);

  return (
    <div className="space-y-6">
      {from && <p className="rounded-md border border-border p-3 text-sm text-muted">This will be a new version of <span className="font-mono">{from}</span>. It gets its own token, and earlier versions keep working.</p>}

      <section className="space-y-4 rounded-md border border-border bg-surface p-6" aria-labelledby="say-it">
        <h2 id="say-it" className="text-lg font-semibold">Tell Claude Code to publish</h2>
        <p className="text-sm text-muted">Open a chat where you worked out your idea, and say:</p>
        <CodeBlock title="say this in claude code" code={from ? `Publish a new version of my ConDex thesis ${from}.` : QUICK_PROMPT} />
        <p className="text-sm text-muted">Claude asks for anything missing: the market, direction, entry, invalidation, expiry and fee. It also asks which messages to share, and only those leave your computer.</p>
        <details className="rounded-md border border-border p-3 text-sm">
          <summary className="cursor-pointer text-muted hover:text-text">Want to say it all in one go? See an example</summary>
          <div className="mt-3"><CodeBlock title="example" code={DETAILED_EXAMPLE} /></div>
        </details>
        <div className="border-t border-border pt-4">
          {accountId && since > 0 ? <Watch account={accountId} since={since} onAnother={() => setSince(Date.now() - 1000)} /> : null}
        </div>
      </section>

      <details className="rounded-md border border-border bg-surface p-5">
        <summary className="cursor-pointer font-semibold">Prefer filling in boxes? Get a ready-made prompt</summary>
        <div className="mt-6"><PromptForm from={from} /></div>
      </details>
      <p className="text-xs text-muted">Testnet only. {DISCLAIMER}</p>
    </div>
  );
}

export function PublishFlow() {
  const from = useSearchParams().get("from");
  const [connected, setConnected] = useState(false);
  const [skipped, setSkipped] = useState(false);

  if (connected || skipped) {
    return (
      <div className="space-y-6">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {connected
            ? <span className="flex items-center gap-1.5 text-accent"><Check className="h-4 w-4" aria-hidden />Claude Code is connected</span>
            : <span className="text-muted">Claude Code is not connected yet.</span>}
          <Link href="/keys?tab=keys" className="text-muted underline-offset-2 hover:text-text hover:underline">{connected ? "Connection settings" : "Connect it"}</Link>
        </p>
        <PublishPanel from={from} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ConnectClaude onConnected={() => setConnected(true)} />
      <p className="text-sm text-muted">
        Already set up, or just want the words to say?{" "}
        <button type="button" onClick={() => setSkipped(true)} className="cursor-pointer text-text underline underline-offset-2">Skip this</button>
      </p>
    </div>
  );
}
